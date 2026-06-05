// Geographic renderer: route lines over land/water in true geographic positions
// (Geographic mode), or octilinear-leaning straight segments anchored to those
// positions (Smoothed mode). Both share water + label drawing.

import type { Coordinate } from '../types/core';
import type { Route, Track } from '../types/game-state';
import type { WaterCollection, SchematicOptions } from './types';
import type { Pixel, StopMark } from './layout/types';
import { DEFAULT_OPTIONS } from './types';
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

/** Labels over projected station pixels, avoiding markers and line segments. */
function labelGroup(
  nodes: Map<string, { id: string; label: string }>,
  nodePx: Map<string, Pixel>,
  segments: Segment[],
  dark: boolean,
): string {
  const stops = new Map<string, StopMark[]>();
  for (const [id, px] of nodePx) stops.set(id, [{ lineId: '', color: '#000', pos: px }]);
  const placements = placeLabels({ nodes }, nodePx, stops, segments);
  const parts: string[] = [];
  for (const node of nodes.values()) {
    const p = placements.get(node.id);
    if (!p) continue;
    parts.push(renderLabel(node, p, true, dark));
  }
  return parts.join('');
}

export function renderGeographic(input: GeoInput): string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const { width, height, padding, dark } = opts;
  const land = dark ? '#18181b' : theme.land;
  const water = dark ? '#1e3a4a' : theme.water;

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
      // decimate segments for label avoidance
      const step = Math.max(1, Math.floor(px.length / 40));
      for (let i = step; i < px.length; i += step) segments.push({ p1: px[i - step], p2: px[i] });
    }
  }
  parts.push(`<g>${linePaths}</g>`);

  const nodePx = new Map<string, Pixel>();
  const labelNodes = new Map<string, { id: string; label: string }>();
  for (const s of input.stations) {
    nodePx.set(s.id, proj.toSVG(s.coords));
    labelNodes.set(s.id, { id: s.id, label: s.name });
  }

  if (opts.showStations) {
    let markers = '';
    for (const px of nodePx.values()) {
      markers += `<circle cx="${r(px[0])}" cy="${r(px[1])}" r="${theme.stationRadius}"/>`;
    }
    parts.push(`<g fill="${theme.stationFill}" stroke="${theme.stationStroke}" stroke-width="0.6">${markers}</g>`);
  }

  if (opts.showLabels) parts.push(`<g class="stations">${labelGroup(labelNodes, nodePx, segments, dark)}</g>`);

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
    // nothing to smooth — fall back to plain geographic
    return renderGeographic({ ...input, smooth: false });
  }

  // frame on node geography, project, then relax toward octilinear (reusing
  // smoothGeographic by feeding it projected pixels as node positions).
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

  const labelNodes = new Map<string, { id: string; label: string }>();
  for (const n of graph.nodes.values()) labelNodes.set(n.id, { id: n.id, label: n.label });

  if (opts.showStations) {
    let markers = '';
    for (const px of relaxed.values()) {
      markers += `<circle cx="${r(px[0])}" cy="${r(px[1])}" r="${theme.stationRadius}"/>`;
    }
    parts.push(`<g fill="${theme.stationFill}" stroke="${theme.stationStroke}" stroke-width="0.6">${markers}</g>`);
  }

  if (opts.showLabels) parts.push(`<g class="stations">${labelGroup(labelNodes, relaxed, segments, dark)}</g>`);

  return svgWrap(parts, width, height);
}

function svgWrap(parts: string[], width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${parts.join('')}</svg>`
  );
}

