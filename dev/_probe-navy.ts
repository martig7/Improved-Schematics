// Throwaway: trace the navy route (d49dc638, #0039a6) through the smoothed
// pipeline with the density warp on/off to find where it gets dropped.
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

for (const alpha of [0, 0.6]) {
  const groups = getOrBuildStationGroups(data.stations as never, undefined);
  const graph = buildTransitGraph(data.stations as never, (data.routes ?? []) as Route[], groups, (data.tracks ?? []) as Track[]);
  const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
  for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
  const b = computeBounds(framePts)!;
  const baseProj = createProjection(padBounds(b, 0.1), 2000, 2000, 0.06);
  const warp = buildDensityWarp(
    [...graph.nodes.values()].map((n) => baseProj.toSVG(n.lngLat)),
    { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    { alpha },
  );
  for (const n of graph.nodes.values()) n.pos = warp(baseProj.toSVG(n.lngLat));

  const inGraph = graph.lineTraversals.get(NAVY)?.length ?? -1;

  const dHat = Math.max(8, 5 * 4);
  const topoParams: TopoParams = {
    dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
    stationCandidateRadius: 2 * dHat, preserveStations: false,
  };
  const support = buildSupportGraph(graph, groups, topoParams);
  const trav = support.lineTraversals.get(NAVY);
  const inSupport = trav?.length ?? -1;
  let missingEdges = 0;
  if (trav) for (const s of trav) if (!support.edges.has(s.edgeId)) missingEdges++;
  let navyEdges = 0;
  for (const e of support.edges.values()) if (e.lineIds.has(NAVY)) navyEdges++;

  const medLen = medianEdgeLength(support);
  const img = octi(support, { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medLen / 2.5) });
  let degenerate = 0;
  let missingPaths = 0;
  if (trav) {
    for (const s of trav) {
      const p = img.paths.get(s.edgeId);
      if (!p) { missingPaths++; continue; }
      let len = 0;
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (len < 1e-6) degenerate++;
    }
  }
  console.log(
    `alpha=${alpha}: graphTravSteps=${inGraph} supportTravSteps=${inSupport} ` +
    `navyEdgesInSupport=${navyEdges} travEdgesMissingFromSupport=${missingEdges} ` +
    `octiPathsMissing=${missingPaths} octiPathsDegenerate=${degenerate}`,
  );
}
