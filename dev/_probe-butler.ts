// Probe: merged-graph structure + line-9 traversal around Butler St (NYC).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
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
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h) / divisor),
  geographicAffinity: 0.05,
};
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
separateFusedStations(merged.h, merged.img, dHat);

const bulletOf = new Map<string, string>();
for (const r of routes) if (!r.tempParentId) bulletOf.set(r.id, r.bullet ?? '?');
const nine = routes.find((r: { bullet?: string }) => r.bullet === '9') as { id: string };

const C: Pixel = [976, 1876];
const near = (p?: Pixel) => p && Math.hypot(p[0] - C[0], p[1] - C[1]) < 45;
const posOf = (nid: string) => merged.img.placement.get(nid) ?? merged.h.nodes.get(nid)?.pos;
const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(?)');

console.log('=== merged edges near Butler ===');
for (const e of merged.h.edges.values()) {
  const pa = posOf(e.from);
  const pb = posOf(e.to);
  if (!near(pa) && !near(pb)) continue;
  const path = merged.img.paths.get(e.id);
  console.log(
    `${e.id} ${e.from}${fmt(pa)} -> ${e.to}${fmt(pb)} lines={${[...e.lineIds].map((l) => bulletOf.get(l)).join(',')}} ` +
    `path=${(path ?? []).map((p) => fmt(p)).join(' ')}`,
  );
}

console.log('=== 9 traversal steps near Butler ===');
const trav = merged.h.lineTraversals.get(nine.id) ?? [];
for (let i = 0; i < trav.length; i++) {
  const e = merged.h.edges.get(trav[i].edgeId);
  if (!e) continue;
  const pa = posOf(e.from);
  const pb = posOf(e.to);
  if (!near(pa) && !near(pb)) continue;
  console.log(`step ${i}: ${trav[i].edgeId} rev=${trav[i].reversed} ${e.from}${fmt(pa)} -> ${e.to}${fmt(pb)}`);
}
