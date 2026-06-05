// Geographic renderer: route lines over land/water in true geographic positions
// (Geographic mode), or octilinear-leaning straight segments anchored to those
// positions (Smoothed mode). Both render dots + labels from station GROUPS (the
// same interchange-collapsed nodes the schematic uses) so the map isn't buried
// under every individual platform.

import type { Coordinate } from '../types/core';
import type { Route, Track } from '../types/game-state';
import type { WaterCollection, SchematicOptions } from './types';
import type { Pixel, StopMark, TransitGraph } from './layout/types';
import { DEFAULT_OPTIONS, DARK_THEME } from './types';
import { createProjection, computeBounds, padBounds, type Projection } from './projection';
import { extractRouteLines } from './routes';
import { buildStationGroups, buildTransitGraph } from './layout/graph';
import { smoothGeographic } from './layout/simplify';
import { placeLabels, renderLabel, type Segment } from './labels';

export interface GeoInput {
  routes: Route[];
  tracks: Track[];
  stations: { id: string; name: string; coords: Coordinate }[];
  water?: WaterCollection;
  options?: Partial<SchematicOptions>;
  /** When true, relax lines toward octilinear while staying near geography. */
  smooth?: boolean;
}

const STATION_R = 3; // dot radius (interchanges a touch larger)
const INTERCHANGE_R = 4.2;

const r = (n: number): number => Math.round(n * 10) / 10;

function lineToPath(points: Pixel[]): string {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    d += (i === 0 ? 'M' : 'L') + r(points[i][0]) + ' ' + r(points[i][1]) + ' ';
  }
  return d.trim();
}

function waterGroup(water: WaterCollection, proj: Projection, fill: string): string {
  let paths = '';
  for (const f of water.features) {
    if (f.geometry.type !== 'Polygon') continue;
    let d = '';
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = proj.toSVG(c);
        d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
      });
      d += 'Z ';
    }
    if (d.trim()) paths += `<path d="${d.trim()}"/>`;
  }
  if (!paths) return '';
  return `<g fill="${fill}" fill-rule="evenodd" stroke="none">${paths}</g>`;
}

/** Map each node to the distinct line colors passing through it. */
function nodeRingColors(graph: TransitGraph): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of graph.edges) {
    for (const nid of [e.from, e.to]) {
      const arr = m.get(nid) ?? [];
      for (const l of e.lines) if (!arr.includes(l.color)) arr.push(l.color);
      m.set(nid, arr);
    }
  }
  return m;
}

/**
 * Station dots (white fill + colored/neutral ring, like the schematic) and
 * collision-placed labels, both from the grouped graph nodes.
 */
function renderNodes(
  graph: TransitGraph,
  nodePx: Map<string, Pixel>,
  opts: SchematicOptions,
  dark: boolean,
  segments: Segment[],
): string {
  let out = '';
  const fill = dark ? '#18181b' : '#ffffff';

  if (opts.showStations) {
    const colors = nodeRingColors(graph);
    let dots = '';
    for (const node of graph.nodes.values()) {
      const px = nodePx.get(node.id);
      if (!px) continue;
      const cs = colors.get(node.id) ?? [];
      const ring = cs.length === 1 ? cs[0] : dark ? '#e4e4e7' : '#111111';
      const rad = cs.length > 1 ? INTERCHANGE_R : STATION_R;
      dots += `<circle cx="${r(px[0])}" cy="${r(px[1])}" r="${rad}" fill="${fill}" stroke="${ring}" stroke-width="1.5"/>`;
    }
    out += `<g class="stations-dots">${dots}</g>`;
  }

  if (opts.showLabels) {
    const labelNodes = new Map<string, { id: string; label: string }>();
    for (const n of graph.nodes.values()) labelNodes.set(n.id, { id: n.id, label: n.label });
    const stops = new Map<string, StopMark[]>();
    for (const [id, px] of nodePx) stops.set(id, [{ lineId: '', color: '#000', pos: px }]);
    const placements = placeLabels({ nodes: labelNodes }, nodePx, stops, segments);
    let labels = '';
    for (const node of labelNodes.values()) {
      const p = placements.get(node.id);
      const anchor = nodePx.get(node.id);
      if (p && anchor) labels += renderLabel(node, p, anchor, true, dark);
    }
    out += `<g class="stations">${labels}</g>`;
  }

  return out;
}

export function renderGeographic(input: GeoInput): string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const { width, height, padding, dark } = opts;
  const land = dark ? DARK_THEME.land : theme.land;
  const water = dark ? DARK_THEME.water : theme.water;

  const parts: string[] = [`<rect x="0" y="0" width="${width}" height="${height}" fill="${land}"/>`];

  if (input.smooth) {
    return renderSmoothed(input, opts, theme, parts, water);
  }

  // --- Geographic mode: dense route geometry in true positions ---
  const lines = extractRouteLines(input.routes, input.tracks);
  const bounds = (() => {
    const b = computeBounds(lines);
    return b ? padBounds(b, 0.08) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);

  if (input.water) {
    const g = waterGroup(input.water, proj, water);
    if (g) parts.push(g);
  }

  const segments: Segment[] = [];
  let linePaths = '';
  for (const line of lines) {
    const px = line.points.map((c) => proj.toSVG(c));
    linePaths +=
      `<path d="${lineToPath(px)}" fill="none" stroke="${line.color}" ` +
      `stroke-width="${theme.lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (opts.showLabels) {
      const step = Math.max(1, Math.floor(px.length / 40));
      for (let i = step; i < px.length; i += step) segments.push({ p1: px[i - step], p2: px[i] });
    }
  }
  parts.push(`<g>${linePaths}</g>`);

  // Dots + labels from grouped nodes, projected with the same projection.
  const groups = buildStationGroups(input.stations as never);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups);
  if (graph.nodes.size > 0) {
    const nodePx = new Map<string, Pixel>();
    for (const n of graph.nodes.values()) nodePx.set(n.id, proj.toSVG(n.lngLat));
    parts.push(renderNodes(graph, nodePx, opts, dark, segments));
  }

  return svgWrap(parts, width, height);
}

function renderSmoothed(
  input: GeoInput,
  opts: SchematicOptions,
  theme: SchematicOptions['theme'],
  parts: string[],
  water: string,
): string {
  const { width, height, padding, dark } = opts;
  const groups = buildStationGroups(input.stations as never);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, smooth: false });
  }

  const bounds = (() => {
    const b = computeBounds([...graph.nodes.values()].map((n) => ({ points: [n.lngLat] })));
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);
  const relaxed = smoothGeographic(graph);

  if (input.water) {
    const g = waterGroup(input.water, proj, water);
    if (g) parts.push(g);
  }

  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  const lineById = new Map<string, { id: string; color: string }>();
  for (const e of graph.edges) for (const l of e.lines) if (!lineById.has(l.id)) lineById.set(l.id, l);

  const segments: Segment[] = [];
  let linePaths = '';
  for (const [lineId, traversal] of graph.lineTraversals) {
    const line = lineById.get(lineId);
    if (!line) continue;
    const seq: string[] = [];
    for (const step of traversal) {
      const e = edgeById.get(step.edgeId);
      if (!e) continue;
      const a = step.reversed ? e.to : e.from;
      const b = step.reversed ? e.from : e.to;
      if (seq.length === 0 || seq[seq.length - 1] !== a) seq.push(a);
      seq.push(b);
    }
    const px = seq.map((id) => relaxed.get(id)!).filter(Boolean);
    if (px.length < 2) continue;
    linePaths +=
      `<path d="${lineToPath(px)}" fill="none" stroke="${line.color}" ` +
      `stroke-width="${theme.lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
    for (let i = 1; i < px.length; i++) segments.push({ p1: px[i - 1], p2: px[i] });
  }
  parts.push(`<g>${linePaths}</g>`);

  parts.push(renderNodes(graph, relaxed, opts, dark, segments));

  return svgWrap(parts, width, height);
}

function svgWrap(parts: string[], width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${parts.join('')}</svg>`
  );
}
