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
 * `edgePolyline(edge)` returns the edge's path already in pixel space (callers
 * pre-project from cells or graph-pixel positions). `nodePx` is the projected
 * position of each node; `width`/`height` are the SVG canvas dimensions.
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

  const offsetCache = new Map<string, Pixel[]>();
  const offsetPath = (edge: Layout['edges'][number], lineId: string): Pixel[] => {
    const key = edge.id + '|' + lineId;
    const cached = offsetCache.get(key);
    if (cached) return cached;
    const off = offsets.get(lineId) ?? 0;
    const px = edgePolyline(edge);
    const result = off === 0 ? px : offsetPolyline(px, off);
    offsetCache.set(key, result);
    return result;
  };

  const endDir = (path: Pixel[], reversed: boolean): [number, number] => {
    const a = reversed ? 0 : path.length - 1;
    const b = reversed ? 1 : path.length - 2;
    return [path[a][0] - path[b][0], path[a][1] - path[b][1]];
  };
  const startDir = (path: Pixel[], reversed: boolean): [number, number] => {
    const a = reversed ? path.length - 1 : 0;
    const b = reversed ? path.length - 2 : 1;
    return [path[b][0] - path[a][0], path[b][1] - path[a][1]];
  };

  const edgeParts: string[] = [];

  for (const [lineId, traversal] of layout.lineTraversals) {
    const line = lineById.get(lineId);
    if (!line || traversal.length === 0) continue;

    const turns: boolean[] = new Array(traversal.length).fill(false);
    for (let i = 0; i < traversal.length - 1; i++) {
      const ea = edgeById.get(traversal[i].edgeId);
      const eb = edgeById.get(traversal[i + 1].edgeId);
      if (!ea || !eb || ea.path.length < 2 || eb.path.length < 2) continue;
      const da = endDir(edgePolyline(ea), traversal[i].reversed);
      const db = startDir(edgePolyline(eb), traversal[i + 1].reversed);
      if (da[0] !== db[0] || da[1] !== db[1]) turns[i] = true;
    }

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
    const quadTo = (ctrl: Pixel, end: Pixel) => {
      if (prev) segments.push({ p1: prev, p2: end });
      d.push('Q' + ctrl[0].toFixed(1) + ',' + ctrl[1].toFixed(1) + ' ' + end[0].toFixed(1) + ',' + end[1].toFixed(1));
      prev = end;
    };

    for (let i = 0; i < traversal.length; i++) {
      const step = traversal[i];
      const edge = edgeById.get(step.edgeId);
      if (!edge) continue;
      const base = offsetPath(edge, lineId);
      const path = step.reversed ? [...base].reverse() : base;
      const stop = edge.stops.get(lineId);
      if (stop) {
        const fromNode = step.reversed ? edge.to : edge.from;
        const toNode = step.reversed ? edge.from : edge.to;
        const atFrom = step.reversed ? stop.atTo : stop.atFrom;
        const atTo = step.reversed ? stop.atFrom : stop.atTo;
        const first = path[0];
        const last = path[path.length - 1];
        const addStop = (nodeId: string, pos: Pixel) => {
          const key = nodeId + '|' + lineId;
          if (stopSeen.has(key)) return;
          stopSeen.add(key);
          if (!stopsByNode.has(nodeId)) stopsByNode.set(nodeId, []);
          stopsByNode.get(nodeId)!.push({ lineId, color: line.color, pos });
        };
        if (atFrom) addStop(fromNode, first);
        if (atTo) addStop(toNode, last);
      }

      if (i === 0) {
        moveTo(path[0]);
        for (let k = 1; k < path.length; k++) lineTo(path[k]);
      } else if (turns[i - 1]) {
        const fromNode = step.reversed ? edge.to : edge.from;
        const ctrl = nodePx.get(fromNode);
        if (ctrl) quadTo(ctrl, path[0]);
        else lineTo(path[0]);
        for (let k = 1; k < path.length; k++) lineTo(path[k]);
      } else {
        const sameAsPrev = prev && prev[0] === path[0][0] && prev[1] === path[0][1];
        for (let k = sameAsPrev ? 1 : 0; k < path.length; k++) lineTo(path[k]);
      }
    }

    if (d.length < 2) continue;
    const dStr = d.join(' ');
    edgeParts.push(
      '<path d="' + dStr + '" fill="none" stroke="' + bg + '" stroke-width="' + casingWidth +
        '" stroke-linecap="round" stroke-linejoin="round"/>',
    );
    edgeParts.push(
      '<path d="' + dStr + '" fill="none" stroke="' + escapeXml(line.color) + '" stroke-width="' +
        LINE_WIDTH + '" stroke-linecap="round" stroke-linejoin="round" data-line-id="' + escapeXml(line.id) + '"/>',
    );
  }

  // Ghost nodes are invisible: drop any accidentally-attached stop marks
  // (none should be there if the splitter put stops on bundle edges
  // correctly, but a defensive sweep keeps the contract local).
  if (args.ghostNodeIds) {
    for (const gid of args.ghostNodeIds) stopsByNode.delete(gid);
  }

  const stopParts = renderStops(stopsByNode, dark);
  const placements = showLabels ? placeLabels(layout, nodePx, stopsByNode, segments) : new Map();
  const labelParts: string[] = [];
  for (const n of layout.nodes.values()) {
    // Ghost nodes are invisible — no marker, no label.
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
    // Resolve each node's *drawn* dot: a single stop is a circle at its mark; an
    // interchange is the bounding box of its marks. Fall back to the node pixel.
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
      { dark, strokeWidth: LINE_WIDTH * 0.6 },
    );
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width +
    '" height="' + height + '">\n<rect width="' + width + '" height="' + height + '" fill="' + bg + '"/>\n' +
    (waterPart ? waterPart + '\n' : '') +
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
