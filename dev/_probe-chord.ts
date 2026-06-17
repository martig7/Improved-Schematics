// Throwaway: walk navy's traversal; flag steps whose path endpoints don't
// chain (orientation/continuity mismatches).
import { readFileSync } from 'fs';
import { buildTransitGraph, getOrBuildStationGroups } from '../src/render/layout/graph';
import { buildSupportGraph } from '../src/render/layout/topo';
import type { TopoParams } from '../src/render/layout/topo';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';
import type { Route, Track } from '../src/types/game-state';
import type { Coordinate } from '../src/types/core';

const NAVY = 'd49dc638-b179-427a-b4be-3734e7cf6b16';
const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const raw = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8'));
const data = raw.data ?? raw;

const groups = getOrBuildStationGroups(data.stations as never, undefined);
const graph = buildTransitGraph(data.stations as never, (data.routes ?? []) as Route[], groups, (data.tracks ?? []) as Track[]);
const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
const b = computeBounds(framePts)!;
const baseProj = createProjection(padBounds(b, 0.1), 2000, 2000, 0.06);
const warp = buildDensityWarp(
  [...graph.nodes.values()].map((n) => baseProj.toSVG(n.lngLat)),
  { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
  { alpha: 0.6 },
);
for (const n of graph.nodes.values()) n.pos = warp(baseProj.toSVG(n.lngLat));

const dHat = Math.max(8, 5 * 4);
const topoParams: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, topoParams);
const medLen = medianEdgeLength(support);
const img = octi(support, { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medLen / 2.5) });

const trav = support.lineTraversals.get(NAVY) ?? [];
let prevEnd: [number, number] | null = null;
let prevEndNode: string | null = null;
for (const step of trav) {
  const e = support.edges.get(step.edgeId);
  if (!e) { console.log(step.edgeId, 'MISSING EDGE'); continue; }
  const path = img.paths.get(step.edgeId)!;
  const p = step.reversed ? [...path].reverse() : path;
  const startNode = step.reversed ? e.to : e.from;
  const endNode = step.reversed ? e.from : e.to;
  const gap = prevEnd && prevEndNode === startNode
    ? Math.hypot(p[0][0] - prevEnd[0], p[0][1] - prevEnd[1])
    : -1;
  if (gap > 1) {
    console.log(
      `GAP ${gap.toFixed(0)}px before ${step.edgeId} rev=${step.reversed} ` +
      `(${startNode}->${endNode}) pathStart=${p[0].map((v) => v.toFixed(0))} ` +
      `prevEnd=${prevEnd!.map((v) => v.toFixed(0))} ` +
      `placement(start)=${img.placement.get(startNode)?.map((v) => v.toFixed(0))}`,
    );
  }
  prevEnd = [p[p.length - 1][0], p[p.length - 1][1]];
  prevEndNode = endNode;
}
console.log('steps:', trav.length);
