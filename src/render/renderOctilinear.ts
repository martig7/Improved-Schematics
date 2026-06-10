// Octilinear renderer + reusable ribbon renderer. The ribbon core
// (renderRibbons) takes pre-projected node pixels and is also used by the
// smoothed renderer; renderOctilinear is the grid-cell variant the schematic
// mode uses (ported from dev/reference/renderSvg.js + gridToPx.js).

import type { Layout, Cell, Pixel, StopMark } from './layout/types';
import type { WaterCollection } from './types';
import { CELL_PX, PAD, LINE_WIDTH } from './constants';
import { DARK_THEME, DEFAULT_THEME } from './types';
import { computeCanonicalOffsets, offsetPolyline } from './layout/offsets';
import { renderStops } from './stops';
import { placeLabels, renderLabel, type Segment } from './labels';
import { escapeXml } from './escape';
import type { TransferPair } from './transfers';
import { renderTransferConnectors, edgeKeysFromGraph } from './transfers';

export interface OctiOptions {
  dark?: boolean;
  showLabels?: boolean;
  water?: WaterCollection;
  transfers?: TransferPair[];
}

function gridToPx(cell: Cell, maxRow: number): Pixel {
  return [cell[0] * CELL_PX + PAD, (maxRow - cell[1]) * CELL_PX + PAD];
}

/** Map water polygons into the schematic's pixel frame via a bbox affine. */
function waterBackdrop(layout: Layout, nodePx: Map<string, Pixel>, water: WaterCollection, dark: boolean): string {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes.values()) {
    const [lng, lat] = n.lngLat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    const px = nodePx.get(n.id)!;
    if (px[0] < minX) minX = px[0];
    if (px[0] > maxX) maxX = px[0];
    if (px[1] < minY) minY = px[1];
    if (px[1] > maxY) maxY = px[1];
  }
  const gw = maxLng - minLng || 1e-9;
  const gh = maxLat - minLat || 1e-9;
  const pw = maxX - minX || 1;
  const ph = maxY - minY || 1;
  const map = ([lng, lat]: [number, number]): Pixel => [
    minX + ((lng - minLng) / gw) * pw,
    minY + ((maxLat - lat) / gh) * ph,
  ];

  let paths = '';
  for (const f of water.features) {
    if (f.geometry.type !== 'Polygon') continue;
    let d = '';
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = map(c as [number, number]);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      });
      d += 'Z ';
    }
    if (d) paths += '<path d="' + d.trim() + '"/>';
  }
  if (!paths) return '';
  const fill = dark ? DARK_THEME.water : DEFAULT_THEME.water;
  return '<g class="water" fill="' + fill + '" fill-rule="evenodd" stroke="none">' + paths + '</g>';
}

/**
 * Core ribbon renderer: bundles parallel co-running lines, draws stops as
 * pills, and places labels. Operates in caller-chosen pixel space — both
 * grid-octilinear (renderOctilinear) and smoothed-graph (renderSmoothedRibbons)
 * use this.
 *
 * Stops are placed at offset-path endpoints along the full service traversal
 * (topo support nodes). Line geometry may deduplicate revisited corridors so
 * round-trip patterns draw a single centerline like geographic mode.
 */
export interface RenderRibbonsArgs {
  layout: Layout;
  nodePx: Map<string, Pixel>;
  edgePolyline: (edge: Layout['edges'][number]) => Pixel[];
  width: number;
  height: number;
  dark: boolean;
  showLabels: boolean;
  water?: WaterCollection;
  transfers?: TransferPair[];
  /** Ids of routing-only ghost nodes. Renderer MUST NOT draw markers or
   *  labels for these — the ghost is invisible by design (lines pass through
   *  it but no circle is drawn). */
  ghostNodeIds?: Set<string>;
  /** Optional pre-rendered SVG snippet (a single `<g>...</g>`) drawn between
   *  the water layer and the route ribbons. Used to overlay the Hanan grid
   *  for diagnostic purposes (showGrid option). */
  gridOverlay?: string;
}

export function renderRibbons(args: RenderRibbonsArgs): string {
  const { layout, nodePx, edgePolyline, width, height, dark, showLabels } = args;
  const bg = dark ? DARK_THEME.land : '#ffffff';
  const casingWidth = LINE_WIDTH + 3;
  const offsets = computeCanonicalOffsets(layout);

  const stopsByNode = new Map<string, StopMark[]>();
  const stopSeen = new Set<string>();
  const segments: Segment[] = [];
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const lineById = new Map<string, { id: string; color: string }>();
  for (const e of layout.edges) for (const l of e.lines) if (!lineById.has(l.id)) lineById.set(l.id, l);

  // Offsets are applied along the travel-relative perpendicular, so the same
  // numeric offset lands on OPPOSITE geometric sides for opposite travel
  // directions. Two lines sharing a corridor in opposing directions with
  // mirrored slots would then draw exactly coincident — one invisible under
  // the other. Normalize the sign to a direction-independent frame: flip
  // whenever the polyline's dominant direction is anti-canonical.
  const dirSign = (pts: Pixel[]): number => {
    if (pts.length < 2) return 1;
    const dx = pts[pts.length - 1][0] - pts[0][0];
    const dy = pts[pts.length - 1][1] - pts[0][1];
    const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    return d < 0 ? -1 : 1;
  };

  const offsetCache = new Map<string, Pixel[]>();
  const offsetPath = (edge: Layout['edges'][number], lineId: string): Pixel[] => {
    const key = edge.id + '|' + lineId;
    const cached = offsetCache.get(key);
    if (cached) return cached;
    const off = offsets.get(lineId) ?? 0;
    const px = edgePolyline(edge);
    const o = off * dirSign(px);
    const result = o === 0 ? px : offsetPolyline(px, o);
    offsetCache.set(key, result);
    return result;
  };

  const casingParts: string[] = [];
  const strokeParts: string[] = [];

  for (const [lineId, traversal] of layout.lineTraversals) {
    const line = lineById.get(lineId);
    if (!line || traversal.length === 0) continue;

    const addStop = (nodeId: string, pos: Pixel) => {
      const key = nodeId + '|' + lineId;
      if (stopSeen.has(key)) return;
      stopSeen.add(key);
      if (!stopsByNode.has(nodeId)) stopsByNode.set(nodeId, []);
      stopsByNode.get(nodeId)!.push({ lineId, color: line.color, pos });
    };

    // Build centerline RUNS (unoffset polylines spanning topologically-
    // continuous stretches of the line's traversal) while tracking which
    // centerline vertex index corresponds to each support-node stop. After
    // we offset the run as a whole, we read each stop's pixel position from
    // the offset polyline AT THE SAME INDEX so the dot lands exactly on the
    // drawn ribbon. Previous code placed stops via the per-edge offset path
    // endpoints, which used single-segment perps at the endpoint; the whole-
    // run offset uses BISECTORS at mid-run vertices, so stops in the middle
    // of a run drifted off the line.
    interface Run {
      centerline: Pixel[];
      stops: Array<{ nodeId: string; idx: number }>;
    }
    const runs: Run[] = [];
    let curRun: Run = { centerline: [], stops: [] };
    let prevEndNode: string | null = null;
    const usedCorridor = new Set<string>();

    const appendEdgePath = (
      path: Pixel[],
      startNode: string,
      endNode: string,
      atFrom: boolean,
      atTo: boolean,
    ) => {
      if (path.length === 0) return;
      if (curRun.centerline.length === 0) {
        for (const p of path) curRun.centerline.push(p);
        if (atFrom) curRun.stops.push({ nodeId: startNode, idx: 0 });
        if (atTo) curRun.stops.push({ nodeId: endNode, idx: path.length - 1 });
        return;
      }
      const last = curRun.centerline[curRun.centerline.length - 1];
      const gapLen = Math.hypot(path[0][0] - last[0], path[0][1] - last[1]);
      if (
        gapLen > 8 &&
        typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
      ) {
        console.error(
          `[ribbons] append GAP ${gapLen.toFixed(0)}px at ${startNode} ` +
          `(${last.map((v) => v.toFixed(0))} -> ${path[0].map((v) => v.toFixed(0))})`,
        );
      }
      const skipFirst = gapLen < 0.5;
      // The shared vertex sits at the previous run's last index when we skip
      // the duplicate, or at curRun.centerline.length when we don't.
      const startVertexIdx = skipFirst ? curRun.centerline.length - 1 : curRun.centerline.length;
      const startIdx = skipFirst ? 1 : 0;
      for (let k = startIdx; k < path.length; k++) curRun.centerline.push(path[k]);
      if (atFrom) curRun.stops.push({ nodeId: startNode, idx: startVertexIdx });
      if (atTo) curRun.stops.push({ nodeId: endNode, idx: curRun.centerline.length - 1 });
    };
    const flushRun = () => {
      if (curRun.centerline.length >= 2) runs.push(curRun);
      curRun = { centerline: [], stops: [] };
    };

    for (let i = 0; i < traversal.length; i++) {
      const step = traversal[i];
      const edge = edgeById.get(step.edgeId);
      if (!edge) continue;
      const startNode = step.reversed ? edge.to : edge.from;
      const endNode = step.reversed ? edge.from : edge.to;
      const corridorKey = edge.from < edge.to ? edge.from + '|' + edge.to : edge.to + '|' + edge.from;
      const stop = edge.stops.get(lineId);
      const atFrom = stop ? (step.reversed ? stop.atTo : stop.atFrom) : false;
      const atTo = stop ? (step.reversed ? stop.atFrom : stop.atTo) : false;

      if (usedCorridor.has(corridorKey)) {
        // Revisited corridor: don't redraw the centerline, but if the line
        // stops at one of its endpoints on this pass, place that stop by
        // finding the matching vertex on a previously-drawn run.
        const placeOnExisting = (nodeId: string) => {
          const allRuns = runs.concat(curRun);
          for (const r of allRuns) {
            for (const s of r.stops) if (s.nodeId === nodeId) return; // already placed
          }
          const np = nodePx.get(nodeId);
          if (!np) return;
          for (const r of allRuns) {
            let bestIdx = -1;
            let bestD = 4; // px tolerance
            for (let k = 0; k < r.centerline.length; k++) {
              const d = Math.hypot(r.centerline[k][0] - np[0], r.centerline[k][1] - np[1]);
              if (d < bestD) { bestD = d; bestIdx = k; }
            }
            if (bestIdx >= 0) {
              r.stops.push({ nodeId, idx: bestIdx });
              return;
            }
          }
        };
        if (stop && atFrom) placeOnExisting(startNode);
        if (stop && atTo) placeOnExisting(endNode);
        // The revisited stretch is already drawn, but the pen is parked at the
        // PREVIOUS run's end while prevEndNode advances along the revisit — a
        // later new edge would look "continuous" by node id and get appended,
        // drawing a long chord across the map. Always start a fresh run.
        flushRun();
        prevEndNode = endNode;
        continue;
      }

      usedCorridor.add(corridorKey);
      const base = edgePolyline(edge);
      const path = step.reversed ? [...base].reverse() : base;

      if (i > 0 && prevEndNode !== startNode) flushRun();
      appendEdgePath(path, startNode, endNode, atFrom, atTo);
      prevEndNode = endNode;
    }
    flushRun();

    const off = offsets.get(lineId) ?? 0;
    const d: string[] = [];
    let prev: Pixel | null = null;
    const lineTo = (p: Pixel) => {
      if (prev) segments.push({ p1: prev, p2: p });
      d.push('L' + p[0].toFixed(1) + ',' + p[1].toFixed(1));
      prev = p;
    };
    const moveTo = (p: Pixel) => {
      d.push('M' + p[0].toFixed(1) + ',' + p[1].toFixed(1));
      prev = p;
    };

    for (const r of runs) {
      // Offset WITHOUT simplification so the ribbon indices correspond 1:1
      // with the centerline indices we registered stops against. Sign is
      // normalized per run (dirSign) so opposite-direction traversals of a
      // shared corridor keep their geometric side — see offsetPath above.
      const runOff = off * dirSign(r.centerline);
      const ribbon = runOff === 0 ? r.centerline : offsetPolyline(r.centerline, runOff, /*simplify*/ false);
      if (ribbon.length < 2) continue;
      moveTo(ribbon[0]);
      for (let k = 1; k < ribbon.length; k++) lineTo(ribbon[k]);
      for (const s of r.stops) {
        const idx = Math.max(0, Math.min(ribbon.length - 1, s.idx));
        addStop(s.nodeId, ribbon[idx]);
      }
    }

    if (
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
    ) {
      let missing = 0;
      let reused = 0;
      const seen = new Set<string>();
      for (const step of traversal) {
        const e = edgeById.get(step.edgeId);
        if (!e) { missing++; continue; }
        const k = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
        if (seen.has(k)) reused++;
        seen.add(k);
      }
      console.error(
        `[ribbons] line ${lineId.slice(0, 8)} steps=${traversal.length} missingEdges=${missing} ` +
        `corridorRevisits=${reused} runs=${runs.length} dCmds=${d.length}`,
      );
    }

    if (d.length < 2) continue;
    const dStr = d.join(' ');
    casingParts.push(
      '<path d="' + dStr + '" fill="none" stroke="' + bg + '" stroke-width="' + casingWidth +
        '" stroke-linecap="round" stroke-linejoin="round"/>',
    );
    strokeParts.push(
      '<path d="' + dStr + '" fill="none" stroke="' + escapeXml(line.color) + '" stroke-width="' +
        LINE_WIDTH + '" stroke-linecap="round" stroke-linejoin="round" data-line-id="' + escapeXml(line.id) + '"/>',
    );
  }
  const edgeParts: string[] = [...casingParts, ...strokeParts];

  if (args.ghostNodeIds) {
    for (const gid of args.ghostNodeIds) stopsByNode.delete(gid);
  }

  const stopParts = renderStops(stopsByNode, dark);
  const placements = showLabels ? placeLabels(layout, nodePx, stopsByNode, segments) : new Map();
  const labelParts: string[] = [];
  for (const n of layout.nodes.values()) {
    if (args.ghostNodeIds?.has(n.id)) continue;
    const placement = placements.get(n.id);
    const anchor = nodePx.get(n.id);
    if (!placement || !anchor) continue;
    labelParts.push(renderLabel(n, placement, anchor, stopsByNode.has(n.id), dark));
  }

  const waterPart = args.water ? waterBackdrop(layout, nodePx, args.water, dark) : '';

  let transferPart = '';
  if (args.transfers && args.transfers.length > 0) {
    const excludeKeys = edgeKeysFromGraph(layout.edges);
    const dotR = LINE_WIDTH * 0.7;
    const dotOf = (id: string): { center: Pixel; radius: number } | null => {
      const marks = stopsByNode.get(id);
      if (!marks || marks.length === 0) {
        const p = nodePx.get(id);
        return p ? { center: p, radius: dotR } : null;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const m of marks) {
        if (m.pos[0] < minX) minX = m.pos[0];
        if (m.pos[0] > maxX) maxX = m.pos[0];
        if (m.pos[1] < minY) minY = m.pos[1];
        if (m.pos[1] > maxY) maxY = m.pos[1];
      }
      const center: Pixel = [(minX + maxX) / 2, (minY + maxY) / 2];
      const radius = Math.hypot(maxX - minX, maxY - minY) / 2 + dotR;
      return { center, radius };
    };
    transferPart = renderTransferConnectors(
      args.transfers,
      (p) => {
        const a = dotOf(p.fromId);
        const b = dotOf(p.toId);
        if (!a || !b) return null;
        return { from: a.center, to: b.center, radius: Math.max(a.radius, b.radius) };
      },
      excludeKeys,
      { dark, strokeWidth: LINE_WIDTH * 0.35 },
    );
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width +
    '" height="' + height + '">\n<rect width="' + width + '" height="' + height + '" fill="' + bg + '"/>\n' +
    (waterPart ? waterPart + '\n' : '') +
    (args.gridOverlay ? args.gridOverlay + '\n' : '') +
    '<g class="edges">\n' + edgeParts.join('\n') + '\n</g>\n' +
    (transferPart ? transferPart + '\n' : '') +
    '<g class="stops">\n' + stopParts.join('\n') +
    '\n</g>\n<g class="stations">\n' + labelParts.join('\n') + '\n</g>\n</svg>'
  );
}

export function renderOctilinear(layout: Layout, opts: OctiOptions = {}): string {
  const showLabels = opts.showLabels !== false;
  const dark = opts.dark === true;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const grow = (c: Cell) => {
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  };
  for (const n of layout.nodes.values()) grow(n.cell);
  for (const e of layout.edges) for (const c of e.path) grow(c);
  if (!isFinite(minX)) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';

  const offX = -minX;
  const offY = -minY;
  const maxRow = maxY + offY;
  const toPx = (c: Cell): Pixel => gridToPx([c[0] + offX, c[1] + offY], maxRow);
  const width = (maxX - minX) * CELL_PX + PAD * 2;
  const height = (maxY - minY) * CELL_PX + PAD * 2;

  const nodePx = new Map<string, Pixel>();
  for (const n of layout.nodes.values()) nodePx.set(n.id, toPx(n.cell));

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map(toPx),
    width,
    height,
    dark,
    showLabels,
    water: opts.water,
    transfers: opts.transfers,
  });
}
