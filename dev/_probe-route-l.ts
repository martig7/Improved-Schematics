// Probe: graph-level edges + final traversal for the route serving 1 Pl —
// verify the input is linear and our pipeline keeps it linear.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
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
  for (let i = 0; i < 2; i++) warpSamples.push(p);
}
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

const nameOf = new Map<string, string>();
for (const g of groups) nameOf.set(g.id, g.name);
const want = new Set(groups.filter((g) => ['1 Pl', '10 St', '12 Pl', '36 St'].includes(g.name)).map((g) => g.id));

console.log('=== graph-level edges incident to 10 St / 1 Pl / 12 Pl / 36 St ===');
const lineIds = new Set<string>();
for (const e of graph.edges) {
  if (!want.has(e.from) && !want.has(e.to)) continue;
  const stops = [...e.stops.entries()]
    .map(([lid, f]) => `${lid.slice(0, 6)}(${f.atFrom ? 'F' : ''}${f.atTo ? 'T' : ''})`)
    .join(' ');
  console.log(
    `${e.id.slice(0, 10)} ${nameOf.get(e.from) ?? e.from.slice(0, 6)} <-> ${nameOf.get(e.to) ?? e.to.slice(0, 6)} ` +
    `lines=[${[...e.lines].map((l) => l.id.slice(0, 6)).join(',')}] stops: ${stops}`,
  );
  for (const l of e.lines) lineIds.add(l.id);
}

const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const nodeName = new Map<string, string>();
for (const st of h.stations.values()) nodeName.set(st.nodeId, st.label);

console.log('\n=== final support traversal (full, with repeats marked) ===');
for (const lid of lineIds) {
  const trav = h.lineTraversals.get(lid);
  if (!trav) continue;
  const seen = new Map<string, number>();
  const seq: string[] = [];
  for (let i = 0; i < trav.length; i++) {
    const e = h.edges.get(trav[i].edgeId);
    if (!e) continue;
    const a = trav[i].reversed ? e.to : e.from;
    const b = trav[i].reversed ? e.from : e.to;
    if (i === 0) seq.push(a);
    seq.push(b);
    seen.set(trav[i].edgeId, (seen.get(trav[i].edgeId) ?? 0) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1);
  console.log(`line ${lid.slice(0, 8)}: ${trav.length} steps, ${dup.length} edges traversed more than once${dup.length ? ` -> ${dup.map(([id, n]) => `${id}x${n}`).join(', ')}` : ''}`);
  const named = seq.map((n) => nodeName.get(n)).filter(Boolean);
  console.log(`  station sequence: ${named.join(' > ')}`);
}
