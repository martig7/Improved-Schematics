// Probe: H's support-graph traversal + edges near the phantom northern arc
// east of Main St (NYC).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
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

// First: the GROUP-level graph — what lines does the transit graph put on
// corridors near the phantom arc, and what does H's own corridor look like?
const bulletOf = new Map<string, string>();
for (const r of routes) if (!r.tempParentId) bulletOf.set(r.id, r.bullet ?? '?');
const nameOf = new Map<string, string>();
for (const g of groups) nameOf.set(g.id, g.name);
const inWin = (p?: Pixel) => !!p && p[0] > 1380 && p[0] < 1620 && p[1] > 1100 && p[1] < 1260;
console.log('=== transit-graph corridors in the window ===');
for (const e of graph.edges) {
  const pa = graph.nodes.get(e.from)?.pos;
  const pb = graph.nodes.get(e.to)?.pos;
  if (!inWin(pa) && !inWin(pb)) continue;
  console.log(
    `${e.id} ${nameOf.get(e.from)}(${pa?.[0].toFixed(0)},${pa?.[1].toFixed(0)}) <-> ` +
    `${nameOf.get(e.to)}(${pb?.[0].toFixed(0)},${pb?.[1].toFixed(0)}) lines={${e.lines.map((l) => bulletOf.get(l.id) ?? l.label).join(',')}}`,
  );
}

const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const hRoute = routes.find((r: { bullet?: string }) => r.bullet === 'H') as { id: string };

console.log('=== support edges carrying H in the window ===');
const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(?)');
for (const e of h.edges.values()) {
  if (!e.lineIds.has(hRoute.id)) continue;
  const pa = h.nodes.get(e.from)?.pos;
  const pb = h.nodes.get(e.to)?.pos;
  if (!inWin(pa) && !inWin(pb)) continue;
  console.log(`${e.id} ${e.from}${fmt(pa)} -> ${e.to}${fmt(pb)} lines={${[...e.lineIds].map((l) => bulletOf.get(l) ?? '?').join(',')}}`);
}

console.log('=== H support traversal steps in the window ===');
const trav = h.lineTraversals.get(hRoute.id) ?? [];
for (let i = 0; i < trav.length; i++) {
  const e = h.edges.get(trav[i].edgeId);
  if (!e) continue;
  const pa = h.nodes.get(e.from)?.pos;
  const pb = h.nodes.get(e.to)?.pos;
  if (!inWin(pa) && !inWin(pb)) continue;
  console.log(`step ${i}: ${trav[i].edgeId} rev=${trav[i].reversed} ${e.from}${fmt(pa)} -> ${e.to}${fmt(pb)}`);
}
