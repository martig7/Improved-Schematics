// Geographic renderer: route lines over land/water in true geographic positions
// (Geographic mode), or octilinear-leaning straight segments anchored to those
// positions (Smoothed mode). Smoothed reuses the schematic's ribbon renderer so
// lines bundle into parallel ribbons and multi-route stops become pills.

import type { Coordinate } from '../types/core';
import type { Route, Track } from '../types/game-state';
import type { WaterCollection, SchematicOptions } from './types';
import type { Pixel, StopMark, TransitGraph, Layout, LayoutNode, LayoutEdge, Cell } from './layout/types';
import { DEFAULT_OPTIONS, DARK_THEME } from './types';
import { createProjection, computeBounds, padBounds, type Projection } from './projection';
import { extractRouteLines } from './routes';
import { getOrBuildStationGroups, buildTransitGraph } from './layout/graph';
import { octilinearPath } from './layout/octilinearPath';
import { placeLabels, renderLabel, type Segment } from './labels';
import {
  findTransferPairs,
  renderTransferConnectors,
  edgeKeysFromGraph,
  DEFAULT_TRANSFER_METERS,
} from './transfers';
import { renderRibbons } from './renderOctilinear';
import { orderLines } from './layout/lineOrder';

export interface GeoInput {
  routes: Route[];
  tracks: Track[];
  stations: { id: string; name: string; coords: Coordinate }[];
  /** Raw game stationGroups; see SchematicInput. */
  stationGroups?: unknown[];
  water?: WaterCollection;
  options?: Partial<SchematicOptions>;
  /** When true, relax lines toward octilinear while staying near geography. */
  smooth?: boolean;
}

const STATION_R = 3;
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

/** How many distinct routes pass through each node. */
function nodeRouteCount(graph: TransitGraph): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    for (const nid of [e.from, e.to]) {
      const set = seen.get(nid) ?? new Set<string>();
      for (const l of e.lines) set.add(l.id);
      seen.set(nid, set);
    }
  }
  const out = new Map<string, number>();
  for (const [id, set] of seen) out.set(id, set.size);
  return out;
}

/**
 * Dots + labels for the geographic renderer. Multi-route nodes get an oval
 * "pill" hint instead of a circle, signalling an interchange even though we
 * don't lane-bundle the lines in geographic mode.
 */
function renderGeoNodes(
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
    const routeCounts = nodeRouteCount(graph);
    let dots = '';
    for (const node of graph.nodes.values()) {
      const px = nodePx.get(node.id);
      if (!px) continue;
      const cs = colors.get(node.id) ?? [];
      const ring = cs.length === 1 ? cs[0] : dark ? '#e4e4e7' : '#111111';
      const routeN = routeCounts.get(node.id) ?? 1;
      if (routeN > 1) {
        // pill scaled by route count, capped so it stays readable
        const halfW = INTERCHANGE_R + Math.min(routeN - 1, 4) * 1.6;
        dots += `<rect x="${r(px[0] - halfW)}" y="${r(px[1] - INTERCHANGE_R)}" width="${r(halfW * 2)}" height="${r(INTERCHANGE_R * 2)}" rx="${INTERCHANGE_R}" ry="${INTERCHANGE_R}" fill="${fill}" stroke="${ring}" stroke-width="1.5"/>`;
      } else {
        dots += `<circle cx="${r(px[0])}" cy="${r(px[1])}" r="${STATION_R}" fill="${fill}" stroke="${ring}" stroke-width="1.5"/>`;
      }
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
    return renderSmoothed(input, opts);
  }

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

  // Build the station-group graph (real proximity-merged groups when available)
  // for nodes, transfer pairs, and labels.
  const groups = getOrBuildStationGroups(input.stations as never, input.stationGroups);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups);
  if (graph.nodes.size > 0) {
    const nodePx = new Map<string, Pixel>();
    for (const n of graph.nodes.values()) nodePx.set(n.id, proj.toSVG(n.lngLat));

    // Transfer connectors between nearby station groups not already joined by a route edge.
    const transfers = findTransferPairs(groups, DEFAULT_TRANSFER_METERS);
    const excludeKeys = edgeKeysFromGraph(graph.edges);
    const connector = renderTransferConnectors(
      transfers,
      (c) => proj.toSVG(c),
      excludeKeys,
      dark,
      theme.lineWidth * 0.7,
    );
    if (connector) parts.push(connector);

    parts.push(renderGeoNodes(graph, nodePx, opts, dark, segments));
  }

  return svgWrap(parts, width, height);
}

/** How many alternating u1+u2 cycles to use when stepping between two stations. */
const SMOOTHED_OCTI_SEGMENTS = 2;

function renderSmoothed(input: GeoInput, opts: SchematicOptions): string {
  const { width, height, padding, dark } = opts;
  const groups = getOrBuildStationGroups(input.stations as never, input.stationGroups);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, smooth: false });
  }

  // Frame on real station-group geography; project each node once. Stations
  // stay at their actual locations — no relaxation, no grid snap.
  const bounds = (() => {
    const b = computeBounds([...graph.nodes.values()].map((n) => ({ points: [n.lngLat] })));
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);
  const nodePx = new Map<string, Pixel>();
  for (const n of graph.nodes.values()) {
    const p = proj.toSVG(n.lngLat);
    n.pos = p;
    nodePx.set(n.id, p);
  }

  // Synthesise a Layout: each node "cell" is its real projected pixel; each
  // edge's "path" is an octilinear staircase that lands exactly on the next
  // station. The schematic ribbon renderer then bundles parallel lines and
  // draws pills at the multi-route nodes.
  const layoutNodes = new Map<string, LayoutNode>();
  for (const n of graph.nodes.values()) {
    layoutNodes.set(n.id, {
      id: n.id,
      cell: [n.pos[0], n.pos[1]] as Cell,
      label: n.label,
      lngLat: n.lngLat,
    });
  }
  const layoutEdges: LayoutEdge[] = graph.edges.map((e) => {
    const from = nodePx.get(e.from)!;
    const to = nodePx.get(e.to)!;
    const path = octilinearPath(from, to, SMOOTHED_OCTI_SEGMENTS).map(
      (p) => [p[0], p[1]] as Cell,
    );
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      path,
      lines: e.lines,
      lineOrder: e.lines.map((l) => l.id).sort(),
      stops: e.stops,
    };
  });
  const layout: Layout = {
    cellSize: 1,
    nodes: layoutNodes,
    edges: layoutEdges,
    lineTraversals: graph.lineTraversals,
  };
  orderLines(layout);

  const transfers = findTransferPairs(groups, DEFAULT_TRANSFER_METERS);

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
    width,
    height,
    dark,
    showLabels: opts.showLabels,
    water: input.water,
    transfers,
  });
}

function svgWrap(parts: string[], width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${parts.join('')}</svg>`
  );
}
