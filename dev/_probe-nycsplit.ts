// Probe: corridor-split investigation. For named stations: every GROUP with
// that name (center, members, stopping routes), the transit-graph corridors
// between wanted groups, and the support/merged structure (which support
// edges carry which lines). Answers "did parallel service corridors weld?"
// Usage: npx tsx dev/_probe-nycsplit.ts <dump.json> "22 St" "31 St" ...
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const [file, ...NAMES] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(file, 'utf-8'));
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

const bulletOf = new Map<string, string>();
for (const r of routes) if (!r.tempParentId) bulletOf.set(r.id, r.bullet ?? r.id.slice(0, 6));

const wanted = new Set<string>();
const nameOfGroup = new Map<string, string>();
for (const g of groups) {
  nameOfGroup.set(g.id, g.name);
  if (NAMES.some((n) => g.name === n)) wanted.add(g.id);
}

console.log('=== groups matching names ===');
for (const gid of wanted) {
  const g = groups.find((q) => q.id === gid)!;
  const px = proj.toSVG(g.center) as Pixel;
  // which routes stop at this group (via graph node edges' stop flags is
  // complex; use member stations' routeIds)
  const rids = new Set<string>();
  for (const sid of g.stationIds ?? []) {
    const st = stations.find((s: { id: string }) => s.id === sid);
    for (const rid of st?.routeIds ?? []) rids.add(rid);
  }
  console.log(
    `${g.name.padEnd(16)} ${gid} px=(${px[0].toFixed(0)},${px[1].toFixed(0)}) ` +
    `members=${(g.stationIds ?? []).length} routes={${[...rids].map((r) => bulletOf.get(r) ?? '?').join(',')}}`,
  );
}

console.log('\n=== transit-graph corridors at wanted groups ===');
for (const e of graph.edges) {
  if (!wanted.has(e.from) && !wanted.has(e.to)) continue;
  console.log(
    `edge ${e.id.slice(0, 12)} ${nameOfGroup.get(e.from) ?? e.from.slice(0, 6)} <-> ` +
    `${nameOfGroup.get(e.to) ?? e.to.slice(0, 6)} lines={${e.lines.map((l) => bulletOf.get(l.id) ?? l.label).join(',')}}`,
  );
}

const dHat = 16;
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);

console.log('\n=== support graph at wanted stations ===');
const nodeNames = new Map<string, string[]>();
for (const st of h.stations.values()) {
  const arr = nodeNames.get(st.nodeId) ?? [];
  arr.push(st.label);
  nodeNames.set(st.nodeId, arr);
}
const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(?)');
for (const gid of wanted) {
  const st = h.stations.get(gid);
  if (!st) { console.log(`${nameOfGroup.get(gid)} ${gid}: MISSING from support`); continue; }
  console.log(`${st.label.padEnd(16)} ${gid} node=${st.nodeId} ${fmt(h.nodes.get(st.nodeId)?.pos)}`);
  for (const eid of h.adj.get(st.nodeId) ?? []) {
    const e = h.edges.get(eid);
    if (!e) continue;
    const other = e.from === st.nodeId ? e.to : e.from;
    console.log(
      `    edge ${eid} -> ${other}${nodeNames.get(other) ? '[' + nodeNames.get(other)!.join('+') + ']' : ''} ` +
      `${fmt(h.nodes.get(other)?.pos)} lines={${[...e.lineIds].map((l) => bulletOf.get(l) ?? '?').join(',')}}`,
    );
  }
}
