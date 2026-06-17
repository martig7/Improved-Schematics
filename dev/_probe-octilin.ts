// Throwaway: which final Image paths are NOT octilinear, and why (id forensics).
import { readFileSync } from 'fs';
import { buildTransitGraph, getOrBuildStationGroups } from '../src/render/layout/graph';
import { buildSupportGraph } from '../src/render/layout/topo';
import type { TopoParams } from '../src/render/layout/topo';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';
import type { Route, Track } from '../src/types/game-state';
import type { Coordinate } from '../src/types/core';

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

let bad = 0;
for (const [id, path] of img.paths) {
  let worst = 0;
  let badSegLen = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i][0] - path[i - 1][0]);
    const dy = Math.abs(path[i][1] - path[i - 1][1]);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const oct = dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6;
    if (!oct) {
      const dev = Math.min(dx, dy, Math.abs(dx - dy)) / len;
      if (dev > worst) { worst = dev; badSegLen = len; }
    }
  }
  if (worst > 0.02 && badSegLen > 8) {
    bad++;
    const e = support.edges.get(id);
    console.log(
      `non-octilinear: ${id} segLen=${badSegLen.toFixed(0)} dev=${worst.toFixed(2)} ` +
      `lines=[${e ? [...e.lineIds].map((l) => l.slice(0, 8)).join(',') : '?'}]`,
    );
  }
}
console.log('total non-octilinear paths:', bad, 'of', img.paths.size);
