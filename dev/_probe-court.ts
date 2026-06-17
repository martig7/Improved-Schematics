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

// traversal steps of the gray pair near the hub
for (const lid of ['87028bd5-b5cf-4ad4-99a0-29a90de80172', '6d6a7b31']) {
  for (const [lineId, steps] of h.lineTraversals) {
    if (!lineId.startsWith(lid.slice(0, 8))) continue;
    const seq: string[] = [];
    for (const s of steps) {
      const e = h.edges.get(s.edgeId);
      if (!e) continue;
      const a = s.reversed ? e.to : e.from;
      const b = s.reversed ? e.from : e.to;
      seq.push(`${s.edgeId}(${a}>${b})`);
    }
    console.log(`line ${lineId.slice(0, 8)}: ${seq.join(' ')}`);
  }
}

// NE corridor (Court -> Milwaukee Way): painted lines vs gray traversal use
const milw = [...h.stations.values()].find((s) => s.label === 'Milwaukee Way');
const court = [...h.stations.values()].find((s) => s.label === 'Court');
console.log('court node', court?.nodeId, 'milwaukee node', milw?.nodeId);
const grayIds = [...h.lineRefs.keys()].filter((id) =>
  ['0458fd40', '262b05f7', '87028bd5', '6d6a7b31'].some((p) => id.startsWith(p)));
const usesEdge = new Map<string, Set<string>>();
for (const [lid, steps] of h.lineTraversals) {
  usesEdge.set(lid, new Set(steps.map((s) => s.edgeId)));
}
for (const g of grayIds) {
  console.log(`gray ${g.slice(0, 8)}: traversal=${h.lineTraversals.has(g) ? h.lineTraversals.get(g)!.length + ' steps' : 'MISSING'}`);
}
// walk edges around Court's node
for (const eid of h.adj.get(court?.nodeId ?? '') ?? []) {
  const e = h.edges.get(eid)!;
  const grayOn = grayIds.filter((g) => e.lineIds.has(g)).map((g) => g.slice(0, 8));
  const grayUse = grayIds.filter((g) => usesEdge.get(g)?.has(eid)).map((g) => g.slice(0, 8));
  console.log(`edge ${eid} ${e.from}->${e.to} painted grays=[${grayOn}] traversed-by=[${grayUse}] allLines=${e.lineIds.size}`);
}
