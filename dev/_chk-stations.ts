// Throwaway: verify user-reported stations exist and sit near truth in the
// rendered support output (320 Pl missing-terminus, 94 Av station-in-water).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const NAMES = process.argv.slice(2);
if (NAMES.length === 0) NAMES.push('320 Pl', '307 Pl', '94 Av');

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

const dHat = 16;
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h) / 1.6),
  geographicAffinity: 0.05, // keep in sync with renderGeographic smoothed mode
};
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);

console.log(`groups=${groups.length} supportStations(pre-merge)=${h.stations.size} (post-merge)=${merged.h.stations.size}`);
for (const name of NAMES) {
  const matches = groups.filter((g) => g.name === name);
  if (matches.length === 0) {
    console.log(`${name}: NO GROUP with this name`);
    continue;
  }
  for (const g of matches) {
    const truePx = proj.toSVG(g.center);
    const pre = h.stations.get(g.id);
    if (pre) {
      const preDrawn = img.placement.get(pre.nodeId);
      const preTrue = h.nodes.get(pre.nodeId)?.pos;
      console.log(
        `  pre  ${name}: node=${pre.nodeId} deg=${(h.adj.get(pre.nodeId) ?? []).length} ` +
        `drawn=(${preDrawn?.[0].toFixed(0)},${preDrawn?.[1].toFixed(0)}) nodeTrue=(${preTrue?.[0].toFixed(0)},${preTrue?.[1].toFixed(0)})`,
      );
    } else {
      console.log(`  pre  ${name}: MISSING`);
    }
    const st = merged.h.stations.get(g.id);
    if (!st) {
      console.log(`  post ${name} (${g.id.slice(0, 8)}): MISSING from support stations`);
      continue;
    }
    const drawn = merged.img.placement.get(st.nodeId);
    const d = drawn ? Math.hypot(drawn[0] - truePx[0], drawn[1] - truePx[1]) : NaN;
    console.log(
      `  post ${name} (${g.id.slice(0, 8)}): node=${st.nodeId} drawn=(${drawn?.[0].toFixed(0)},${drawn?.[1].toFixed(0)}) ` +
      `true=(${truePx[0].toFixed(0)},${truePx[1].toFixed(0)}) err=${d.toFixed(1)}px deg=${(merged.h.adj.get(st.nodeId) ?? []).length}`,
    );
  }
}
