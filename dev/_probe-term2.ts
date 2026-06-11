// Probe: raw support-edge geometry + comb course around the 1 Pl terminus.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { combineDeg2, cutSubCellFolds, medianEdgeLength } from '../src/render/layout/octi';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
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

const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const dg = Math.max(12, medianEdgeLength(h) / (h.edges.size > 800 ? 1.2 : 1.6));
console.log(`cellSize dg=${dg.toFixed(1)}`);

// the named stations' nodes
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['1 Pl', '10 St', '12 Pl', '36 St'];
const nodeIds = new Set<string>();
for (const st of h.stations.values()) {
  if (names.includes(st.label)) {
    nodeIds.add(st.nodeId);
    console.log(`${st.label}: node=${st.nodeId} pos=(${h.nodes.get(st.nodeId)?.pos.map((x) => x.toFixed(1))})`);
  }
}

const fmtPts = (pts: Pixel[]) =>
  pts.map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(' ');
const polyLen = (pts: Pixel[]) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
};
const span = (pts: Pixel[]) => Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);

console.log('\n=== support edges at these nodes ===');
for (const nid of nodeIds) {
  for (const eid of h.adj.get(nid) ?? []) {
    const e = h.edges.get(eid)!;
    console.log(
      `${eid} ${e.from}->${e.to} pts=${e.points.length} len=${polyLen(e.points).toFixed(1)} span=${span(e.points).toFixed(1)}`,
    );
    console.log(`  ${fmtPts(e.points)}`);
  }
}

console.log('\n=== comb edges touching these nodes (course len vs span, cut effect) ===');
const { hC, info } = combineDeg2(h as Parameters<typeof combineDeg2>[0]);
for (const e of hC.edges.values()) {
  const chain = info.chains.get(e.id);
  const touches =
    nodeIds.has(e.from) || nodeIds.has(e.to) || (chain && chain.nodes.some((n) => nodeIds.has(n)));
  if (!touches) continue;
  const cut = cutSubCellFolds(e.points, dg);
  console.log(
    `${e.id} ${e.from}->${e.to} chainNodes=${chain?.nodes.length ?? 2} pts=${e.points.length} ` +
    `len=${polyLen(e.points).toFixed(1)} span=${span(e.points).toFixed(1)} | cut: pts=${cut.length} len=${polyLen(cut).toFixed(1)}`,
  );
  console.log(`  course: ${fmtPts(e.points.length > 40 ? e.points.slice(-40) : e.points)}`);
  if (cut.length !== e.points.length) {
    console.log(`  cut   : ${fmtPts(cut.length > 40 ? cut.slice(-40) : cut)}`);
  }
}
