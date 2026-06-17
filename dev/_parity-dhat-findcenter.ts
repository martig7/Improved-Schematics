// Throwaway (dHat sweep prep): locate where BLUE (#0039a6) and PINK (#b933ad)
// share support edges in the baseline (dHat=16) support graph, to pick the
// center-crop viewBox for dev/_parity-dhat-sweep.ts. Prep copied from
// dev/_probe-cane.ts (replicates renderSmoothed exactly).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const inner = dump['debug-render-input'] ?? dump;
const { routes, tracks, stations, stationGroups } = inner;

const BLUE = new Set(routes.filter((r: { color: string }) => r.color.toLowerCase() === '#0039a6').map((r: { id: string }) => r.id));
const PINK = new Set(routes.filter((r: { color: string }) => r.color.toLowerCase() === '#b933ad').map((r: { id: string }) => r.id));
console.log('blue routes:', [...BLUE], 'pink routes:', [...PINK]);

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

const dHat = Number(process.env.OCTI_DHAT) || 16;
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
console.log(`dHat=${dHat}: support ${h.nodes.size} nodes ${h.edges.size} edges`);

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, nShared = 0;
for (const e of h.edges.values()) {
  const hasBlue = [...e.lineIds].some((l) => BLUE.has(l));
  const hasPink = [...e.lineIds].some((l) => PINK.has(l));
  if (!hasBlue || !hasPink) continue;
  nShared++;
  const pf = h.nodes.get(e.from)?.pos, pt = h.nodes.get(e.to)?.pos;
  if (!pf || !pt) continue;
  for (const p of [pf, pt]) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  console.log(`  shared ${e.id}: (${pf[0].toFixed(0)},${pf[1].toFixed(0)})->(${pt[0].toFixed(0)},${pt[1].toFixed(0)}) lines=${[...e.lineIds].map((l)=>l.slice(0,6)).join(',')}`);
}
console.log(`\n${nShared} blue+pink shared support edges; bbox x[${minX.toFixed(0)},${maxX.toFixed(0)}] y[${minY.toFixed(0)},${maxY.toFixed(0)}]`);
