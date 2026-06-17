// Throwaway: is route d77e0aec present in support edges / traversals at warp 0?
import { readFileSync } from 'fs';
import { buildTransitGraph, getOrBuildStationGroups } from '../src/render/layout/graph';
import { buildSupportGraph } from '../src/render/layout/topo';
import type { TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';
import type { Route, Track } from '../src/types/game-state';
import type { Coordinate } from '../src/types/core';

const TEAL = 'd77e0aec-e9cf-4d78-ac3b-df9b27fbf851';
const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const raw = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8'));
const data = raw.data ?? raw;

const groups = getOrBuildStationGroups(data.stations as never, undefined);
const graph = buildTransitGraph(data.stations as never, (data.routes ?? []) as Route[], groups, (data.tracks ?? []) as Track[]);
const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
const b = computeBounds(framePts)!;
const proj = createProjection(padBounds(b, 0.1), 2000, 2000, 0.06);
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

console.log('graph traversal steps:', graph.lineTraversals.get(TEAL)?.length ?? -1);
let gEdges = 0;
for (const e of graph.edges) if (e.lines.some((l) => l.id === TEAL)) gEdges++;
console.log('graph edges carrying teal:', gEdges);

const dHat = Math.max(8, 5 * 4);
const topoParams: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, topoParams);
let sEdges = 0;
for (const e of support.edges.values()) if (e.lineIds.has(TEAL)) sEdges++;
console.log('support edges carrying teal:', sEdges, 'of', support.edges.size);
console.log('support traversal steps:', support.lineTraversals.get(TEAL)?.length ?? -1);

// connected components of the support graph
const compOf = new Map<string, number>();
let comp = 0;
for (const nid of support.nodes.keys()) {
  if (compOf.has(nid)) continue;
  comp++;
  const q = [nid];
  compOf.set(nid, comp);
  while (q.length) {
    const cur = q.pop()!;
    for (const eid of support.adj.get(cur) ?? []) {
      const e = support.edges.get(eid)!;
      const nxt = e.from === cur ? e.to : e.from;
      if (!compOf.has(nxt)) { compOf.set(nxt, comp); q.push(nxt); }
    }
  }
}
const sizes = new Map<number, number>();
for (const c of compOf.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
console.log('components:', comp, 'sizes:', [...sizes.values()].sort((a, b) => b - a).slice(0, 12));
for (const nid of ['h1180', 'h1450', 'h266', 'h1538']) {
  console.log(nid, 'component', compOf.get(nid), 'pos', support.nodes.get(nid)?.pos.map((v) => v.toFixed(0)));
}
