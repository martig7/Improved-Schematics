// Octilinear renderer + reusable ribbon renderer. The ribbon core
// (renderRibbons) takes pre-projected node pixels and is also used by the
// smoothed renderer; renderOctilinear is the grid-cell variant the schematic
// mode uses (ported from dev/reference/renderSvg.js + gridToPx.js).

import type { Layout, Cell, Pixel, StopMark } from './layout/types';
import type { WaterCollection } from './types';
import { CELL_PX, PAD, LINE_WIDTH, LINE_GAP } from './constants';
import { DARK_THEME, DEFAULT_THEME } from './types';
import { offsetPolyline } from './layout/offsets';
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

  const stopsByNode = new Map<string, StopMark[]>();
  const stopSeen = new Set<string>();
  const segments: Segment[] = [];
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const lineById = new Map<string, { id: string; color: string }>();
  for (const e of layout.edges) for (const l of e.lines) if (!lineById.has(l.id)) lineById.set(l.id, l);

  // --- per-edge bundle drawing (LOOM transitmap model) -----------------------
  // Each edge draws its own bundle from its own lineOrder: slots are distinct
  // within one edge by construction, and imageMerge guarantees two distinct
  // edges never share drawn geometry — so same-coordinate overdraw (one line
  // invisible under another) is structurally impossible. The previous model
  // offset whole traversal runs by a global per-line constant, which flips
  // sides on winding runs and collided opposite-direction corridor sharers.
  // Retraced corridors are also free: an edge draws once per line no matter
  // how often the traversal passes over it.
  const spacing = LINE_WIDTH + LINE_GAP;
  const segPath = new Map<string, Pixel[]>(); // edge.id|lineId -> offset polyline
  const dByLine = new Map<string, string[]>();
  const pushSeg = (lineId: string, poly: Pixel[]) => {
    let d = dByLine.get(lineId);
    if (!d) dByLine.set(lineId, (d = []));
    d.push('M' + poly[0][0].toFixed(1) + ',' + poly[0][1].toFixed(1));
    for (let k = 1; k < poly.length; k++) {
      segments.push({ p1: poly[k - 1], p2: poly[k] });
      d.push('L' + poly[k][0].toFixed(1) + ',' + poly[k][1].toFixed(1));
    }
  };

  // A line draws on an edge only if its traversal actually uses that edge —
  // edge.lineIds alone over-draws: merge walks and anchor splits leave line
  // ids painted on corridor remnants no service runs over (bare tails past a
  // terminus, stub "fingers" at hubs). Lines with NO traversal at all fall
  // back to drawing every edge that carries them (existence beats tails).
  const usesEdge = new Map<string, Set<string>>(); // lineId -> edgeIds
  for (const [lineId, traversal] of layout.lineTraversals) {
    const s = new Set<string>();
    for (const step of traversal) s.add(step.edgeId);
    if (s.size > 0) usesEdge.set(lineId, s);
  }
  const drawsOn = (lineId: string, edgeId: string): boolean => {
    const s = usesEdge.get(lineId);
    return s ? s.has(edgeId) : true;
  };

  for (const edge of layout.edges) {
    const base = edgePolyline(edge);
    if (base.length < 2) continue;
    const order = (edge.lineOrder.length > 0 ? edge.lineOrder : edge.lines.map((l) => l.id)).filter(
      (lineId) => lineById.has(lineId) && drawsOn(lineId, edge.id),
    );
    const center = (order.length - 1) / 2;
    for (let i = 0; i < order.length; i++) {
      const lineId = order[i];
      const o = (i - center) * spacing;
      const poly =
        o === 0 ? base.map((p) => p.slice() as Pixel) : offsetPolyline(base, o, /*simplify*/ false);
      segPath.set(edge.id + '|' + lineId, poly);
      pushSeg(lineId, poly);
    }
  }

  /** A line's drawn endpoint at a node (offset polylines run from→to). */
  const lineEndAt = (edgeId: string, lineId: string, nodeId: string): Pixel | null => {
    const poly = segPath.get(edgeId + '|' + lineId);
    const edge = edgeById.get(edgeId);
    if (!poly || !edge) return null;
    if (edge.from === nodeId) return poly[0];
    if (edge.to === nodeId) return poly[poly.length - 1];
    return null;
  };

  // Stops come straight from edge.stops — no traversal dependency, so lines
  // whose traversal reconstruction failed still get their station marks. The
  // POSITION resolves from any DRAWN edge of the line at that node: the flag
  // itself may sit on a filtered-out remnant edge (tail past a terminus).
  const drawnEndAt = new Map<string, Pixel>(); // nodeId|lineId -> ribbon endpoint
  for (const edge of layout.edges) {
    for (const l of edge.lines) {
      for (const nodeId of [edge.from, edge.to]) {
        const key = nodeId + '|' + l.id;
        if (drawnEndAt.has(key)) continue;
        const p = lineEndAt(edge.id, l.id, nodeId);
        if (p) drawnEndAt.set(key, p);
      }
    }
  }
  const addStop = (lineId: string, color: string, nodeId: string, pos: Pixel) => {
    const key = nodeId + '|' + lineId;
    if (stopSeen.has(key)) return;
    stopSeen.add(key);
    if (!stopsByNode.has(nodeId)) stopsByNode.set(nodeId, []);
    stopsByNode.get(nodeId)!.push({ lineId, color, pos });
  };
  for (const edge of layout.edges) {
    for (const [lineId, stop] of edge.stops) {
      const line = lineById.get(lineId);
      if (!line) continue;
      if (stop.atFrom) {
        const p = drawnEndAt.get(edge.from + '|' + lineId);
        if (p) addStop(lineId, line.color, edge.from, p);
      }
      if (stop.atTo) {
        const p = drawnEndAt.get(edge.to + '|' + lineId);
        if (p) addStop(lineId, line.color, edge.to, p);
      }
    }
  }

  // Node connectors: where a line continues across a node between two edges
  // whose lane slots differ, bridge the lateral jog so the line reads as
  // continuous. Driven by traversals (the line's actual edge sequence).
  const connSeen = new Set<string>();
  for (const [lineId, traversal] of layout.lineTraversals) {
    if (!lineById.has(lineId)) continue;
    for (let i = 1; i < traversal.length; i++) {
      const a = traversal[i - 1];
      const b = traversal[i];
      const ea = edgeById.get(a.edgeId);
      const eb = edgeById.get(b.edgeId);
      if (!ea || !eb) continue;
      const endA = a.reversed ? ea.from : ea.to;
      const startB = b.reversed ? eb.to : eb.from;
      if (endA !== startB) continue; // discontinuity — nothing to bridge
      const pairKey = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
      const key = lineId + '|' + endA + '|' + pairKey;
      if (connSeen.has(key)) continue;
      connSeen.add(key);
      const pa = lineEndAt(a.edgeId, lineId, endA);
      const pb = lineEndAt(b.edgeId, lineId, endA);
      if (!pa || !pb) continue;
      const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      if (gap < 0.5 || gap > spacing * 8) continue; // coincident, or not a lane jog
      let d = dByLine.get(lineId);
      if (!d) dByLine.set(lineId, (d = []));
      d.push('M' + pa[0].toFixed(1) + ',' + pa[1].toFixed(1));
      d.push('L' + pb[0].toFixed(1) + ',' + pb[1].toFixed(1));
      segments.push({ p1: pa, p2: pb });
    }
  }

  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
  ) {
    console.error(
      `[ribbons] per-edge: ${segPath.size} segments across ${layout.edges.length} edges, ` +
      `${connSeen.size} connector candidates, ${dByLine.size} lines`,
    );
  }

  const casingParts: string[] = [];
  const strokeParts: string[] = [];

  for (const [lineId, line] of lineById) {
    const d = dByLine.get(lineId);
    if (!d || d.length < 2) continue;
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
