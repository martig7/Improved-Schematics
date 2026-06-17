// Throwaway (dHat sweep): do blue and pink connect the SAME node pairs along
// the center diagonal? Lists transit-graph edges in the window with from/to
// node ids and line colors.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const inner = dump['debug-render-input'] ?? dump;
const { routes, tracks, stations, stationGroups } = inner;
const colorOf = new Map<string, string>(routes.map((r: { id: string; color: string }) => [r.id, r.color]));

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

const win = (p?: Pixel) => !!p && p[0] >= 880 && p[0] <= 1250 && p[1] >= 1080 && p[1] <= 1580;
const rows: string[] = [];
for (const e of graph.edges) {
  const pf = graph.nodes.get(e.from)?.pos;
  const pt = graph.nodes.get(e.to)?.pos;
  if (!win(pf) && !win(pt)) continue;
  const cols = [...new Set(e.lines.map((l) => colorOf.get(l.id) ?? '?'))].join('+');
  if (!/0039a6|b933ad/i.test(cols)) continue;
  rows.push(
    `${e.id}: ${e.from}(${pf![0].toFixed(0)},${pf![1].toFixed(0)}) -> ${e.to}(${pt![0].toFixed(0)},${pt![1].toFixed(0)}) ${cols} geoPts=${e.geo?.length ?? 0}`,
  );
}
rows.sort();
console.log(rows.join('\n'));
