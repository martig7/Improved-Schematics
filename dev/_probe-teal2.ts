// Throwaway: track how many merge-graph edges carry the teal route per round.
import { readFileSync } from 'fs';
import { buildTransitGraph, getOrBuildStationGroups } from '../src/render/layout/graph';
import * as topo from '../src/render/layout/topo';
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

const dHat = Math.max(8, 5 * 4);
const params = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
} as topo.TopoParams;

// replicate runMergeRounds with instrumentation
const anyTopo = topo as unknown as {
  inputFromGraph?: unknown;
  inputFromBuilder?: unknown;
};
console.log('exports with "input":', Object.keys(topo).filter((k) => k.toLowerCase().includes('input')));
console.log('exports with "collapse"/"round":', Object.keys(topo).filter((k) => /collapse|round/i.test(k)));

// fall back: use collapseSharedSegments directly if input helpers are exported
const tealCount = (edges: Array<{ lineIds: Set<string> }>) =>
  edges.filter((e) => e.lineIds.has(TEAL)).length;

const inputFromGraph = (topo as never as Record<string, (...a: never[]) => unknown>)['inputFromGraph'];
const inputFromBuilder = (topo as never as Record<string, (...a: never[]) => unknown>)['inputFromBuilder'];
if (!inputFromGraph || !inputFromBuilder) {
  console.log('input helpers not exported; aborting probe');
  process.exit(0);
}
let input = (inputFromGraph as (g: unknown, p?: unknown) => { edges: Array<{ lineIds: Set<string> }> })(graph, undefined);
console.log('round 0 (graph input): teal edges =', tealCount(input.edges), '/', input.edges.length);
let h: ReturnType<typeof topo.collapseSharedSegments> | null = null;
for (let round = 1; round <= 8; round++) {
  const next = topo.collapseSharedSegments(input as never, params);
  const edges = next.edgeList();
  console.log(`round ${round}: teal edges = ${tealCount(edges)} / ${edges.length}`);
  h = next;
  input = (inputFromBuilder as (h: unknown) => { edges: Array<{ lineIds: Set<string> }> })(h);
}
