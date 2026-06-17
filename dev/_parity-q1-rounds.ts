// Throwaway Q1: at which merge round do blue+pink weld? And per-pink-route
// attribution of the close approaches.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, runMergeRounds, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;

const BLUE = '6b681564-4446-4daa-96be-17f7620b8d5c';
const PINK_A = 'a3f11a38-2a9e-4fe2-bd23-2c1a73bbcb12';
const PINK_B = 'bbf5a87e-686a-42c0-927b-365871373427';

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

const dHat = 16;
for (const useGeo of [false, true]) {
  for (const maxRounds of [1, 2, 3, 8]) {
    const params: TopoParams = {
      dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds,
      stationCandidateRadius: 2 * dHat, preserveStations: false,
      ...(useGeo ? { projectGeo: (c: Coordinate) => proj.toSVG(c) as Pixel } : {}),
    };
    const h = runMergeRounds(graph, params);
    let sharedA = 0, sharedB = 0, sharedLen = 0;
    const where: string[] = [];
    for (const e of h.edgeList()) {
      const hasBlue = e.lineIds.has(BLUE);
      if (!hasBlue) continue;
      let len = 0;
      for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i][0]-e.points[i-1][0], e.points[i][1]-e.points[i-1][1]);
      if (e.lineIds.has(PINK_A)) { sharedA++; sharedLen += len; where.push(`A@(${e.points[0][0].toFixed(0)},${e.points[0][1].toFixed(0)})len${len.toFixed(0)}`); }
      if (e.lineIds.has(PINK_B)) { sharedB++; sharedLen += len; where.push(`B@(${e.points[0][0].toFixed(0)},${e.points[0][1].toFixed(0)})len${len.toFixed(0)}`); }
    }
    console.log(`useGeo=${useGeo} maxRounds=${maxRounds}: edges=${h.edgeList().length} blue+pinkA=${sharedA} blue+pinkB=${sharedB} sharedLen=${sharedLen.toFixed(0)}px ${where.slice(0,8).join(' ')}`);
  }
}
