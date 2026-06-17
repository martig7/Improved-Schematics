// Throwaway: inspect the support graph around the candy-cane (live dump),
// specifically hunting parallel edges (same node pair, multiple edges) that
// octi's multigraph guard would route as separate corridors.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync(process.argv[2] ?? 'improvedschematics-input.json', 'utf-8'));
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

// ---- GRAPH level: parallel edges between the same node pair ----
const pairKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
const gPairs = new Map<string, string[]>();
for (const e of graph.edges) {
  const k = pairKey(e.from, e.to);
  (gPairs.get(k) ?? gPairs.set(k, []).get(k)!).push(e.id);
}
const gMulti = [...gPairs.entries()].filter(([, ids]) => ids.length > 1);
console.log(`graph: ${graph.nodes.size} nodes ${graph.edges.length} edges; node-pairs with >1 edge: ${gMulti.length}`);

const dHat = Math.max(8, 4 * 4);
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);

// ---- SUPPORT level: parallel edges ----
const sPairs = new Map<string, string[]>();
for (const e of h.edges.values()) {
  const k = pairKey(e.from, e.to);
  (sPairs.get(k) ?? sPairs.set(k, []).get(k)!).push(e.id);
}
const sMulti = [...sPairs.entries()].filter(([, ids]) => ids.length > 1);
console.log(`support: ${h.nodes.size} nodes ${h.edges.size} edges; node-pairs with >1 edge: ${sMulti.length}`);
for (const [k, ids] of sMulti) {
  const [a] = k.split('|');
  const p = h.nodes.get(a)?.pos ?? [0, 0];
  const det = ids.map((id) => {
    const e = h.edges.get(id)!;
    let len = 0;
    for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i][0] - e.points[i - 1][0], e.points[i][1] - e.points[i - 1][1]);
    return `${id}(len=${len.toFixed(1)},lines=[${[...e.lineIds].map((l) => l.slice(0, 6)).join(',')}])`;
  });
  console.log(`  pair ${k} @(${p[0].toFixed(0)},${p[1].toFixed(0)}): ${det.join(' ')}`);
}

// ---- the cane window: all support edges with an endpoint inside ----
const inWin = (p: Pixel) => p[0] >= 890 && p[0] <= 1060 && p[1] >= 690 && p[1] <= 900;
console.log('\n-- support edges touching cane window x[890,1060] y[690,900] --');
for (const e of h.edges.values()) {
  const pf = h.nodes.get(e.from)?.pos;
  const pt = h.nodes.get(e.to)?.pos;
  if (!pf || !pt || (!inWin(pf) && !inWin(pt))) continue;
  let len = 0;
  for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i][0] - e.points[i - 1][0], e.points[i][1] - e.points[i - 1][1]);
  console.log(
    `  ${e.id}: ${e.from}(${pf[0].toFixed(0)},${pf[1].toFixed(0)}) -> ${e.to}(${pt[0].toFixed(0)},${pt[1].toFixed(0)}) ` +
    `len=${len.toFixed(1)} pts=${e.points.length} lines=[${[...e.lineIds].map((l) => l.slice(0, 6)).join(',')}]`,
  );
}

// ---- traversals passing through the window ----
console.log('\n-- traversal steps in window --');
for (const [lineId, steps] of h.lineTraversals) {
  const segs: string[] = [];
  for (const s of steps) {
    const e = h.edges.get(s.edgeId);
    if (!e) continue;
    const pf = h.nodes.get(e.from)?.pos;
    const pt = h.nodes.get(e.to)?.pos;
    if (!pf || !pt || (!inWin(pf) && !inWin(pt))) continue;
    segs.push(`${s.edgeId}${s.reversed ? 'R' : 'F'}`);
  }
  if (segs.length) {
    const ref = h.lineRefs.get(lineId);
    console.log(`  ${lineId.slice(0, 8)} (${ref?.label}, ${ref?.color}): ${segs.join(' ')}`);
  }
}
