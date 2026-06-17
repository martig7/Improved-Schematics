// Throwaway spike worker (full-station placement): replicate renderSmoothed's
// exact prep on the live dump, run octi() once with an explicit cellSize and
// optionally combineDeg2 disabled, measure station placement, then run the
// exact downstream path renderSmoothed uses (mergeCoincidentPaths ->
// supportToLayout copy -> orderLines -> renderRibbons) and write svg/png/crops.
//
// Usage: npx tsx dev/_spike-fs-worker.ts <label> <cellFactor|default> <combine|nocombine>
// Driver sets OCTI_DEBUG=1 in the env (octi reads it at module import time).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import type { Coordinate } from '../src/types/core';
import type {
  Pixel, SupportGraph, Layout, LayoutNode, LayoutEdge, Cell, EdgeStop,
} from '../src/render/layout/types';
import type { WaterCollection } from '../src/render/types';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength, type OctiOptions } from '../src/render/layout/octi';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
import { orderLines } from '../src/render/layout/lineOrder';
import { renderRibbons } from '../src/render/renderOctilinear';
import { findTransferPairs, routedGroupsOnly, DEFAULT_TRANSFER_METERS } from '../src/render/transfers';

const label = process.argv[2] ?? 'x';
const factorArg = process.argv[3] ?? 'default';
const combine = (process.argv[4] ?? 'combine') !== 'nocombine';

// ---- prep: EXACTLY renderSmoothed (renderGeographic.ts:384-461) -------------
const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const groups = getOrBuildStationGroups(stations, stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);

const bounds = (() => {
  const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
  for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
  const b = computeBounds(framePts);
  return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
})();
const W = 2700, H = 2700;
const baseProj = createProjection(bounds, W, H, 0.06);
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
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

const dHat = Math.max(8, 4 * 4); // theme.lineWidth = 4
const topoParams: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, topoParams);
const medLen = medianEdgeLength(support);

const cellSize = factorArg === 'default'
  ? Math.max(12, medLen / (support.edges.size > 800 ? 1.2 : 2.5))
  : medLen * Number(factorArg);

console.error(
  `[worker ${label}] support nodes=${support.nodes.size} edges=${support.edges.size} ` +
  `stations=${support.stations.size} medLen=${medLen.toFixed(1)} cellSize=${cellSize.toFixed(1)} combine=${combine}`,
);

// ---- octi (single run, timed) ------------------------------------------------
const octiOpts: OctiOptions = { ...DEFAULT_OCTI_OPTIONS, cellSize };
if (!combine) octiOpts.combineDeg2 = false;
const t0 = Date.now();
const imageRaw = octi(support, octiOpts);
const runtimeSec = (Date.now() - t0) / 1000;

// ---- station placement stats --------------------------------------------------
const dists: number[] = [];
let unplaced = 0;
const stationNodes = new Set<string>();
for (const st of support.stations.values()) {
  stationNodes.add(st.nodeId);
  const truth = support.nodes.get(st.nodeId)?.pos;
  const drawn = imageRaw.placement.get(st.nodeId);
  if (!truth || !drawn) { unplaced++; continue; }
  dists.push(Math.hypot(drawn[0] - truth[0], drawn[1] - truth[1]));
}
dists.sort((a, b) => a - b);
const q = (p: number) => (dists.length ? dists[Math.min(dists.length - 1, Math.floor(p * dists.length))] : NaN);

// ---- downstream: EXACTLY renderSmoothed (renderGeographic.ts:485-525) --------
const merged = mergeCoincidentPaths(support, imageRaw);
const supportM = merged.h;
const image = merged.img;

// -- copy of private supportToLayout + cleanPolyline (renderGeographic.ts:154-246)
function pointToSeg(p: Pixel, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  const t = c1 / c2;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}
function rdp(pts: Pixel[], eps: number): Pixel[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSeg(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}
function cleanPolyline(pts: Pixel[]): Pixel[] {
  if (pts.length <= 2) return pts.slice();
  const dedup: Pixel[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const last = dedup[dedup.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= 1) dedup.push(pts[i]);
  }
  const end = pts[pts.length - 1];
  if (dedup[dedup.length - 1] !== end) dedup.push(end);
  if (dedup.length <= 2) return dedup;
  return rdp(dedup, 2.5);
}
function supportToLayout(h: SupportGraph): { layout: Layout; nodePx: Map<string, Pixel> } {
  const nodes = new Map<string, LayoutNode>();
  const nodePx = new Map<string, Pixel>();
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
      id: e.id, from: e.from, to: e.to,
      path: cleanPolyline(e.points).map((p) => [p[0], p[1]] as Cell),
      lines,
      lineOrder: lines.map((l) => l.id).sort(),
      stops,
    });
  }
  const layout: Layout = { cellSize: 1, nodes, edges, lineTraversals: h.lineTraversals };
  return { layout, nodePx };
}

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

// water cosmetic overlay (copy of private waterGroup)
let waterOverlay = '';
if (existsSync('sea_water.geojson')) {
  const water: WaterCollection = JSON.parse(readFileSync('sea_water.geojson', 'utf-8'));
  const r = (n: number) => Math.round(n * 10) / 10;
  let paths = '';
  for (const f of water.features) {
    if (f.geometry.type !== 'Polygon') continue;
    let d = '';
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = proj.toSVG(c as Coordinate);
        d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
      });
      d += 'Z ';
    }
    if (d.trim()) paths += `<path d="${d.trim()}"/>`;
  }
  if (paths) waterOverlay = `<g fill="#b7d3e3" fill-rule="evenodd" stroke="none">${paths}</g>`;
}

const svg = renderRibbons({
  layout, nodePx,
  edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
  width: W, height: H, dark: false, showLabels: false,
  transfers, gridOverlay: waterOverlay,
});

// ---- outputs ------------------------------------------------------------------
const base = `dev/_spike-fs-${label}`;
writeFileSync(base + '.svg', svg);
writeFileSync(base + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng());
const crop = (vb: string, out: string, w: number) => {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: w }, background: 'white' }).render().asPng());
};
crop('820 590 440 440', base + '-nw.png', 880);
crop('1050 950 500 500', base + '-core.png', 1000);

// ---- marker counts --------------------------------------------------------------
const markerIds = new Set<string>();
for (const m of svg.matchAll(/data-station-id="([^"]+)"/g)) markerIds.add(m[1]);
const drawnStationMarkers = [...markerIds].filter((id) => stationNodes.has(id)).length;

console.log('STATS ' + JSON.stringify({
  label, combine,
  medLen: +medLen.toFixed(2),
  cellSize: +cellSize.toFixed(2),
  runtimeSec: +runtimeSec.toFixed(1),
  supportNodes: support.nodes.size,
  supportEdges: support.edges.size,
  stationGroups: support.stations.size,
  distinctStationNodes: stationNodes.size,
  unplacedStations: unplaced,
  placeErrPx: dists.length
    ? { median: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), max: +dists[dists.length - 1].toFixed(1) }
    : null,
  placeErrCells: dists.length
    ? { median: +(q(0.5) / cellSize).toFixed(2), max: +(dists[dists.length - 1] / cellSize).toFixed(2) }
    : null,
  svgMarkerIds: markerIds.size,
  svgMarkersOnStationNodes: drawnStationMarkers,
}));
