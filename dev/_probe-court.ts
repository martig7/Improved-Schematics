// Probe: Court station — stopLines, per-line flag nodes, members.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph, servedStationIds } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
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
  warpSamples.push(p, p);
}
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const h0 = buildSupportGraph(graph, groups, params);
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h0) / (h0.edges.size > 800 ? 1.2 : 1.6)),
  geographicAffinity: 0.05,
};
const img = octi(h0, octiOpts);
const merged = mergeCoincidentPaths(h0, img);
separateFusedStations(merged.h, merged.img, 16);
const h = merged.h;

const served = servedStationIds(stations, routes);
for (const name of ['Court', 'Tacoma Av']) {
  for (const g of groups.filter((x) => x.name === name)) {
    const st = h.stations.get(g.id);
    console.log(`${name} (${g.id.slice(0, 8)}): members=${g.stationIds.length} served=${g.stationIds.filter((id) => served.has(id)).length}`);
    if (!st) { console.log('  no support station'); continue; }
    console.log(`  node=${st.nodeId} stopLines=${[...(st.stopLines ?? [])].map((l) => l.slice(0, 8)).join(',')}`);
    for (const [l, n] of st.stopNodes ?? []) {
      console.log(`  stopNode ${l.slice(0, 8)} -> ${n} (flag present: ${h.stopAt.has(l + '|' + n)})`);
    }
  }
}
