// Throwaway spike: run octi() in full-station mode (combineDeg2: false) on the
// live dump, vs the comb baseline. Measures wall time, station placement
// distinctness, and grid snapping. OCTI_DEBUG=1 recommended for score/vios.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

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

const dHat = Math.max(8, 4 * 4);
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, params);
const medLen = medianEdgeLength(support);
console.log(`support ${support.nodes.size}n/${support.edges.size}e medLen=${medLen.toFixed(1)}`);

const stationNodes = new Set<string>();
for (const st of support.stations.values()) stationNodes.add(st.nodeId);

const mode = process.argv[2] ?? 'full';
const divisor = Number(process.argv[3] ?? '1.0');
const cellSize = Math.max(12, medLen / divisor);

const opts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize,
  combineDeg2: mode !== 'full',
};
console.log(`mode=${mode} divisor=${divisor} cellSize=${cellSize.toFixed(1)} combineDeg2=${opts.combineDeg2}`);

const t0 = Date.now();
const img = octi(support, opts);
const ms = Date.now() - t0;
console.log(`octi total: ${ms}ms`);

// Station placement analysis
const q = (p: Pixel) => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
const posCount = new Map<string, number>();
let placed = 0;
let onGrid = 0;
let maxDisp = 0;
let sumDisp = 0;
const cell = img.cellSize;
for (const nid of stationNodes) {
  const p = img.placement.get(nid);
  if (!p) continue;
  placed++;
  posCount.set(q(p), (posCount.get(q(p)) ?? 0) + 1);
  // grid snap check: distance to nearest multiple of cell from origin unknown;
  // instead check displacement from true support pos
  const sp = support.nodes.get(nid)?.pos;
  if (sp) {
    const d = Math.hypot(p[0] - sp[0], p[1] - sp[1]);
    maxDisp = Math.max(maxDisp, d);
    sumDisp += d;
  }
  // on-grid: placement coincides with some other station's exact pixel handled
  // via posCount; "snapped to grid" = coords are near-multiples of cellSize
  void onGrid;
}
let stacked = 0;
let stackedNodes = 0;
for (const c of posCount.values()) {
  if (c > 1) {
    stacked++;
    stackedNodes += c;
  }
}
console.log(
  `stations: ${stationNodes.size} nodes, ${placed} placed; ` +
  `${stacked} positions hold ${stackedNodes} stacked station nodes; ` +
  `avgDisp=${(sumDisp / Math.max(1, placed)).toFixed(1)}px maxDisp=${maxDisp.toFixed(1)}px (cell=${cell.toFixed(1)})`,
);

// path degeneracy: edges whose drawn path is a straight 2-point fallback
let degenerate = 0;
for (const e of support.edges.values()) {
  const path = img.paths.get(e.id);
  if (!path || path.length === 2) degenerate++;
}
console.log(`edges with 2-point (possibly fallback) paths: ${degenerate}/${support.edges.size}`);
