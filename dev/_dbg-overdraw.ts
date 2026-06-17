// Throwaway: at the persistent overdraw window (real px x[1140,1260] y[1050,1075]),
// dump post-imageMerge edges + their lines, to attribute the remaining
// gray+blue coincidence (one bundled edge => offsets bug; two edges => merge miss).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
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

const dHat = Math.max(16, 4 * 4);
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, params);
const octiOpts = { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medianEdgeLength(support) / 2.5) };
const imageRaw = octi(support, octiOpts);
const merged = mergeCoincidentPaths(support, imageRaw);

const inWin = (p: Pixel) => p[0] >= 1240 && p[0] <= 1310 && p[1] >= 1445 && p[1] <= 1505;
console.log('=== post-merge edges through window ===');
for (const [id, e] of merged.h.edges) {
  const path = merged.img.paths.get(id);
  if (!path) continue;
  if (!path.some(inWin)) continue;
  const lines = [...e.lineIds].map((l) => l.slice(0, 6)).join(',');
  const p0 = path[0], p1 = path[path.length - 1];
  console.log(
    `${id}: (${p0[0].toFixed(0)},${p0[1].toFixed(0)})->(${p1[0].toFixed(0)},${p1[1].toFixed(0)}) ` +
    `pts=${path.length} lines=[${lines}]`,
  );
}
console.log('=== PRE-merge support edges through window (drawn paths) ===');
for (const [id, e] of support.edges) {
  const path = imageRaw.paths.get(id);
  if (!path) continue;
  if (!path.some(inWin)) continue;
  const lines = [...e.lineIds].map((l) => l.slice(0, 6)).join(',');
  console.log(`${id}: pts=${path.length} lines=[${lines}] pathStart=(${path[0][0].toFixed(1)},${path[0][1].toFixed(1)})`);
}
