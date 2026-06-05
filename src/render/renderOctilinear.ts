// Octilinear renderer: SVG output for a laid-out, simplified, line-ordered graph.
// Ported from the game (dev/reference/renderSvg.js, gridToPx.js) with an added
// geographic water backdrop (loosely affine-fit behind the schematic).

import type { Layout, Cell, Pixel, StopMark } from './layout/types';
import type { WaterCollection } from './types';
import { CELL_PX, PAD, LINE_WIDTH } from './constants';
import { DARK_THEME, DEFAULT_THEME } from './types';
import { computeCanonicalOffsets, offsetPolyline } from './layout/offsets';
import { renderStops } from './stops';
import { placeLabels, renderLabel, type Segment } from './labels';
import { escapeXml } from './escape';

export interface OctiOptions {
  dark?: boolean;
  showLabels?: boolean;
  water?: WaterCollection;
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
    minY + ((maxLat - lat) / gh) * ph, // Y flip: north at top
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
  const bg = dark ? DARK_THEME.land : '#ffffff';
  const casingWidth = LINE_WIDTH + 3;
  const offsets = computeCanonicalOffsets(layout);

  const nodePx = new Map<string, Pixel>();
  for (const n of layout.nodes.values()) nodePx.set(n.id, toPx(n.cell));

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
    const px = edge.path.map(toPx);
    const result = off === 0 ? px : offsetPolyline(px, off);
    offsetCache.set(key, result);
    return result;
  };

  // direction at an edge end, for detecting turns between consecutive edges
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
      const da = endDir(ea.path.map(toPx), traversal[i].reversed);
      const db = startDir(eb.path.map(toPx), traversal[i + 1].reversed);
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

  const stopParts = renderStops(stopsByNode, dark);
  const placements = showLabels ? placeLabels(layout, nodePx, stopsByNode, segments) : new Map();
  const labelParts: string[] = [];
  for (const n of layout.nodes.values()) {
    const placement = placements.get(n.id);
    const anchor = nodePx.get(n.id);
    if (!placement || !anchor) continue;
    labelParts.push(renderLabel(n, placement, anchor, stopsByNode.has(n.id), dark));
  }

  const waterPart = opts.water ? waterBackdrop(layout, nodePx, opts.water, dark) : '';

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width +
    '" height="' + height + '">\n<rect width="' + width + '" height="' + height + '" fill="' + bg + '"/>\n' +
    (waterPart ? waterPart + '\n' : '') +
    '<g class="edges">\n' + edgeParts.join('\n') + '\n</g>\n<g class="stops">\n' + stopParts.join('\n') +
    '\n</g>\n<g class="stations">\n' + labelParts.join('\n') + '\n</g>\n</svg>'
  );
}
