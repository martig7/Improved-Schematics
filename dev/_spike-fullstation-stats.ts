// Throwaway spike: live-dump numbers for full-station octi routing audit.
// Replicates renderSmoothed prep, then measures both modes' graph sizes,
// contraction effects on station nodes, grid dims, and A* call counts.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import { medianEdgeLength, planarize, combineDeg2 } from '../src/render/layout/octi';
import type { Pixel, SupportGraph } from '../src/render/layout/types';
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

const dHat = Math.max(8, 4 * 4);
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);

const dist = (a: Pixel, b: Pixel) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polyLen = (p: readonly Pixel[]) => {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  return l;
};

const stationNodes = new Set<string>();
for (const st of h.stations.values()) stationNodes.add(st.nodeId);

console.log(`groups: ${groups.length}, stations mapped: ${h.stations.size}, distinct station nodes: ${stationNodes.size}`);
console.log(`support: ${h.nodes.size} nodes, ${h.edges.size} edges`);

// degree histogram + station/degree cross
const degHist = new Map<number, number>();
const stDegHist = new Map<number, number>();
for (const [id, eids] of h.adj) {
  const d = eids.length;
  degHist.set(d, (degHist.get(d) ?? 0) + 1);
  if (stationNodes.has(id)) stDegHist.set(d, (stDegHist.get(d) ?? 0) + 1);
}
console.log('deg hist (all):', [...degHist.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}:${c}`).join(' '));
console.log('deg hist (station nodes):', [...stDegHist.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}:${c}`).join(' '));

const medLen = medianEdgeLength(h);
const lens = [...h.edges.values()].map((e) => polyLen(e.points)).sort((a, b) => a - b);
const chordLens = [...h.edges.values()].map((e) => dist(h.nodes.get(e.from)!.pos, h.nodes.get(e.to)!.pos)).sort((a, b) => a - b);
console.log(`median edge polyline len: ${medLen.toFixed(1)}, p10=${lens[Math.floor(lens.length * 0.1)].toFixed(1)}, p25=${lens[Math.floor(lens.length * 0.25)].toFixed(1)}, p75=${lens[Math.floor(lens.length * 0.75)].toFixed(1)}, p90=${lens[Math.floor(lens.length * 0.9)].toFixed(1)}`);
console.log(`median chord len: ${chordLens[chordLens.length >> 1].toFixed(1)}`);

// bounds for grid sizing
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of h.nodes.values()) {
  minX = Math.min(minX, n.pos[0]); maxX = Math.max(maxX, n.pos[0]);
  minY = Math.min(minY, n.pos[1]); maxY = Math.max(maxY, n.pos[1]);
}

for (const divisor of [1.0, 1.2, 1.5, 2.5]) {
  const dg = Math.max(12, medLen / divisor);
  const cols = Math.ceil((maxX - minX) / dg) + 5;
  const rows = Math.ceil((maxY - minY) / dg) + 5;
  const thr = dg / 2;
  // first-order short-edge census at threshold dg/2
  let short = 0, shortStSt = 0, shortStOther = 0;
  for (const e of h.edges.values()) {
    if (polyLen(e.points) >= thr) continue;
    short++;
    const sf = stationNodes.has(e.from);
    const st = stationNodes.has(e.to);
    if (sf && st) shortStSt++;
    else if (sf || st) shortStOther++;
  }
  console.log(
    `divisor=${divisor}: cell=${dg.toFixed(1)} grid=${cols}x${rows} (${cols * rows} bases, ${cols * rows * 9} A*-nodes) ` +
    `shortEdges(<cell/2)=${short} [st-st=${shortStSt}, st-other=${shortStOther}]`,
  );
}

// planarize + combineDeg2 sizes (post short-edge contraction is what octi routes;
// approximate with uncontracted graph for the full-station case)
const { hP } = planarize(h);
console.log(`planarized: ${hP.nodes.size} nodes, ${hP.edges.size} edges (+${hP.edges.size - h.edges.size} from splits)`);
const { hC, info } = combineDeg2(hP);
console.log(`combineDeg2 skeleton: ${hC.nodes.size} nodes, ${hC.edges.size} edges; chains=${info.chains.size}`);
let chainStations = 0;
for (const c of info.chains.values()) chainStations += c.nodes.length - 2;
console.log(`stations absorbed into chains (redistributed evenly today): ${chainStations}`);

// A* call counts per local-search sweep
const sweepCalls = (hg: SupportGraph) => {
  let nodeMoves = 0;
  for (const [id, eids] of hg.adj) {
    if (eids.length === 0) continue;
    nodeMoves += 9 * eids.length; // 9 candidate positions x re-route each incident edge
  }
  return { nodeMoves, edgeReroutes: hg.edges.size };
};
const full = sweepCalls(hP);
const comb = sweepCalls(hC);
console.log(`A* per initial ordering: full=${hP.edges.size} comb=${hC.edges.size}`);
console.log(`A* per local-search sweep: full=${full.nodeMoves}+${full.edgeReroutes} comb=${comb.nodeMoves}+${comb.edgeReroutes}`);
