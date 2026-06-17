// Throwaway (dHat sweep): which STAGE conjoins blue (#0039a6) and pink
// (#b933ad)? Checks the raw transit graph (pre-topo) for edges already
// carrying both lines (= shared tracks in the game dump), and measures the
// geographic gap between blue-only and pink-only polylines along the center
// diagonal, in px and in dHat units.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const inner = dump['debug-render-input'] ?? dump;
const { routes, tracks, stations, stationGroups } = inner;
const BLUE = new Set<string>(routes.filter((r: { color: string }) => r.color.toLowerCase() === '#0039a6').map((r: { id: string }) => r.id));
const PINK = new Set<string>(routes.filter((r: { color: string }) => r.color.toLowerCase() === '#b933ad').map((r: { id: string }) => r.id));

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

// 1) transit-graph edges already carrying both colors
let both = 0;
const samples: string[] = [];
for (const e of graph.edges) {
  const ids = new Set(e.lines.map((l) => l.id));
  const hasB = [...ids].some((i) => BLUE.has(i));
  const hasP = [...ids].some((i) => PINK.has(i));
  if (hasB && hasP) {
    both++;
    if (samples.length < 12) {
      const pf = graph.nodes.get(e.from)?.pos ?? [0, 0];
      const pt = graph.nodes.get(e.to)?.pos ?? [0, 0];
      samples.push(`  ${e.id}: (${pf[0].toFixed(0)},${pf[1].toFixed(0)})->(${pt[0].toFixed(0)},${pt[1].toFixed(0)})`);
    }
  }
}
console.log(`transit graph: ${graph.edges.length} edges; edges carrying BOTH blue+pink: ${both}`);
for (const s of samples) console.log(s);

// 2) in the center window (x 900-1250, y 1100-1550): blue-only vs pink-only
// polyline geometry — min/median gap between the two corridors.
const win = (p: Pixel) => p[0] >= 880 && p[0] <= 1300 && p[1] >= 1080 && p[1] <= 1580;
type Poly = Pixel[];
const bluePts: Pixel[] = [];
const pinkPts: Pixel[] = [];
for (const e of graph.edges) {
  const ids = new Set(e.lines.map((l) => l.id));
  const hasB = [...ids].some((i) => BLUE.has(i));
  const hasP = [...ids].some((i) => PINK.has(i));
  const geo: Poly = (e.geo ?? []).map((c: Coordinate) => proj.toSVG(c) as Pixel);
  const pts = geo.filter(win);
  if (hasB && !hasP) bluePts.push(...pts);
  if (hasP && !hasB) pinkPts.push(...pts);
  if (hasB && hasP) {
    // shared-track edge inside the window
    if (pts.length) console.log(`  SHARED-track edge in center window: ${e.id} (${pts.length} pts)`);
  }
}
console.log(`center window: blue-only sample pts=${bluePts.length}, pink-only=${pinkPts.length}`);
if (bluePts.length && pinkPts.length) {
  const gaps = bluePts.map((b) => Math.min(...pinkPts.map((p) => Math.hypot(b[0] - p[0], b[1] - p[1])))).sort((a, b) => a - b);
  const q = (f: number) => gaps[Math.floor(f * (gaps.length - 1))].toFixed(1);
  console.log(`blue->pink gap px: min=${q(0)} p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} max=${q(1)}`);
}
