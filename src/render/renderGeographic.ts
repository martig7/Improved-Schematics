// Geographic renderer: route lines over land/water in true geographic positions
// (Geographic mode), or octilinear-leaning straight segments anchored to those
// positions (Smoothed mode). Smoothed reuses the schematic's ribbon renderer so
// lines bundle into parallel ribbons and multi-route stops become pills.

import type { Coordinate } from '../types/core';
import type { Route, Track } from '../types/game-state';
import type { WaterCollection, SchematicOptions } from './types';
import type { Pixel, StopMark, TransitGraph, Layout, LayoutNode, LayoutEdge, Cell, EdgeStop, SupportGraph } from './layout/types';
import { DEFAULT_OPTIONS, DARK_THEME } from './types';
import { createProjection, computeBounds, padBounds, type Projection } from './projection';
import { extractRouteLines } from './routes';
import { getOrBuildStationGroups, buildTransitGraph } from './layout/graph';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from './layout/octi';
import { buildOctiGrid, type OctiGrid } from './layout/octiGrid';
import { buildSupportGraph, type TopoParams } from './layout/topo';
import { buildDensityWarp } from './layout/densityWarp';
import { mergeCoincidentPaths } from './layout/imageMerge';
import { placeLabels, renderLabel, type Segment } from './labels';
import {
  findTransferPairs,
  renderTransferConnectors,
  edgeKeysFromGraph,
  routedGroupsOnly,
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

function pointToSeg(p: Pixel, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  const t = c1 / c2;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/** Douglas–Peucker simplification. */
function rdp(pts: Pixel[], eps: number): Pixel[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSeg(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

/** Remove near-duplicate consecutive points, then lightly simplify. Topo's
 *  densified+smoothed corridor polylines carry many sub-pixel and near-180°
 *  zig points that make offsetPolyline spike into visible curls; cleaning them
 *  yields smooth ribbons while preserving real corridor bends. */
function cleanPolyline(pts: Pixel[]): Pixel[] {
  if (pts.length <= 2) return pts.slice();
  const dedup: Pixel[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const last = dedup[dedup.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= 1) dedup.push(pts[i]);
  }
  // Always keep the true last endpoint so the edge still meets its node.
  const end = pts[pts.length - 1];
  if (dedup[dedup.length - 1] !== end) dedup.push(end);
  if (dedup.length <= 2) return dedup;
  return rdp(dedup, 2.5);
}

/** Adapt a topo SupportGraph into the Layout shape renderRibbons consumes.
 *  Node "cells" are pixels (identity edgePolyline), edge paths are the merged
 *  corridor polylines, and stops come from the support graph's stopAt set. */
function supportToLayout(h: SupportGraph): { layout: Layout; nodePx: Map<string, Pixel> } {
  const nodes = new Map<string, LayoutNode>();
  const nodePx = new Map<string, Pixel>();
  // Render stations at their support-node positions; label by station.
  const labelByNode = new Map<string, string>();
  for (const st of h.stations.values()) labelByNode.set(st.nodeId, st.label);
  for (const [id, n] of h.nodes) {
    nodes.set(id, {
      id,
      cell: [n.pos[0], n.pos[1]] as Cell,
      label: labelByNode.get(id) ?? '',
      lngLat: [n.pos[0] / 1e5, n.pos[1] / 1e5] as Coordinate,
    });
    nodePx.set(id, n.pos);
  }
  const edges: LayoutEdge[] = [];
  for (const e of h.edges.values()) {
    const lines = [...e.lineIds].map((id) => h.lineRefs.get(id)!).filter(Boolean);
    const stops = new Map<string, EdgeStop>();
    for (const id of e.lineIds) {
      const atFrom = h.stopAt.has(id + '|' + e.from);
      const atTo = h.stopAt.has(id + '|' + e.to);
      if (atFrom || atTo) stops.set(id, { atFrom, atTo });
    }
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      path: cleanPolyline(e.points).map((p) => [p[0], p[1]] as Cell),
      lines,
      lineOrder: lines.map((l) => l.id).sort(),
      stops,
    });
  }
  const layout: Layout = { cellSize: 1, nodes, edges, lineTraversals: h.lineTraversals };
  return { layout, nodePx };
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

  if (opts.useTopoMerge) {
    return renderGeographicTopo(input, opts);
  }

  const lines = extractRouteLines(input.routes, input.tracks, input.stations as never, input.stationGroups);
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
    const transfers = findTransferPairs(routedGroupsOnly(groups, graph), DEFAULT_TRANSFER_METERS);
    const excludeKeys = edgeKeysFromGraph(graph.edges);
    const routeCounts = nodeRouteCount(graph);
    // Match the dot/pill sizing in renderGeoNodes so the staple hugs the marker.
    const dotRadius = (id: string): number => {
      const routeN = routeCounts.get(id) ?? 1;
      return routeN > 1 ? INTERCHANGE_R + Math.min(routeN - 1, 4) * 1.6 : STATION_R;
    };
    const connector = renderTransferConnectors(
      transfers,
      (p) => ({
        from: proj.toSVG(p.fromCenter),
        to: proj.toSVG(p.toCenter),
        radius: Math.max(dotRadius(p.fromId), dotRadius(p.toId)),
      }),
      excludeKeys,
      { dark, strokeWidth: theme.lineWidth * 0.7 },
    );
    if (connector) parts.push(connector);

    parts.push(renderGeoNodes(graph, nodePx, opts, dark, segments));
  }

  return svgWrap(parts, width, height);
}

function renderGeographicTopo(input: GeoInput, opts: SchematicOptions): string {
  const { width, height, padding, dark } = opts;
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const groups = getOrBuildStationGroups(input.stations as never, input.stationGroups);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups, input.tracks);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, options: { ...input.options, useTopoMerge: false } });
  }

  // Frame on geography. Include curved corridor geometry in the bounds so track
  // courses that bow beyond the station centres aren't clipped.
  const bounds = (() => {
    const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
    for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
    const b = computeBounds(framePts);
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

  // LOOM topo merge (same tuning as smoothed mode; see renderSmoothed). In
  // geographic mode we don't go through octi, so support edges keep their
  // merged corridor geometry directly. preserveStations keeps every transit-
  // graph node alive so intermediate stops along trunks remain visible.
  // dHat is a corridor-merge radius, not a stroke property: pinned >= 16px so
  // thinner theme line widths don't shrink the tuned merge radius.
  const dHat = Math.max(16, theme.lineWidth * 4);
  const topoParams: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
    preserveStations: false,
  };
  const h = buildSupportGraph(graph, groups, topoParams);
  const { layout, nodePx } = supportToLayout(h);
  orderLines(layout);

  const transfers = findTransferPairs(routedGroupsOnly(groups, graph), DEFAULT_TRANSFER_METERS);

  // Render water through the real projection (the support graph carries no
  // lngLat, so renderRibbons' bbox-affine water mapping can't be used). Inject
  // it via the gridOverlay slot, which draws between the background and routes.
  const waterColor = dark ? DARK_THEME.water : theme.water;
  const waterOverlay = input.water ? waterGroup(input.water, proj, waterColor) : '';

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
    width,
    height,
    dark,
    showLabels: opts.showLabels,
    transfers,
    gridOverlay: waterOverlay,
  });
}

function renderSmoothed(input: GeoInput, opts: SchematicOptions): string {
  const { width, height, padding, dark } = opts;
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const groups = getOrBuildStationGroups(input.stations as never, input.stationGroups);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups, input.tracks);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, smooth: false });
  }

  const bounds = (() => {
    const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
    for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
    const b = computeBounds(framePts);
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  // Density-equalizing warp: enlarge crowded parts of the map (the way print
  // NYC subway maps blow up Manhattan) so the octi grid effectively gets finer
  // exactly where the network is dense. The warp wraps the projection, so the
  // network, the water polygons, and every overlay deform through one
  // continuous, provably fold-free mapping; octi runs AFTER the warp, so the
  // output is still perfectly octilinear in screen space.
  // (dev override: OCTI_WARP=<alpha>, 0 disables)
  const baseProj = createProjection(bounds, width, height, padding);
  const warpAlpha = (() => {
    const env =
      typeof process !== 'undefined'
        ? Number((process as { env?: Record<string, string> }).env?.OCTI_WARP)
        : NaN;
    return Number.isFinite(env) ? env : 0.6;
  })();
  // Weight each station by the number of lines through it (capped) so that
  // corridor-rich hub areas — not just station-dense downtowns — dilate.
  // A West-Seattle-style fan hub has moderate station density but needs room
  // proportional to its LINE fan; pure station counting would compress it.
  const warpSamples: Pixel[] = [];
  for (const n of graph.nodes.values()) {
    const p = baseProj.toSVG(n.lngLat);
    const lines = new Set<string>();
    for (const eid of graph.adj.get(n.id) ?? []) {
      const e = graph.edges.find((x) => x.id === eid);
      if (e) for (const l of e.lines) lines.add(l.id);
    }
    const w = Math.max(1, Math.min(4, lines.size));
    for (let i = 0; i < w; i++) warpSamples.push(p);
  }
  const warp = buildDensityWarp(
    warpSamples,
    { minX: 0, minY: 0, maxX: width, maxY: height },
    { alpha: warpAlpha },
  );
  const proj: Projection = {
    ...baseProj,
    toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)),
  };
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

  // LOOM topo merge: collapse geographically parallel transit edges into
  // single support edges carrying the union of their line ids (Brosi & Bast
  // 2024 §"Network Topology Extraction"). With bundling solved at the GRAPH
  // level, octi routes each merged corridor as ONE octilinear path and the
  // per-edge offset model (orderLines + computeCanonicalOffsets) lanes the
  // co-running lines into parallel ribbons — no post-hoc grid-segment fix-up.
  //
  // dHat (the merge-distance threshold) is fixed at 4× line width in pixels.
  // The paper's 2.5·w·c formula explodes at NYC-scale line counts and
  // collapses the map; a fixed pixel target reliably catches geographically
  // parallel corridors (yellow+purple+pink along Lex, etc.) without merging
  // unrelated nearby edges. See dev/_diag-topo-octi.ts for the sweep.
  // (dev diagnostic, default off: OCTI_DHAT=<px> overrides the fixed merge
  // radius for LOOM-parity sweeps — see dev/_parity-dhat-sweep.ts. Unset in
  // production, so behavior is unchanged.)
  const dHatEnv =
    typeof process !== 'undefined'
      ? Number((process as { env?: Record<string, string> }).env?.OCTI_DHAT)
      : NaN;
  // dHat is a corridor-merge radius, not a stroke property: pinned >= 16px so
  // thinner theme line widths don't shrink the tuned merge radius.
  const dHat =
    Number.isFinite(dHatEnv) && dHatEnv > 0 ? dHatEnv : Math.max(16, theme.lineWidth * 4);
  const topoParams: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
    preserveStations: false,
  };
  const support = buildSupportGraph(graph, groups, topoParams);
  const medLen = medianEdgeLength(support);
  const octiOpts = { ...DEFAULT_OCTI_OPTIONS };
  // Grid fineness vs contraction: octi contracts away everything shorter
  // than half a cell, so a coarser grid both merges noisy station clusters
  // into single skeleton nodes AND leaves each surviving node more breathing
  // room per cell. Two regimes:
  //  - metro-scale (hundreds of support edges, NYC saves): finer grid
  //    (divisor 2.5) resolves congested downtowns without detours;
  //  - bus-scale (thousands of edges, Seattle-like, mega-hubs): a fine grid
  //    lets corridors NEST in concentric rings around hubs and explodes
  //    routing time. LOOM defaults to ~100% of station spacing — coarse
  //    grids force clean radial fans and are fast.
  // (dev override: OCTI_DIVISOR for tuning sweeps)
  // Divisor 1.6 (was 2.5) for metro-scale graphs: chosen by the 2026-06-10
  // spacing sweep on the live Seattle dump — spreads adjacent corridors to
  // >= 1 cell ~= 6.6 line-widths (at lineWidth 3.5) so unmerged parallels
  // read as separate lines instead of a crammed band; 2.5 stayed compressed,
  // 1.0 reintroduced spiral wraps at terminal loops.
  const divisor =
    (typeof process !== 'undefined' && Number((process as { env?: Record<string, string> }).env?.OCTI_DIVISOR)) ||
    (support.edges.size > 800 ? 1.2 : 1.6);
  octiOpts.cellSize = Math.max(12, medLen / divisor);
  // (dev diagnostic, default off: OCTI_NO_COMBINE=1 disables octi's deg-2
  // collapse so every station node is placed by the octilinearizer itself)
  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_NO_COMBINE === '1'
  ) {
    octiOpts.combineDeg2 = false;
  }
  // (dev diagnostic, default off: OCTI_AFFINITY=<n> sets octi's geographic-
  // course enforcement penalty — LOOM's -G enfGeoPen — for macro-geometry
  // sweeps; 0/unset = pure LOOM schematic, current production behavior)
  const affEnv =
    typeof process !== 'undefined'
      ? Number((process as { env?: Record<string, string> }).env?.OCTI_AFFINITY)
      : NaN;
  if (Number.isFinite(affEnv) && affEnv > 0) {
    octiOpts.geographicAffinity = affEnv;
  }
  const imageRaw = octi(support, octiOpts);

  // LOOM Drawing::getLineGraph: octi's relaxed constraints let two support
  // edges share grid segments; consolidate coincident runs into single edges
  // carrying the union of lines so the renderer fans them into a bundle
  // instead of drawing one line invisibly on top of the other.
  const merged = mergeCoincidentPaths(support, imageRaw);
  const supportM = merged.h;
  const image = merged.img;

  // Build a Layout from the merged support graph, then override node positions
  // with octi's grid placement and edge paths with its routed octilinear
  // polylines. Each layout edge already carries the union of merged line ids.
  const { layout, nodePx } = supportToLayout(supportM);
  for (const n of layout.nodes.values()) {
    const placed = image.placement.get(n.id);
    if (placed) {
      n.cell = [placed[0], placed[1]] as Cell;
      nodePx.set(n.id, placed);
    }
  }
  for (const e of layout.edges) {
    const routed = image.paths.get(e.id);
    if (routed) e.path = routed.map((p) => [p[0], p[1]] as Cell);
  }
  orderLines(layout);

  const transfers = findTransferPairs(routedGroupsOnly(groups, graph), DEFAULT_TRANSFER_METERS);

  // The support graph carries no lngLat for renderRibbons' affine water map, so
  // draw water through the real projection and inject it (plus the optional Γ'
  // overlay) via the gridOverlay slot.
  const waterColor = dark ? DARK_THEME.water : theme.water;
  const waterOverlay = input.water ? waterGroup(input.water, proj, waterColor) : '';
  const gridSvg = opts.showGrid ? buildOctiGridSvg(buildOctiGrid(pixelBounds(nodePx), image.cellSize), dark) : '';

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
    width,
    height,
    dark,
    showLabels: opts.showLabels,
    transfers,
    gridOverlay: waterOverlay + gridSvg,
  });
}

/** Axis-aligned bounds of a set of pixel positions, for sizing the Γ' overlay. */
function pixelBounds(nodePx: Map<string, Pixel>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of nodePx.values()) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Diagnostic overlay: the octi base grid as faint axis/diagonal lines plus
 *  base-node dots. Drawn between water and routes. */
function buildOctiGridSvg(grid: OctiGrid, dark: boolean): string {
  const stroke = dark ? '#3a4150' : '#cdd3dc';
  const dotFill = dark ? '#525a6a' : '#a3acbb';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of grid.edges) {
    if (e.kind !== 'grid') continue;
    const fromBase = e.from.split(':')[0];
    const toBase = e.to.split(':')[0];
    const key = fromBase < toBase ? fromBase + '|' + toBase : toBase + '|' + fromBase;
    if (seen.has(key)) continue;
    seen.add(key);
    const pa = grid.baseById.get(fromBase)?.pos;
    const pb = grid.baseById.get(toBase)?.pos;
    if (!pa || !pb) continue;
    lines.push(
      '<line x1="' + pa[0].toFixed(1) + '" y1="' + pa[1].toFixed(1) +
        '" x2="' + pb[0].toFixed(1) + '" y2="' + pb[1].toFixed(1) +
        '" stroke="' + stroke + '" stroke-width="0.4" opacity="0.5"/>',
    );
  }
  const dots: string[] = [];
  for (const b of grid.baseNodes) {
    dots.push('<circle cx="' + b.pos[0].toFixed(1) + '" cy="' + b.pos[1].toFixed(1) + '" r="0.9" fill="' + dotFill + '" opacity="0.8"/>');
  }
  return '<g class="octi-grid">' + lines.join('') + dots.join('') + '</g>';
}

function svgWrap(parts: string[], width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${parts.join('')}</svg>`
  );
}
