// Probe: the yellow B line at Republican St — stop flags, serving edges,
// traversal steps around the junction.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph, buildGroupMaps, walkRouteVisits, stopOnlyVisits } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const groups = getOrBuildStationGroups(stations, stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);
const B = routes.find((r: { id: string }) => r.id.startsWith('1bef2cd7'));
const { stNodeToGroup, trackToGroup } = buildGroupMaps(stations, groups);
const nameOf = new Map(groups.map((g) => [g.id, g.name + '/' + g.id.slice(0, 6)]));
const stops = stopOnlyVisits(walkRouteVisits(B, stNodeToGroup, trackToGroup));
console.log('B stops:', stops.map((v) => nameOf.get(v.groupId)).join(' > '));

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
  warpSamples.push(p, p);
}
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const h0 = buildSupportGraph(graph, groups, params);
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h0) / (h0.edges.size > 800 ? 1.2 : 1.6)),
  geographicAffinity: 0.05,
};
const img = octi(h0, octiOpts);
const merged = mergeCoincidentPaths(h0, img);
separateFusedStations(merged.h, merged.img, 16);
const h = merged.h;

const bid = B.id as string;
const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '?');
for (const g of groups.filter((x) => x.name === 'Republican St' || x.name === 'Blanchard St' || x.name === 'Taylor Av')) {
  const st = h.stations.get(g.id);
  if (!st) continue;
  const flag = st.stopNodes?.get(bid);
  console.log(
    `${g.name}/${g.id.slice(0, 6)}: node=${st.nodeId}${fmt(h.nodes.get(st.nodeId)?.pos)} ` +
    `B-flag=${flag ?? '-'}${flag ? fmt(h.nodes.get(flag)?.pos) : ''} stopLines=${[...(st.stopLines ?? [])].map((l) => l.slice(0, 6)).join(',')}`,
  );
}
// B traversal around the junction (nodes with positions)
const steps = h.lineTraversals.get(bid) ?? [];
const seq: string[] = [];
for (const s of steps) {
  const e = h.edges.get(s.edgeId);
  if (!e) continue;
  const b2 = s.reversed ? e.from : e.to;
  const p = h.nodes.get(b2)?.pos;
  if (p && p[0] > 1020 && p[0] < 1260 && p[1] > 960 && p[1] < 1150) {
    seq.push(`${b2}${fmt(p)}`);
  } else if (seq.length && seq[seq.length - 1] !== '..') {
    seq.push('..');
  }
}
console.log('B traversal nodes in window:', seq.join(' > '));
