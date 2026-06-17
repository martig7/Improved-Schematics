// Probe: drawn geometry + traversals at the Harvey Rd junction.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
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
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h) / (h.edges.size > 800 ? 1.2 : 1.6)),
  geographicAffinity: 0.05,
};
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
separateFusedStations(merged.h, merged.img, 16);
const hh = merged.h;
const image = merged.img;

// find the Harvey Rd station node, then its neighborhood
const st = [...hh.stations.values()].find((s) => s.label === 'Harvey Rd');
if (!st) { console.log('no Harvey Rd'); process.exit(1); }
const home = st.nodeId;
console.log(`Harvey Rd at ${home} pos=(${hh.nodes.get(home)?.pos.map((x) => x.toFixed(0))}) deg=${hh.adj.get(home)?.length}`);

// collect nodes within 2 hops
const near = new Set<string>([home]);
for (let hop = 0; hop < 2; hop++) {
  for (const nid of [...near]) {
    for (const eid of hh.adj.get(nid) ?? []) {
      const e = hh.edges.get(eid)!;
      near.add(e.from);
      near.add(e.to);
    }
  }
}
const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '?');
const seen = new Set<string>();
for (const nid of near) {
  for (const eid of hh.adj.get(nid) ?? []) {
    if (seen.has(eid)) continue;
    seen.add(eid);
    const e = hh.edges.get(eid)!;
    const path = image.paths.get(eid) ?? e.points;
    console.log(
      `${eid} ${e.from}${fmt(hh.nodes.get(e.from)?.pos)} -> ${e.to}${fmt(hh.nodes.get(e.to)?.pos)} ` +
      `lines={${[...e.lineIds].map((l) => l.slice(0, 6)).join(',')}}`,
    );
    console.log(`   path: ${path.map((p) => fmt(p)).join(' ')}`);
  }
}

// traversal steps of each line through the neighborhood
console.log('\ntraversals through the area:');
for (const [lineId, steps] of hh.lineTraversals) {
  const hits: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (seen.has(steps[i].edgeId)) {
      const e = hh.edges.get(steps[i].edgeId)!;
      const a = steps[i].reversed ? e.to : e.from;
      const b = steps[i].reversed ? e.from : e.to;
      hits.push(`${steps[i].edgeId}(${a}>${b})`);
    }
  }
  if (hits.length) console.log(`  ${lineId.slice(0, 8)}: ${hits.join(' ')}`);
}
