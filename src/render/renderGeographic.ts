// Geographic renderer: route lines over land/water in true geographic positions
// (Geographic mode), or octilinear-leaning straight segments anchored to those
// positions (Smoothed mode). Smoothed reuses the schematic's ribbon renderer so
// lines bundle into parallel ribbons and multi-route stops become pills.

import {
  makePerfLap,
  auditBoxTransit,
  traceCellSize,
  makeShortEdgeCensus,
  traceWeld,
  auditBoxSupport,
  auditLine,
  auditSpurDrops,
  traceHooks,
} from './debug/renderGeographic.debug';
import { envStr, envNum } from '../env';
import type { Coordinate } from '../types/core';
import type { Route, Track } from '../types/game-state';
import type { WaterCollection, SchematicOptions } from './types';
import type { Pixel, StopMark, TransitGraph, Layout, LayoutNode, LayoutEdge, Cell, EdgeStop, SupportGraph } from './layout/types';
import { DEFAULT_OPTIONS, DARK_THEME } from './types';
import { createProjection, computeBounds, padBounds, projectedBounds, type Projection, type FrameRect } from './projection';
import { extractRouteLines } from './routes';
import { getOrBuildStationGroups, buildTransitGraph, servedStationIds } from './layout/graph';
import { fingerprintInputs } from './cacheFingerprint';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from './layout/octi';
import { buildOctiGrid, type OctiGrid } from './layout/octiGrid';
import { buildSupportGraph, weldSubCellNodes, type TopoParams } from './layout/topo';
import { buildDensityWarp, type WarpFn } from './layout/densityWarp';
import { buildDemandBoxWarp, buildSepDemandBoxWarp, type BoxGraph, type DenseBox } from './layout/densityBoxWarp';
import { LINE_WIDTH, LINE_GAP, regimeDivisor } from './constants';
import { mergeCoincidentPaths, separateFusedStations, collapseFoldStubs } from './layout/imageMerge';
import { placeLabels, renderLabel, type Segment } from './labels';
import { renderRibbons, computeRibbonGeometry, paintRibbons, type RibbonGeometry, type SceneOut } from './renderOctilinear';
import { nodeSeqFromSupport } from './layout/stopSeq';
import { orderLines } from './layout/lineOrder';
import { suppressHooks } from './layout/hookSuppress';
import { auditTraversals, auditZigzags } from './layout/debug/travAudit';
import { orderByBlocks } from './layout/bundleOrder';
import { rescueTwists } from './layout/twistRescue';
import { geographyBackdrop, projectGeoRings, backdropFromRings, type GeoRingsPx } from './geographyBackdrop';
import { rasterizeRings, windingAt, type LandmassParams } from './geoSimplify';
import type { GeographyData } from '../geography/types';

// Diagnostic stash (set only when OCTI_WARP_DEBUG is in the env, so the game
// never retains it): the exact density-warp map + canvas size + warped network
// the last smoothed render built, for dev/warp-heatmap.ts to visualize where
// space is dilated. `nodes`/`edges` are in the SAME pre-octi warped pixel space
// the warp operates in, so they overlay the magnification grid coherently.
export let __warpDebug:
  | {
      warp: WarpFn;
      width: number;
      height: number;
      nodes: Pixel[]; // warped (post-warp) node positions
      nodesRaw: Pixel[]; // UNWARPED (baseProj) node positions — apply a tuned warp for previews
      edges: [number, number][];
      samples: Pixel[]; // unwarped weighted warp samples (drive density / box-finding)
    }
  | null = null;

export interface GeoInput {
  routes: Route[];
  tracks: Track[];
  stations: { id: string; name: string; coords: Coordinate }[];
  /** Raw game stationGroups; see SchematicInput. */
  stationGroups?: unknown[];
  water?: WaterCollection;
  geography?: GeographyData;
  options?: Partial<SchematicOptions>;
  /** When true, relax lines toward octilinear while staying near geography. */
  smooth?: boolean;
}

// Interchange pill half-height as a multiple of the station dot radius
// (theme.stationRadius), preserving the tuned 3 : 4.2 proportion.
const INTERCHANGE_R_FRAC = 1.4;

const r = (n: number): number => Math.round(n * 10) / 10;

function lineToPath(points: Pixel[]): string {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    d += (i === 0 ? 'M' : 'L') + r(points[i][0]) + ' ' + r(points[i][1]) + ' ';
  }
  return d.trim();
}

/** Frame points covering the geography extent, so the render bounds — and thus
 *  the land background rect — span the whole city rather than just the network.
 *  Empty when there's no geography. */
function geoFramePts(geo: GeographyData | undefined): { points: Coordinate[] }[] {
  if (!geo) return [];
  const [minLng, minLat, maxLng, maxLat] = geo.bbox;
  return [{ points: [[minLng, minLat], [maxLng, maxLat]] }];
}

/** Fit/export frame: the pixel-space extent of the furthest water/green geometry
 *  projected through `proj` (the visible backdrop). Both geographic and smoothed
 *  frame on this; smoothed passes its warped proj so the frame rides the warp.
 *  Null when there's no geography to frame. */
export function geographyFrame(geo: GeographyData | undefined, proj: Projection): FrameRect | null {
  if (!geo) return null;
  const coords: Coordinate[] = [];
  for (const feats of [geo.water, geo.green]) {
    for (const f of feats) {
      if (f.geometry.type !== 'Polygon') continue;
      for (const ring of f.geometry.coordinates) for (const c of ring) coords.push(c);
    }
  }
  return projectedBounds(proj, coords);
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
    const stationR = { ...DEFAULT_OPTIONS.theme, ...(opts.theme ?? {}) }.stationRadius;
    const interR = stationR * INTERCHANGE_R_FRAC;
    let dots = '';
    for (const node of graph.nodes.values()) {
      const px = nodePx.get(node.id);
      if (!px) continue;
      const cs = colors.get(node.id) ?? [];
      const ring = cs.length === 1 ? cs[0] : dark ? '#e4e4e7' : '#111111';
      const routeN = routeCounts.get(node.id) ?? 1;
      if (routeN > 1) {
        // pill scaled by route count, capped so it stays readable
        const halfW = interR + Math.min(routeN - 1, 4) * 1.6;
        dots += `<rect x="${r(px[0] - halfW)}" y="${r(px[1] - interR)}" width="${r(halfW * 2)}" height="${r(interR * 2)}" rx="${r(interR)}" ry="${r(interR)}" fill="${fill}" stroke="${ring}" stroke-width="1.5"/>`;
      } else {
        dots += `<circle cx="${r(px[0])}" cy="${r(px[1])}" r="${r(stationR)}" fill="${fill}" stroke="${ring}" stroke-width="1.5"/>`;
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
  if (c1 <= 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.sqrt((p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2);
  const t = c1 / c2;
  return Math.sqrt((p[0] - (a[0] + t * vx)) ** 2 + (p[1] - (a[1] + t * vy)) ** 2);
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
    if ((pts[i][0] - last[0]) ** 2 + (pts[i][1] - last[1]) ** 2 >= 1) dedup.push(pts[i]);
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

  const parts: string[] = [`<rect x="0" y="0" width="${width}" height="${height}" fill="${land}"/>`];

  if (input.smooth) {
    return renderSmoothed(input, opts);
  }

  if (opts.useTopoMerge) {
    return renderGeographicTopo(input, opts);
  }

  // Canonicalize input ORDER by id, the same as the topo and smoothed paths do.
  // Node draw order (Map insertion order) and the line paint order both follow the
  // input array order, so the offline dump and the game's live data (iterated in a
  // different order) would otherwise paint DIFFERENT SVG from the SAME network.
  // Sorting by id makes this render order-independent.
  const byId = <T extends { id: string }>(arr: ReadonlyArray<T>): T[] =>
    [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sStations = byId(input.stations as ReadonlyArray<{ id: string }>) as never;
  const sRoutes = byId(input.routes);
  const sTracks = input.tracks ? byId(input.tracks) : input.tracks;
  const sGroups = input.stationGroups ? byId(input.stationGroups) : input.stationGroups;

  const lines = extractRouteLines(sRoutes, sTracks, sStations, sGroups);
  const bounds = (() => {
    const b = computeBounds([...lines, ...geoFramePts(input.geography)]);
    return b ? padBounds(b, 0.08) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);

  const backdrop = geographyBackdrop(input.geography, proj, theme, dark);
  if (backdrop) parts.push(backdrop);

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
  const groups = getOrBuildStationGroups(sStations, sGroups);
  const graph = buildTransitGraph(sStations, sRoutes, groups);
  if (graph.nodes.size > 0) {
    const nodePx = new Map<string, Pixel>();
    for (const n of graph.nodes.values()) nodePx.set(n.id, proj.toSVG(n.lngLat));

    // Geographic mode draws no transfer-connector brackets — true positions make
    // nearby-but-unconnected stations legible without the staples.
    parts.push(renderGeoNodes(graph, nodePx, opts, dark, segments));
  }

  // Frame on the water/green geography extent.
  const frame = geographyFrame(input.geography, proj);
  return svgWrap(parts, width, height, frame);
}

function renderGeographicTopo(input: GeoInput, opts: SchematicOptions): string {
  const { width, height, padding, dark } = opts;
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  // Canonicalize input ORDER by id. The layout's Map/Set insertion order — and
  // thus octi's greedy search PATH — follows the input array order, so the
  // offline dump and the game's live data (iterated in a different order) would
  // otherwise produce DIFFERENT layouts from the SAME network. Sorting by id
  // makes the render order-independent → bit-identical offline and in-game.
  const byId = <T extends { id: string }>(arr: ReadonlyArray<T>): T[] =>
    [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sStations = byId(input.stations as ReadonlyArray<{ id: string }>) as never;
  const sRoutes = byId(input.routes);
  const sTracks = input.tracks ? byId(input.tracks) : input.tracks;
  const sGroups = input.stationGroups ? byId(input.stationGroups) : input.stationGroups;
  const groups = getOrBuildStationGroups(sStations, sGroups);
  const graph = buildTransitGraph(sStations, sRoutes, groups, sTracks);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, options: { ...input.options, useTopoMerge: false } });
  }

  // Frame on geography. Include curved corridor geometry in the bounds so track
  // courses that bow beyond the station centres aren't clipped.
  const bounds = (() => {
    const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
    for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
    framePts.push(...geoFramePts(input.geography));
    const b = computeBounds(framePts);
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

  // LOOM topo merge (same tuning as smoothed mode; see renderSmoothed). In
  // geographic mode we don't go through octi, so support edges keep their
  // merged corridor geometry directly.
  // dHat is a corridor-merge radius, not a stroke property: pinned >= 16px so
  // thinner theme line widths don't shrink the tuned merge radius.
  const dHat = Math.max(16, theme.lineWidth * 4);
  const topoParams: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
  };
  const h = buildSupportGraph(graph, groups, topoParams);
  const { layout, nodePx } = supportToLayout(h);
  layout.nodeSeq = nodeSeqFromSupport(h, graph.numberByGroup);
  orderLines(layout);

  // Render geography through the real projection (the support graph carries no
  // lngLat, so renderRibbons' bbox-affine mapping can't be used). Inject it via
  // the gridOverlay slot, which draws between the background and routes.
  const waterOverlay = geographyBackdrop(input.geography, proj, theme, dark);

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
    width,
    height,
    dark,
    showLabels: opts.showLabels,
    showStations: opts.showStations,
    gridOverlay: waterOverlay,
    // Topo geographic keeps the real projection, so it frames on water/green
    // exactly like plain geographic mode.
    frame: geographyFrame(input.geography, proj) ?? undefined,
  });
}

/** Everything renderRibbons needs to draw a smoothed map except the
 *  label/station toggles, i.e. the cacheable output of the heavy pipeline. */
export interface SmoothedPrecomputed {
  layout: Layout;
  nodePx: Map<string, Pixel>;
  /** input station id -> render position (px), for the magnifier's box hit-test. */
  stationPx: Map<string, Pixel>;
  stations: Array<{ nodeId: string; members: number; stopNodes: Map<string, string> }>;
  /** Static overlay drawn between water and routes (the optional Γ' grid; on
   *  legacy pres this also carried the baked water polygons — new pres carry
   *  the backdrop as geoRingsPx and build it at draw time). */
  gridOverlay: string;
  /** Projected water/green rings + fills, for the draw-time backdrop build —
   *  faithful polygons by default, simplified landmass blobs when the landmass
   *  style is on. Absent on legacy pres (their gridOverlay bakes the water in)
   *  and when there's no geography. */
  geoRingsPx?: GeoRingsPx;
  /** The harvested data region's outline in render px (closed polygon, edge-
   *  sampled through the warped projection). Present when the input geography
   *  carries a hull (rotated cities). Consumed ONLY by the landmass stylizer,
   *  which pins shoreline vertices near it so the data cutoff is never
   *  reshaped — it is NOT drawn (a hull-bounded land fill and boundary bleed
   *  were tried and reverted: in-game they painted giant false land). */
  geoHullPx?: Pixel[];
  width: number;
  height: number;
  dark: boolean;
  /** Fit/export frame (furthest water/green through the warped projection).
   *  Undefined when there's no geography — renderRibbons falls back to the
   *  rendered-content extent. */
  frame?: FrameRect;
  /** Inverse of the (separable, strictly-monotone) warped projection: a render
   *  pixel back to its geographic coord. Used by the magnifier inset to unproject
   *  the user's drawn box into the geographic bounds to crop on. */
  unproject: (p: Pixel) => Coordinate;
  /** Pixel extent of the geography's bbox through the warped projection — i.e.
   *  where the cropped region lands in this render. For the inset, this frames
   *  the view on exactly the selected geography. Undefined with no geography. */
  geoBboxFrame?: FrameRect;
  /** The toggle-independent ribbon geometry (lane bundles + the expensive marker
   *  placement solver), memoized on first draw by drawSmoothed and serialized with
   *  the precompute. When present, a draw (and every cache read) skips the 80-90%
   *  placement cost and only paints. See docs/cache-read-perf.md. */
  geometry?: RibbonGeometry;
  /** The dense-core regions the box-warp magnified, in render px (the same space as
   *  stationPx). For the optional "show warp boxes" debug overlay — display-only, not
   *  part of the layout/fingerprint. Empty for non-box warp modes (separable/2d) — no
   *  boxes are magnified — and absent (undefined) only for pre-existing cached layouts
   *  computed before this field existed. */
  denseBoxesPx?: DenseBox[];
  /** The layout fingerprint this precompute was BUILT under — stamped HERE, at
   *  compute time, never at save/load time. Provenance: the cache write/read
   *  paths and the file-load adoption verify a layout against it, so a stale
   *  pre can never ride under a freshly computed fingerprint (the LON
   *  zombie-pre bug: a schema-7 layout paired with a v9 fp survived rebuilds
   *  and manual cache clears by reseeding through save→load). Absent only on
   *  legacy caches (purged by the mapCache VERSION bump). */
  builtFp?: string;
}

/** Heavy half of smoothed mode: density warp → topo merge → octi → image merge
 *  → line ordering/untangle. Independent of the label/station toggles, so the
 *  UI caches this on first Generate and redraws cheaply via drawSmoothed when
 *  only those toggles change. Returns a ready SVG string for the degenerate
 *  no-edges fallback instead. */
export function precomputeSmoothed(input: GeoInput): SmoothedPrecomputed | string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const { width, height, padding, dark } = opts;
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  // Provenance stamp (see SmoothedPrecomputed.builtFp): the fingerprint of the
  // EXACT inputs this layout is computed from — the same digest the panel keys
  // its cache on (fingerprintInputs reads only its known fields, so the extra
  // render-only options here don't perturb it).
  const builtFp = fingerprintInputs({
    routes: input.routes,
    tracks: input.tracks ?? [],
    stations: input.stations,
    stationGroups: input.stationGroups,
    geography: input.geography,
    options: input.options,
  } as never).fp;
  // Stage timing (dev): OCTI_PERF=1 logs per-stage wall-clock to stderr so the
  // octi pass can be isolated from topo merge / untangle / render when profiling.
  const lap = makePerfLap();
  // Canonicalize input ORDER by id. The layout's Map/Set insertion order — and
  // thus octi's greedy search PATH — follows the input array order, so the
  // offline dump and the game's live data (iterated in a different order) would
  // otherwise produce DIFFERENT layouts from the SAME network. Sorting by id
  // makes the render order-independent → bit-identical offline and in-game.
  const byId = <T extends { id: string }>(arr: ReadonlyArray<T>): T[] =>
    [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sStations = byId(input.stations as ReadonlyArray<{ id: string }>) as never;
  const sRoutes = byId(input.routes);
  const sTracks = input.tracks ? byId(input.tracks) : input.tracks;
  const sGroups = input.stationGroups ? byId(input.stationGroups) : input.stationGroups;
  const groups = getOrBuildStationGroups(sStations, sGroups);
  // Per-station nodes (BETA — Settings → "Split station complexes", default
  // OFF): platforms of a multi-station complex enter the pipeline at their
  // REAL coordinates instead of being pre-collapsed onto one group point —
  // parallel trunks through Times Sq stay distinct corridors and the capsule
  // joins their stop nodes back into one marker via stopNodes. Off = classic
  // group-center nodes.
  // (dev A/B override: OCTI_GROUP_SPLIT=1 forces on, =0 forces off — pre-toggle
  //  dumps carry no stationSplit option but were captured with the split on, so
  //  reproducing them offline needs =1)
  const envSplit =
    typeof process !== 'undefined' ? envStr('OCTI_GROUP_SPLIT') : undefined;
  const perStationNodes = envSplit === '1' ? true : envSplit === '0' ? false : opts.stationSplit === true;
  const graph = buildTransitGraph(sStations, sRoutes, groups, sTracks, { perStationNodes });
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, smooth: false });
  }
  lap('graphBuild');

  const bounds = (() => {
    const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
    for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
    framePts.push(...geoFramePts(input.geography));
    const b = computeBounds(framePts);
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  // Density-equalizing warp: enlarge crowded parts of the map (the way print
  // NYC subway maps blow up Manhattan) so the octi grid effectively gets finer
  // exactly where the network is dense. The warp wraps the projection, so the
  // network, the water polygons, and every overlay deform through one
  // continuous, provably fold-free mapping; octi runs AFTER the warp, so the
  // output is still perfectly octilinear in screen space.
  // (dev overrides: OCTI_WARP=<alpha> 0 disables; OCTI_MAXSCALE=<n> raises the
  //  local magnification ceiling, default 8 — set high to effectively unlimit;
  //  OCTI_LINECAP=<n> re-caps the per-station line weight, default uncapped so a
  //  hub dilates with its full line fan)
  const baseProj = createProjection(bounds, width, height, padding);
  const warpAlpha = (() => {
    const env =
      envNum('OCTI_WARP');
    if (Number.isFinite(env)) return env; // dev sweep override wins
    if (typeof opts.warpAlpha === 'number' && Number.isFinite(opts.warpAlpha)) return opts.warpAlpha;
    return 0.8;
  })();
  // How hard a single dense locale may magnify. Raised from 3 → 8 so line-rich
  // hubs dilate proportionally to their fan; OCTI_MAXSCALE overrides (set high
  // to effectively unlimit — the warp stays fold-free at any value).
  const warpMaxScale = (() => {
    const env =
      envNum('OCTI_MAXSCALE');
    return Number.isFinite(env) && env > 0 ? env : 12;
  })();
  // Compression floor for the separable warp: stops it from crushing peripheral
  // station spacing below the octi cell, which would contract the sub-cell edges
  // and strand terminus markers (the Newark/Queens edge disconnections). The
  // default 1 floors every local scale to >= 1 — i.e. NO compression — which (the
  // canvas budget being fixed) forces the separable map to the identity: the
  // dense-core magnification then comes entirely from the box layer, with no
  // separable cross and no peripheral compression to disconnect termini. Lower it
  // toward the natural unclamped min (~0.58) to re-admit separable magnification
  // at the cost of edge compression. OCTI_MINSCALE overrides (0 = no floor).
  const warpMinScale = (() => {
    const env =
      envNum('OCTI_MINSCALE');
    return Number.isFinite(env) && env >= 0 ? env : 1;
  })();
  // Per-station warp weight is its line count, UNCAPPED by default so a 10-line
  // interchange outweighs a 4-line one — the old Math.min(4, …) throttle is gone.
  // OCTI_LINECAP re-imposes a finite ceiling for sweeps.
  const warpLineCap = (() => {
    const env =
      envNum('OCTI_LINECAP');
    return Number.isFinite(env) && env >= 1 ? env : Infinity;
  })();
  // Warp mode. DEFAULT 'both' (buildSepDemandBoxWarp): the separable warp
  // supplies the GLOBAL magnification that blows the dense network up to readable
  // size, then the demand-driven box warp (densityBoxWarp.ts) adds LOCAL
  // rectilinear room on the magnified core to declutter it — geography stays
  // faithful elsewhere. The box warp discovers boxes from density peaks ∪
  // predicted octi contraction ∪ predicted capsule collisions (interchange
  // pairs closer than their combined marker-row needs), sizes each box's
  // expansion to exactly what its own targets need (contraction threshold ĉ/2;
  // capsule pair separations), and GROWS the output canvas (up to
  // OCTI_BOX_GROWTH) to absorb the demand instead of clawing it back.
  // OCTI_WARP_MODE=separable = separable only (the proven baseline); =box =
  // box demand only (no global magnification).
  // Box knobs (tune by eye): OCTI_BOX_FRAC (density cutoff as fraction of peak,
  // default 0.4), OCTI_BOX_EXPAND (demand MULTIPLIER; 1 = expand each box by
  // exactly its survival need, >1 magnifies aesthetically, default 1),
  // OCTI_BOX_MARGIN (saturation margin as fraction of box half-extent, default
  // 3), OCTI_BOX_GROWTH (MAX per-axis canvas growth; 1 = canvas-preserving like
  // separable, 2.5 = up to 2.5× bigger; demand past the cap shrinks globally,
  // default 2.5).
  const warpMode =
    typeof process !== 'undefined' ? envStr('OCTI_WARP_MODE') : undefined;
  // boxFrac (density cutoff) takes the user's "Box density cutoff" setting via opts
  // (the env OCTI_BOX_FRAC override still wins for dev sweeps), mirroring boxExpand/boxGrowth.
  const boxFrac = (() => {
    const f = envNum('OCTI_BOX_FRAC');
    if (Number.isFinite(f) && f > 0) return f; // dev sweep override wins
    if (typeof opts.boxFrac === 'number' && Number.isFinite(opts.boxFrac) && opts.boxFrac > 0) return opts.boxFrac;
    return 0.4;
  })();
  // boxExpand / boxGrowth take the user's "Box warp" setting via opts (the env
  // OCTI_BOX_* overrides still win for dev sweeps), mirroring warpAlpha above.
  // boxExpand is now the demand MULTIPLIER (userMult): 1 = expand each box by
  // exactly what its edges need to survive octi contraction; >1 adds aesthetic
  // magnification on top. (Was: absolute expansion factor, default 4.) Any
  // value > 0 is accepted — boxDemand floors the result at 1 internally, so
  // sub-1 multipliers only soften the aesthetic headroom, never invert.
  const boxUserMult = (() => {
    const e = envNum('OCTI_BOX_EXPAND');
    if (Number.isFinite(e) && e > 0) return e; // dev sweep override wins
    if (typeof opts.boxExpand === 'number' && Number.isFinite(opts.boxExpand) && opts.boxExpand > 0) return opts.boxExpand;
    return 1;
  })();
  const boxMargin = Number.isFinite(envNum('OCTI_BOX_MARGIN')) && envNum('OCTI_BOX_MARGIN') > 0 ? envNum('OCTI_BOX_MARGIN') : 3;
  // boxGrowth is now the MAX per-axis canvas growth that absorbs the demanded
  // expansion (2.5 = output canvas may be up to 2.5x the base canvas; demand
  // past the cap shrinks globally). (Was: growthCap with claw-back, default
  // 1.2.) Default 2.5: with the direction-split per-borough boxes the summed
  // demand routinely exceeds the old 2x budget, and the shortfall shows as
  // crushed far-field bands at the canvas edges (difficult-nyc @ bearing 29).
  const boxMaxGrowth = (() => {
    const gv = envNum('OCTI_BOX_GROWTH');
    if (Number.isFinite(gv) && gv >= 1) return gv; // dev sweep override wins
    if (typeof opts.boxGrowth === 'number' && Number.isFinite(opts.boxGrowth) && opts.boxGrowth >= 1) return opts.boxGrowth;
    return 2.5;
  })();
  // Per-station warp weight = (lines through it) × (local crowding):
  //  · LINE term dilates corridor-rich hubs (a West-Seattle fan needs room
  //    proportional to its line fan, not just its station count).
  //  · CROWDING term dilates stretches where consecutive stations are packed
  //    tight — the median neighbour gap over a station's own mean neighbour gap.
  //    The plain count histogram equalizes GLOBAL density, so a pair of close
  //    INTERMEDIATE stations (low line count, off in a sparse area) barely moves
  //    a bin and never gets room; this term makes the warp respond to that local
  //    crowding directly. OCTI_CROWD is the exponent (0 disables → pure line-count).
  const crowdGamma = (() => {
    const env =
      envNum('OCTI_CROWD');
    return Number.isFinite(env) && env >= 0 ? env : 1;
  })();
  const edgeById = new Map<string, (typeof graph.edges)[number]>();
  for (const e of graph.edges) edgeById.set(e.id, e);
  const nodePos = new Map<string, Pixel>();
  for (const n of graph.nodes.values()) nodePos.set(n.id, baseProj.toSVG(n.lngLat));
  // mean projected gap from each node to its graph neighbours (∞ = isolated)
  const meanGap = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    const p = nodePos.get(id)!;
    let sum = 0;
    let cnt = 0;
    for (const eid of graph.adj.get(id) ?? []) {
      const e = edgeById.get(eid);
      if (!e) continue;
      const q = nodePos.get(e.from === id ? e.to : e.from);
      if (!q) continue;
      const dx = p[0] - q[0], dy = p[1] - q[1];
      sum += Math.sqrt(dx * dx + dy * dy); // sqrt is correctly-rounded (hypot is not)
      cnt++;
    }
    meanGap.set(id, cnt ? sum / cnt : Infinity);
  }
  const finiteGaps = [...meanGap.values()].filter((g) => Number.isFinite(g) && g > 0).sort((a, b) => a - b);
  const refGap = finiteGaps.length ? finiteGaps[finiteGaps.length >> 1] : 1;

  const warpSamples: Pixel[] = [];
  const nodeLineCounts: number[] = []; // per nodeIds index — capsule-oracle input
  for (const n of graph.nodes.values()) {
    const p = nodePos.get(n.id)!;
    const lines = new Set<string>();
    for (const eid of graph.adj.get(n.id) ?? []) {
      const e = edgeById.get(eid);
      if (e) for (const l of e.lines) lines.add(l.id);
    }
    const lineWeight = Math.max(1, Math.min(warpLineCap, lines.size));
    nodeLineCounts.push(lines.size);
    const g = meanGap.get(n.id)!;
    // closer-than-median neighbours → boost > 1; farther → < 1; clamped both ways
    // crowdGamma default is 1 → pow(x,1)=x; bypass the (non-correctly-rounded)
    // Math.pow so a 1-ULP diff can't flip the INTEGER Math.round(w) below and
    // reshape the warp histogram. For general gamma, quantize before rounding.
    const crowd =
      crowdGamma > 0 && Number.isFinite(g) && g > 0
        ? Math.min(8, Math.max(0.25, crowdGamma === 1 ? refGap / g : Math.round(Math.pow(refGap / g, crowdGamma) * 1e6) / 1e6))
        : 1;
    const w = Math.max(1, Math.round(lineWeight * crowd));
    for (let i = 0; i < w; i++) warpSamples.push(p);
  }
  // Demand inputs for the box warp: the projected graph as index-pair edges.
  // Node order = graph.nodes insertion order (already id-canonicalized upstream).
  const nodeIds = [...graph.nodes.keys()];
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const boxGraph: BoxGraph = {
    nodes: nodeIds.map((id) => nodePos.get(id)!),
    edges: graph.edges
      .map((e) => [nodeIndex.get(e.from), nodeIndex.get(e.to)] as [number | undefined, number | undefined])
      .filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined),
  };
  // ĉ estimate for the contraction oracle: mirrors the real post-warp
  // cellSize = max(12, medianSupportEdgeLen / divisor). graph edge count is a
  // PROXY for the support edge count (topo merge hasn't run yet); the demand
  // safety factor covers the regime mismatch. Same regimeDivisor helper as the
  // real grid, so the OCTI_DIVISOR override reaches both in dev sweeps.
  const divisorEst = regimeDivisor(graph.edges.length);
  const cellFromMedLen = (m: number) => Math.max(12, m / divisorEst);
  const warpBox = { minX: 0, minY: 0, maxX: width, maxY: height };
  // Capsule-demand oracle (spec 2026-07-02): marker geometry constants +
  // per-node line counts. OCTI_CAPS_MARGIN / OCTI_CAPS_CASING override the
  // per-capsule slack / inter-capsule clearance for dev sweeps.
  const capsMargin = Number.isFinite(envNum('OCTI_CAPS_MARGIN')) && envNum('OCTI_CAPS_MARGIN') >= 0 ? envNum('OCTI_CAPS_MARGIN') : 4;
  const capsCasing = Number.isFinite(envNum('OCTI_CAPS_CASING')) && envNum('OCTI_CAPS_CASING') >= 0 ? envNum('OCTI_CAPS_CASING') : 8;
  const boxOpts = {
    frac: boxFrac,
    marginFrac: boxMargin,
    userMult: boxUserMult,
    maxGrowth: boxMaxGrowth,
    cellFromMedLen,
    capsule: { spacing: LINE_WIDTH + LINE_GAP, lineCounts: nodeLineCounts, margin: capsMargin, casing: capsCasing },
  };
  const sepOpts = { alpha: warpAlpha, maxScale: warpMaxScale, minScale: warpMinScale };
  // Capture the dense boxes the warp magnified (box/both modes), in the warp's
  // OUTPUT space, plus per-box expands for the debug overlay/log.
  const warpOut: { boxes?: DenseBox[]; expands?: number[] } = {};
  // Per-axis canvas growth granted by the demand warp (1,1 for non-box modes).
  let warpGrowth: [number, number] = [1, 1];
  const warp = (() => {
    if (warpMode === 'separable') return buildDensityWarp(warpSamples, warpBox, sepOpts);
    const r =
      warpMode === 'box'
        ? buildDemandBoxWarp(warpSamples, boxGraph, warpBox, boxOpts, warpOut)
        : buildSepDemandBoxWarp(warpSamples, boxGraph, warpBox, sepOpts, boxOpts, warpOut); // default 'both'
    warpGrowth = [r.growthX, r.growthY];
    return r.warp;
  })();
  // The REAL output canvas: base canvas × granted growth. Everything downstream
  // (refit target, land base, viewBox, export frame, pre.width/height) uses the
  // grown dims, so the demanded room is kept instead of clawed back.
  const outW = Math.round(width * warpGrowth[0]);
  const outH = Math.round(height * warpGrowth[1]);
  let proj: Projection = {
    ...baseProj,
    // The composed projection renders onto the GROWN canvas — carry outW/outH,
    // not baseProj's pre-growth dims: projectedBounds clamps frames to
    // proj.width/height, so a stale 2700 here truncates geoBboxFrame and the
    // export frame to the pre-growth box whenever the warp granted growth.
    width: outW,
    height: outH,
    toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)),
  };
  // The per-axis refit applied below (identity until set), reused to map the warp
  // boxes from warp-output px on to final render px.
  let refitPx: (p: Pixel) => Pixel = (p) => p;
  // Re-fit to the WARPED content extent. The warp pushes content outward, and the
  // geography (which reaches past the network) can land OUTSIDE the [0,width]
  // canvas — where the land-base rect, viewBox and export frame don't reach, so
  // it renders on the panel's black void when you pan/zoom out. The pre-warp
  // `bounds` can't know how far the warp expands, so measure it AFTER warping:
  // take the bbox of every drawn thing (network nodes + edge courses + water/
  // green vertices) and rescale it per axis back inside the canvas, with a small
  // margin for edge labels. Now the background and frame cover all the warp made.
  {
    const pts: Pixel[] = [];
    for (const n of graph.nodes.values()) pts.push(proj.toSVG(n.lngLat));
    for (const e of graph.edges) if (e.geo) for (const c of e.geo) pts.push(proj.toSVG(c));
    if (input.geography) {
      for (const feats of [input.geography.water, input.geography.green]) {
        for (const f of feats) {
          if (f.geometry.type !== 'Polygon') continue;
          for (const ring of f.geometry.coordinates) for (const c of ring) pts.push(proj.toSVG(c));
        }
      }
    }
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const p of pts) {
      if (p[0] < mnX) mnX = p[0];
      if (p[0] > mxX) mxX = p[0];
      if (p[1] < mnY) mnY = p[1];
      if (p[1] > mxY) mxY = p[1];
    }
    // Detail-area crops: the stamped bbox IS the deliverable frame (the drawn
    // box's geographic preimage). Frame the canvas on THAT rect, padded by a
    // proportional margin, instead of the content bbox. The one-hop ring
    // stations and their track courses reach arbitrarily far outside the drawn
    // region and would otherwise squash the frame to a sliver of the canvas
    // (wrong aspect) or push it off-canvas entirely (a clamped frame makes the
    // popout show a truncated region). Proportional per-axis padding keeps
    // frame aspect == canvas aspect == the drawn box's aspect, and the margin
    // shows the margin-clipped geography continuing past the frame edge just
    // like the main map. Ring content beyond the margin draws off-canvas, which
    // is harmless: the popout's viewBox is the frame. (See SchematicOptions.detailCrop.)
    if (opts.detailCrop && input.geography) {
      const [g0, g1, g2, g3] = input.geography.bbox;
      let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
      for (const c of [[g0, g1], [g2, g1], [g2, g3], [g0, g3]] as Coordinate[]) {
        const p = proj.toSVG(c);
        if (p[0] < fx0) fx0 = p[0];
        if (p[0] > fx1) fx1 = p[0];
        if (p[1] < fy0) fy0 = p[1];
        if (p[1] > fy1) fy1 = p[1];
      }
      if (fx0 < fx1 && fy0 < fy1) {
        const pad = 0.25; // per-axis margin fraction (< cropSubgraph's geo clip pad)
        mnX = fx0 - (fx1 - fx0) * pad;
        mxX = fx1 + (fx1 - fx0) * pad;
        mnY = fy0 - (fy1 - fy0) * pad;
        mxY = fy1 + (fy1 - fy0) * pad;
      }
    }
    if (mnX < mxX && mnY < mxY) {
      const m = 0; // flush fill: content reaches the canvas edge (the panel zooms for labels)
      const sx = (outW * (1 - 2 * m)) / (mxX - mnX);
      const sy = (outH * (1 - 2 * m)) / (mxY - mnY);
      const ox = outW * m - mnX * sx;
      const oy = outH * m - mnY * sy;
      const inner = proj;
      proj = { ...inner, toSVG: (c: Coordinate) => { const p = inner.toSVG(c); return [p[0] * sx + ox, p[1] * sy + oy]; } };
      refitPx = (p: Pixel) => [p[0] * sx + ox, p[1] * sy + oy];
    }
  }
  // Map the captured warp boxes (warp-output px) through the same refit to final
  // render px (the space stationPx live in). Per-axis monotone, so it stays axis-aligned.
  const denseBoxesPx: DenseBox[] = (warpOut.boxes ?? []).map((b) => {
    const a = refitPx([b.x0, b.y0]);
    const c = refitPx([b.x1, b.y1]);
    return { x0: a[0], y0: a[1], x1: c[0], y1: c[1] };
  });
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

  // Inverse of the warped projection (render pixel -> geographic coord). The whole
  // chain (equirect base -> separable density warp -> per-axis box-expand ->
  // per-axis refit rescale) is separable and strictly increasing per axis, so
  // invert each axis independently by bisection: render-x depends only on lng
  // (increasing), render-y only on lat (decreasing, north at the top). The search
  // brackets a ±100%-padded `bounds` so any on-canvas pixel is covered (the
  // projection extrapolates monotonically past the bounds). The magnifier inset
  // uses this to turn the drawn box into the geographic region to crop on.
  const unproject = ((): ((p: Pixel) => Coordinate) => {
    const [lo0, la0, lo1, la1] = bounds;
    const dLo = lo1 - lo0 || 1e-6;
    const dLa = la1 - la0 || 1e-6;
    const loLng = lo0 - dLo, hiLng = lo1 + dLo;
    const loLat = la0 - dLa, hiLat = la1 + dLa;
    const midLat = (la0 + la1) / 2, midLng = (lo0 + lo1) / 2;
    return ([px, py]: Pixel): Coordinate => {
      let a = loLng, b = hiLng;
      for (let i = 0; i < 44; i++) { const m = (a + b) / 2; if (proj.toSVG([m, midLat])[0] < px) a = m; else b = m; }
      let c = loLat, d = hiLat;
      for (let i = 0; i < 44; i++) { const m = (c + d) / 2; if (proj.toSVG([midLng, m])[1] > py) c = m; else d = m; }
      return [(a + b) / 2, (c + d) / 2];
    };
  })();
  // Where the geography bbox lands in this render. Frames the inset on exactly
  // the selected region. Separable warp => the four bbox corners give the extent.
  const gbb = input.geography?.bbox;
  const geoBboxFrame = gbb
    ? projectedBounds(proj, [[gbb[0], gbb[1]], [gbb[2], gbb[1]], [gbb[2], gbb[3]], [gbb[0], gbb[3]]]) ?? undefined
    : undefined;

  const env = typeof process !== 'undefined' ? (process as { env?: Record<string, string> }).env : undefined;
  if (env?.OCTI_WARP_DEBUG || env?.OCTI_WARP_CAPTURE_ONLY) {
    const ids = [...graph.nodes.keys()];
    const idx = new Map(ids.map((id, i) => [id, i]));
    const nodes = ids.map((id) => graph.nodes.get(id)!.pos as Pixel);
    const nodesRaw = ids.map((id) => baseProj.toSVG(graph.nodes.get(id)!.lngLat) as Pixel);
    const edges = [...graph.edges]
      .map((e) => [idx.get(e.from), idx.get(e.to)] as [number | undefined, number | undefined])
      .filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);
    __warpDebug = { warp, width: outW, height: outH, nodes, nodesRaw, edges, samples: warpSamples.map((s) => [s[0], s[1]] as Pixel) };
    // Skip the octi pass: dev/warp-preview.ts only needs the captured warp
    // inputs to render a fast no-octi preview while tuning the warp.
    if (env?.OCTI_WARP_CAPTURE_ONLY) return 'CAPTURE_ONLY';
  }

  // LOOM topo merge: collapse geographically parallel transit edges into
  // single support edges carrying the union of their line ids (Brosi & Bast
  // 2024 §"Network Topology Extraction"). With bundling solved at the GRAPH
  // level, octi routes each merged corridor as ONE octilinear path and the
  // per-edge offset model (orderLines + computeCanonicalOffsets) lanes the
  // co-running lines into parallel ribbons, with no post-hoc grid-segment fix-up.
  //
  // dHat (the merge-distance threshold) is fixed at 4× line width in pixels.
  // The paper's 2.5·w·c formula explodes at high line counts and
  // collapses the map. A fixed pixel target reliably catches geographically
  // parallel corridors without merging unrelated nearby edges. See
  // dev/_diag-topo-octi.ts for the sweep.
  // (dev diagnostic, default off: OCTI_DHAT=<px> overrides the fixed merge
  // radius for LOOM-parity sweeps, see dev/_parity-dhat-sweep.ts. Unset in
  // production, so behavior is unchanged.)
  const dHatEnv =
    envNum('OCTI_DHAT');
  // dHat is a corridor-merge radius, not a stroke property: pinned >= 16px so
  // thinner theme line widths don't shrink the tuned merge radius.
  const dHat =
    Number.isFinite(dHatEnv) && dHatEnv > 0 ? dHatEnv : Math.max(16, theme.lineWidth * 4);
  // (dev diagnostic, default off: OCTI_ROUNDS=<n> caps the merge rounds. It
  // isolates round-2+ drift zips (averaged geometry creeping corridors within
  // dHat of each other between rounds) from round-1 geometry-true collapses.)
  const roundsEnv =
    envNum('OCTI_ROUNDS');
  const topoParams: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: Number.isFinite(roundsEnv) && roundsEnv > 0 ? roundsEnv : 8,
    stationCandidateRadius: 2 * dHat,
  };
  lap('warpBuild');
  auditTraversals(
    'graph',
    graph.lineTraversals,
    (id) => graph.edges.find((e) => e.id === id),
    (nid) => graph.nodes.get(nid)?.pos,
    (lid) => { for (const e of graph.edges) { const l = e.lines.find((x) => x.id === lid); if (l?.label) return l.label; } return lid.slice(0, 8); },
  );
  auditZigzags(
    'graph',
    graph.lineTraversals,
    (id) => graph.edges.find((e) => e.id === id),
    (nid) => graph.nodes.get(nid)?.pos,
    (lid) => { for (const e of graph.edges) { const l = e.lines.find((x) => x.id === lid); if (l?.label) return l.label; } return lid.slice(0, 8); },
  );
  // dev: OCTI_AUDIT_BOX also dumps the TRANSIT graph (pre-merge) in the box:
  // original node ids, stop flags, and each incident edge's lines + geometry,
  // so support-stage defects can be diffed against what the merge was given.
  auditBoxTransit(graph, env?.OCTI_AUDIT_BOX ?? '');
  const support = buildSupportGraph(graph, groups, topoParams);
  auditTraversals(
    'support',
    support.lineTraversals,
    (id) => support.edges.get(id),
    (nid) => support.nodes.get(nid)?.pos,
    (lid) => support.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );
  auditZigzags(
    'support',
    support.lineTraversals,
    (id) => support.edges.get(id),
    (nid) => support.nodes.get(nid)?.pos,
    (lid) => support.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );
  lap('topoMerge');
  const medLen = medianEdgeLength(support);
  const octiOpts = { ...DEFAULT_OCTI_OPTIONS };
  // Grid fineness vs contraction: octi contracts away everything shorter
  // than half a cell, so a coarser grid both merges noisy station clusters
  // into single skeleton nodes AND leaves each surviving node more breathing
  // room per cell. Two regimes:
  //  - metro-scale (hundreds of support edges): a finer grid
  //    (divisor 1.6) resolves congested downtowns without detours;
  //  - bus-scale (thousands of edges, mega-hubs): a fine grid
  //    lets corridors NEST in concentric rings around hubs and explodes
  //    routing time. LOOM defaults to ~100% of station spacing. Coarse
  //    grids force clean radial fans and are fast.
  // (dev override: OCTI_DIVISOR for tuning sweeps)
  // Divisor 1.6 for metro-scale graphs spreads adjacent corridors to
  // >= 1 cell so unmerged parallels read as separate lines instead of a
  // crammed band. Larger divisors stay compressed; too small a divisor
  // reintroduces spiral wraps at terminal loops.
  // The threshold + constants live in regimeDivisor, which is also mirrored
  // pre-warp as `divisorEst` (box-warp contraction oracle), so both stay in
  // sync and the OCTI_DIVISOR override reaches both.
  const divisor = regimeDivisor(support.edges.size);
  octiOpts.cellSize = Math.max(12, medLen / divisor);
  // (dev A/B pin: OCTI_CELL=<px> fixes the grid cell absolutely, so upstream
  //  structural changes are measured on the SAME ruler instead of re-rolling
  //  the layout through the medLen -> cellSize feedback. Unset in production.)
  const cellEnv = Number(env?.OCTI_CELL);
  if (Number.isFinite(cellEnv) && cellEnv > 0) octiOpts.cellSize = cellEnv;
  traceCellSize(octiOpts.cellSize, medLen, divisor);
  // (dev diagnostic, default off: OCTI_NO_COMBINE=1 disables octi's deg-2
  // collapse so every station node is placed by the octilinearizer itself)
  if (
    envStr('OCTI_NO_COMBINE') === '1'
  ) {
    octiOpts.combineDeg2 = false;
  }
  // Geographic-course enforcement (LOOM's -G enfGeoPen). With zero
  // affinity octi pays nothing for abandoning real corridor courses and bends
  // radial fans into nested parallel U-wraps. 0.05 restores the
  // diverging branches at identical violation count and runtime, while larger
  // values over-constrain (terminal rings return). The density warp is
  // load-bearing: disabling it snarls the core.
  // (dev override: OCTI_AFFINITY=<n> for sweeps)
  octiOpts.geographicAffinity =
    typeof opts.geographicAffinity === 'number' && Number.isFinite(opts.geographicAffinity)
      ? opts.geographicAffinity
      : 0.05;
  const affEnv =
    envNum('OCTI_AFFINITY');
  if (Number.isFinite(affEnv) && affEnv > 0) {
    octiOpts.geographicAffinity = affEnv; // dev sweep override wins
  }
  // (dev override: OCTI_DENSITY=<n> for sweeps. The chain spring weight that
  // resists drawing a deg-2 station chain on fewer grid hops than it has
  // stations. Default 0.5; higher resists vertical corridor compression but
  // risks switchback zigzags.)
  const denEnv =
    envNum('OCTI_DENSITY');
  if (Number.isFinite(denEnv) && denEnv >= 0) {
    octiOpts.penalties = { ...(octiOpts.penalties ?? {}), densityPen: denEnv };
  }
  // Node-displacement penalty (LOOM default 0.5). Raising it DOES preserve the
  // density warp's vertical spread that octi otherwise compresses out,
  // but ndMovePen tethers ABSOLUTE positions, so it equally forces geographic
  // ANGLES, which staircases dense junctions: high values snap edges horizontal
  // and jam band-exchanges onto short stubs (jagged sawtooth). No global
  // value threads both (every value that spreads piled stations also jags
  // dense junctions). The real fix is a longitudinal length-preservation term:
  // preserve corridor LENGTHS / relative spacing, leave angles free (TODO).
  // Left at default; OCTI_NDMOVE=<n> stays as a dev override for experiments.
  const ndmEnv =
    envNum('OCTI_NDMOVE');
  if (Number.isFinite(ndmEnv) && ndmEnv >= 0) {
    octiOpts.penalties = { ...(octiOpts.penalties ?? {}), ndMovePen: ndmEnv };
  }
  // Length preservation: penalize a drawn corridor whose endpoint chord
  // undershoots its warped geographic chord, so octi keeps the density warp's
  // spacing where it would otherwise compress it out. Unlike ndMovePen it
  // preserves spacing without pinning absolute positions, giving a
  // more-vertical layout. Weight saturates at low values. OCTI_LENPRES=<n> overrides.
  octiOpts.lenPresW = 1.5;
  // Same-cell collapse: anchorGraphStops re-splits corridors at stop positions
  // AFTER the merge's short-edge contraction, so synthetic junctions can land
  // inside a station's grid cell. Sub-cell edges whose endpoints then need
  // DISTINCT cells force the router into multi-cell detours (a short edge drawn
  // as a long C, a closed-loop artifact).
  // Weld sub-cell node clusters into one node (station survives) before octi
  // sees them. Threshold = half a cell, the same resolution the octi
  // contraction uses. (dev override: OCTI_WELD=<px>, 0 disables)
  // dev: OCTI_AUDIT=1 gives a short-edge census at the octi seam (the
  // router-facing degeneracy picture: edges below half a cell cannot get distinct cells).
  const shortEdgeCensus = makeShortEdgeCensus(support, octiOpts.cellSize);
  shortEdgeCensus('pre-weld');
  {
    const weldEnv = Number(env?.OCTI_WELD);
    const weldDist = Number.isFinite(weldEnv) && weldEnv >= 0 ? weldEnv : octiOpts.cellSize / 2;
    if (weldDist > 0) {
      const welds = weldSubCellNodes(support, weldDist);
      traceWeld(welds, weldDist);
      if (welds > 0) {
        shortEdgeCensus('post-weld');
        // The weld remaps traversals over fused nodes. Chord reversals born
        // HERE would be invisible without a census between weld and octi
        // and could get mis-attributed to the drawn-level merge.
        auditZigzags(
          'postWeld',
          support.lineTraversals,
          (id) => support.edges.get(id),
          (nid) => support.nodes.get(nid)?.pos,
          (lid) => support.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
        );
      }
    }
  }
  lap('octiSetup');
  // dev: OCTI_AUDIT_BOX="x0,y0,x1,y1" dumps pre-octi support nodes in the box
  // (id, position, station?, degree) plus sub-cell node pairs, the router
  // congestion picture octi actually faces.
  auditBoxSupport(support, octiOpts.cellSize, env?.OCTI_AUDIT_BOX ?? '');
  const imageRaw = octi(support, octiOpts);
  // dev: OCTI_AUDIT_LINE=<label> dumps a line's support traversal with octi
  // placement/path status per edge (which edge lost its grid path, and where).
  auditLine(support, imageRaw, env?.OCTI_AUDIT_LINE);
  lap('octi');
  // 'placed' census: the SAME traversals as postWeld, measured at octi's
  // node placements. A reversal appearing here (and not at postWeld) is
  // PLACEMENT-born, a real curve flattened into degenerate angles, while
  // one appearing only at mergeOnly is manufactured by the merge remap.
  auditZigzags(
    'placed',
    support.lineTraversals,
    (id) => support.edges.get(id),
    (nid) => imageRaw.placement.get(nid) ?? support.nodes.get(nid)?.pos,
    (lid) => support.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );

  // LOOM Drawing::getLineGraph: octi's relaxed constraints let two support
  // edges share grid segments; consolidate coincident runs into single edges
  // carrying the union of lines so the renderer fans them into a bundle
  // instead of drawing one line invisibly on top of the other.
  const merged = mergeCoincidentPaths(support, imageRaw);
  auditTraversals(
    'mergeOnly',
    merged.h.lineTraversals,
    (id) => merged.h.edges.get(id),
    (nid) => merged.img.placement.get(nid) ?? merged.h.nodes.get(nid)?.pos,
    (lid) => merged.h.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );
  auditZigzags(
    'mergeOnly',
    merged.h.lineTraversals,
    (id) => merged.h.edges.get(id),
    (nid) => merged.img.placement.get(nid) ?? merged.h.nodes.get(nid)?.pos,
    (lid) => merged.h.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );
  lap('mergeCoincident');
  // A station the solver placed off its course draws both incident edges
  // through one shared approach; the merge above turns that into a stub the
  // course retraces, and a stop pins it against the later hook splice (a
  // mid-route station renders as a fake branch tip). Collapse such stubs
  // back onto the fold base; support-level retraces (real branch tips and
  // terminus platforms) keep their stubs.
  collapseFoldStubs(merged.h, merged.img, support, (nid) => imageRaw.placement.get(nid) ?? support.nodes.get(nid)?.pos);
  // Distinct station groups fused onto one drawn node (converged corridors +
  // octi contraction) get separate markers again when their true separation
  // exceeds the merge radius; closer pairs stay a shared interchange capsule.
  separateFusedStations(merged.h, merged.img, dHat);
  const supportM = merged.h;
  const image = merged.img;
  auditTraversals(
    'mergeCoincident',
    supportM.lineTraversals,
    (id) => supportM.edges.get(id),
    (nid) => image.placement.get(nid) ?? supportM.nodes.get(nid)?.pos,
    (lid) => supportM.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );
  auditZigzags(
    'mergeCoincident',
    supportM.lineTraversals,
    (id) => supportM.edges.get(id),
    (nid) => image.placement.get(nid) ?? supportM.nodes.get(nid)?.pos,
    (lid) => supportM.lineRefs.get(lid)?.label ?? lid.slice(0, 8),
  );

  // Build a Layout from the merged support graph, then override node positions
  // with octi's grid placement and edge paths with its routed octilinear
  // polylines. Each layout edge already carries the union of merged line ids.
  const { layout, nodePx } = supportToLayout(supportM);
  layout.nodeSeq = nodeSeqFromSupport(supportM, graph.numberByGroup);
  for (const n of layout.nodes.values()) {
    const placed = image.placement.get(n.id);
    if (placed) {
      n.cell = [placed[0], placed[1]] as Cell;
      nodePx.set(n.id, placed);
    }
  }
  // Bridge for the magnifier's box-picking: input station id -> render position.
  // Drawn markers use derived support-node ids, so map each input station through
  // its group's support node to a pixel the UI can hit-test against the drawn box.
  const groupById = new Map((groups as { id: string; stationIds?: string[] }[]).map((g) => [g.id, g]));
  const stationPx = new Map<string, Pixel>();
  for (const [gid, sp] of supportM.stations) {
    const px = nodePx.get(sp.nodeId);
    if (!px) continue;
    for (const sid of groupById.get(gid)?.stationIds ?? []) stationPx.set(sid, [px[0], px[1]]);
  }
  for (const e of layout.edges) {
    const routed = image.paths.get(e.id);
    if (routed) e.path = routed.map((p) => [p[0], p[1]] as Cell);
  }
  // Remove mid-route out-and-back spur steps from line traversals: the merge
  // can pin a line's course onto a neighbouring corridor it merely crosses
  // for a few px, leaving an immediate edge+reverse pair in the traversal
  // whose drawn lane dead-ends as a stub. Drop such pairs when the line has no
  // stop at the spur's far node. A terminus retrace keeps its steps (its flag
  // is set).
  {
    const eById = new Map(layout.edges.map((e) => [e.id, e]));
    let spurDrops = 0;
    for (const [lineId, trav] of layout.lineTraversals) {
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i + 1 < trav.length; i++) {
          const a = trav[i];
          const b = trav[i + 1];
          if (a.edgeId !== b.edgeId || a.reversed === b.reversed) continue;
          const e = eById.get(a.edgeId);
          if (!e) continue;
          const stop = e.stops.get(lineId);
          const flagAtFar = a.reversed ? !!stop?.atFrom : !!stop?.atTo;
          if (flagAtFar) continue;
          trav.splice(i, 2);
          spurDrops++;
          changed = true;
          break;
        }
      }
    }
    auditSpurDrops(spurDrops);
  }
  auditTraversals(
    'spurCleanup',
    layout.lineTraversals,
    (id) => layout.edges.find((e) => e.id === id),
    (nid) => nodePx.get(nid),
    (lid) => { for (const e of layout.edges) { const l = e.lines.find((x) => x.id === lid); if (l?.label) return l.label; } return lid.slice(0, 8); },
  );
  // Suppress zero-progress synthetic hooks (triangles / hairpins): the
  // topo merge can route a line's bundle down a shared lane to a synthetic
  // junction and fan back, drawing a closed triangle / hairpin purely through
  // non-station nodes. Splice an octilinear shortcut past such folds. Runs
  // AFTER the spur-step cleanup and BEFORE orderLines (lanes don't exist yet).
  {
    const ratioEnv = envNum('OCTI_HOOK_RATIO');
    const foldEnv = envNum('OCTI_HOOK_FOLD');
    const hookOpts: { ratio?: number; fold?: number } = {};
    if (Number.isFinite(ratioEnv) && ratioEnv > 0) hookOpts.ratio = ratioEnv;
    if (Number.isFinite(foldEnv)) hookOpts.fold = foldEnv;
    const { spliced } = suppressHooks(layout, hookOpts);
    traceHooks(spliced);
    auditTraversals(
      'hooks',
      layout.lineTraversals,
      (id) => layout.edges.find((e) => e.id === id),
      (nid) => nodePx.get(nid),
      (lid) => { for (const e of layout.edges) { const l = e.lines.find((x) => x.id === lid); if (l?.label) return l.label; } return lid.slice(0, 8); },
    );
    auditZigzags(
      'hooks',
      layout.lineTraversals,
      (id) => layout.edges.find((e) => e.id === id),
      (nid) => nodePx.get(nid),
      (lid) => { for (const e of layout.edges) { const l = e.lines.find((x) => x.id === lid); if (l?.label) return l.label; } return lid.slice(0, 8); },
    );
  }
  // Line conservation audit: every intake line that had a traversal must still
  // have a non-empty traversal after the merge and its cleanups, or the map is
  // silently missing a whole line. The render continues, but the loss is
  // reported loudly so it can never ship unnoticed.
  for (const [lid, steps] of graph.lineTraversals) {
    if (steps.length === 0) continue;
    const out = layout.lineTraversals.get(lid);
    if (!out || out.length === 0) {
      let label = lid;
      for (const e of graph.edges) {
        const l = e.lines.find((x) => x.id === lid);
        if (l?.label) { label = l.label; break; }
      }
      console.error('[ImprovedSchematics] merge dropped line "' + label + '" (no drawn course survives)');
    }
  }
  orderLines(layout);
  // capsule rule counts only SERVED members: a routeless platform in a
  // group must not promote it to an interchange capsule
  const served = servedStationIds(input.stations, input.routes);
  const servedMembers = new Map<string, number>();
  for (const g of groups) {
    servedMembers.set(g.id, g.stationIds.filter((id) => served.has(id)).length);
  }
  // Line ordering: bundle-blocks structural ordering (bundleOrder.ts).
  // Corridors carry rigid recursive blocks. Order changes exist only at
  // bundle joins/splits and cycle residuals, all at junctions by
  // construction. The prior untangle scorer it replaced lives in
  // old/src/render/layout/untangle.ts. OCTI_NO_UNTANGLE=1 skips ordering
  // entirely (barycenter seed only, diagnostic).
  if (
    !(
      envStr('OCTI_NO_UNTANGLE') === '1'
    )
  ) {
    orderByBlocks(layout);
    // Same-section twist rescue: a swap that landed at a straight-through
    // node migrates along the pair's co-bundled stretch to the nearest
    // branch (preferred) or >=45deg turn. OCTI_TWIST_RESCUE=0 disables.
    rescueTwists(layout);
  }
  lap('untangle');

  // The support graph carries no lngLat for renderRibbons' affine map, so
  // project the geography rings here through the real (warped) projection, so
  // water + parks deform with the network, and store them on the pre. The
  // BACKDROP is built from them at draw time (drawSmoothed), which is what lets
  // the landmass style re-render as a cheap repaint instead of a re-sim.
  const geoRingsPx = projectGeoRings(input.geography, proj, theme, dark);
  // Data-region hull to render px: sample each hull edge densely (the warp
  // bends straight edges into curves) through the final projection.
  let geoHullPx: Pixel[] | undefined;
  const hull = input.geography?.hull;
  if (hull && hull.length >= 3) {
    const SAMPLES = 24;
    geoHullPx = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      for (let s = 0; s < SAMPLES; s++) {
        const t = s / SAMPLES;
        const p = proj.toSVG([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        geoHullPx.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
      }
    }
  }
  const gridSvg = opts.showGrid ? buildOctiGridSvg(buildOctiGrid(pixelBounds(nodePx), image.cellSize), dark) : '';
  const stations = [...supportM.stations.values()].map((st) => ({
    nodeId: st.nodeId,
    members: Math.max(1, servedMembers.get(st.id) ?? st.members ?? 1),
    stopNodes: st.stopNodes ?? new Map<string, string>(),
  }));

  // Frame on the furthest water/green through the WARPED proj, so smoothed
  // fit/export hug the same backdrop extent geographic does. When undefined (no
  // geography), renderRibbons frames on the rendered network instead.
  const frame = geographyFrame(input.geography, proj) ?? undefined;

  return { layout, nodePx, stationPx, stations, gridOverlay: gridSvg, geoRingsPx, geoHullPx, width: outW, height: outH, dark, frame, unproject, geoBboxFrame, denseBoxesPx, builtFp };
}

/** Per-pre memo of the last-built backdrop (keyed by the landmass style), so
 *  toggling labels/stations doesn't re-run the union+trace pass. WeakMap: never
 *  serialized, dies with the pre. */
const lmBackdropCache = new WeakMap<SmoothedPrecomputed, { key: string; svg: string }>();

/** Station markers that sit on LAND in the faithful geography (checked against
 *  a fine raster of the raw water rings). The landmass stylizer must never
 *  move a shoreline over one of these (LandmassStyle.dryPoints). Stations
 *  already on water in the faithful render are the network's own doing and are
 *  left alone. Memoized per pre. */
const dryStationsCache = new WeakMap<SmoothedPrecomputed, Pixel[]>();
function dryStations(pre: SmoothedPrecomputed): Pixel[] {
  const cached = dryStationsCache.get(pre);
  if (cached) return cached;
  const out: Pixel[] = [];
  const water = pre.geoRingsPx?.water;
  if (water && water.length > 0) {
    const r = rasterizeRings(water, { w: pre.width, h: pre.height }, 4);
    if (r) {
      for (const p of pre.stationPx.values()) {
        const cx = Math.floor((p[0] - r.gx0) / r.cell);
        const cy = Math.floor((p[1] - r.gy0) / r.cell);
        // Protection-biased: a station is WET only when its whole 3x3 cell
        // neighbourhood is water. Markers a few px inside a faithful shore
        // still count dry, so the raster quantization can't leak one into the
        // styled water. Genuinely mid-water stations stay wet (untouched).
        let wet = true;
        for (let dy = -1; dy <= 1 && wet; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= r.W || y >= r.H || r.grid[y * r.W + x] !== 1) { wet = false; break; }
          }
        }
        // The raster fills over sub-cell islands: a station on a tiny island
        // reads wet here but is really on land. The wet set is small, so
        // confirm each with an exact winding test over the raw rings.
        if (wet && windingAt(water, p[0], p[1]) === 0) wet = false;
        if (!wet) out.push([p[0], p[1]]);
      }
    }
  }
  dryStationsCache.set(pre, out);
  return out;
}

/** Local-importance field for the landmass stylizer: 1 inside the warp's own
 *  demand boxes (density ∪ contraction ∪ capsule, the regions the warp judged
 *  heavily used and magnified), plus a station-density kernel so clusters of
 *  stops protect their surroundings even when no box fired there. The stylizer
 *  divides its simplify/cull thresholds by (1+3·imp)², so geography inside the
 *  dense core keeps its shape while the far periphery generalizes to blobs.
 *  Coarse grid lookup, built once per styled draw (memoized with the
 *  backdrop). */
export function buildImportance(pre: SmoothedPrecomputed): (x: number, y: number) => number {
  const scale = Math.min(pre.width, pre.height) / 2700;
  const cell = 48 * scale;
  const W = Math.max(1, Math.ceil(pre.width / cell));
  const H = Math.max(1, Math.ceil(pre.height / cell));
  const g = new Float32Array(W * H);
  // Station kernel: cone of radius R; ~4 overlapping stations = full importance.
  const R = 220 * scale;
  const rc = Math.ceil(R / cell);
  for (const p of pre.stationPx.values()) {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    for (let y = cy - rc; y <= cy + rc; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - rc; x <= cx + rc; x++) {
        if (x < 0 || x >= W) continue;
        const dx = (x + 0.5) * cell - p[0];
        const dy = (y + 0.5) * cell - p[1];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < R) g[y * W + x] += (1 - d / R) / 4;
      }
    }
  }
  // The warp's demand boxes (padded): full importance inside.
  const PAD = 60 * scale;
  for (const b of pre.denseBoxesPx ?? []) {
    const x0 = Math.max(0, Math.floor((b.x0 - PAD) / cell));
    const x1 = Math.min(W - 1, Math.floor((b.x1 + PAD) / cell));
    const y0 = Math.max(0, Math.floor((b.y0 - PAD) / cell));
    const y1 = Math.min(H - 1, Math.floor((b.y1 + PAD) / cell));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (g[i] < 1) g[i] = 1;
      }
    }
  }
  return (x, y) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 0;
    const v = g[cy * W + cx];
    return v > 1 ? 1 : v;
  };
}

/** Light half of smoothed mode: draw a precomputed layout. Cheap relative to
 *  precomputeSmoothed. This is what re-runs when labels/stations toggle. */
export function drawSmoothed(
  pre: SmoothedPrecomputed,
  opts: { showLabels: boolean; showStations: boolean; megaFallback?: 'box' | 'curve'; landmass?: LandmassParams; stationDesign?: string },
  sceneOut?: SceneOut,
): string {
  // Draw-time backdrop: faithful polygons by default, simplified landmass blobs
  // when the style is on. Params come in base-2700 px, rescaled to this canvas
  // so a grown map keeps the same visual character. Older pres (no geoRingsPx)
  // still carry the water baked inside gridOverlay and just skip the style.
  const lm = opts.landmass;
  const scale = Math.min(pre.width, pre.height) / 2700;
  const style = lm
    ? {
        simplifyPx: lm.simplify * scale,
        roundPx: lm.round * scale,
        minAreaPx2: lm.minArea * scale * scale,
        octi: lm.octi,
        importance: buildImportance(pre),
        dryPoints: dryStations(pre),
        dryMarginPx: 14 * scale,
        hullPx: pre.geoHullPx,
      }
    : undefined;
  // The styled build unions + retraces the whole geography (~100ms on a big
  // city), so memoize per (pre, style) so label/station toggles just repaint.
  const lmKey = style ? JSON.stringify(style) : '';
  const cached = lmBackdropCache.get(pre);
  let backdrop: string;
  if (cached && cached.key === lmKey) backdrop = cached.svg;
  else {
    backdrop = pre.geoRingsPx ? backdropFromRings(pre.geoRingsPx, { w: pre.width, h: pre.height }, style) : '';
    lmBackdropCache.set(pre, { key: lmKey, svg: backdrop });
  }
  const args = {
    layout: pre.layout,
    nodePx: pre.nodePx,
    edgePolyline: (e: Layout['edges'][number]) => e.path.map((c) => [c[0], c[1]] as Pixel),
    width: pre.width,
    height: pre.height,
    dark: pre.dark,
    showLabels: opts.showLabels,
    showStations: opts.showStations,
    megaFallback: opts.megaFallback ?? 'curve',
    stationDesign: opts.stationDesign,
    backdrop,
    gridOverlay: pre.gridOverlay,
    stations: pre.stations,
    frame: pre.frame,
  };
  // The expensive marker-placement geometry is toggle-independent: compute it once
  // and memoize on `pre`, so label/station toggles (and cache reads that restore a
  // pre with geometry already attached) skip it and only paint. See cache-read-perf.md.
  const geom = pre.geometry ?? (pre.geometry = computeRibbonGeometry(args));
  return paintRibbons(args, geom, sceneOut);
}

function renderSmoothed(input: GeoInput, opts: SchematicOptions): string {
  const pre = precomputeSmoothed(input);
  if (typeof pre === 'string') return pre;
  return drawSmoothed(pre, { showLabels: opts.showLabels, showStations: opts.showStations, megaFallback: opts.megaFallback, stationDesign: opts.stationDesign });
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
    const fromBase = e.from;
    const toBase = e.to;
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

function svgWrap(parts: string[], width: number, height: number, frame?: FrameRect | null): string {
  // data-frame is the fit/export crop rect (the geography water/green extent in
  // pixel space). The UI uses it for "fit to view" and SVG export; absent → full canvas.
  const frameAttr = frame ? ` data-frame="${r(frame.x)} ${r(frame.y)} ${r(frame.w)} ${r(frame.h)}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}"${frameAttr}>${parts.join('')}</svg>`
  );
}
