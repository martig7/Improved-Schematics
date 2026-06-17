// Probe: why do Watts St / Howard St get pushed UP toward St Lukes Pl /
// Houston St? For each named station dump its position at three stages so we
// can see WHERE the vertical displacement enters:
//   base  = raw geographic projection (no warp)
//   warp  = density-warped projection (what the layout treats as "true")
//   drawn = octi's final placed pixel (after support+octi+merge+expand)
// Up-displacement base->warp = the projection/warp's doing; warp->drawn =
// octi placement / chain redistribution.
// Usage: npx tsx dev/_probe-stn.ts ["St Lukes Pl" "Houston St" ...]
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const NAMES = process.argv.slice(2);
if (NAMES.length === 0) NAMES.push('St Lukes Pl', 'Houston St', 'Watts St', 'Howard St', 'Waverly Pl');

const dump = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const groups = getOrBuildStationGroups(stations, stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);
const bounds = (() => {
  const fr: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
  for (const e of graph.edges) if (e.geo) fr.push({ points: e.geo });
  const b = computeBounds(fr);
  return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
})();
const W = 2700, H = 2700;
const baseProj = createProjection(bounds, W, H, 0.06);
const ws: Pixel[] = [];
for (const n of graph.nodes.values()) {
  const p = baseProj.toSVG(n.lngLat);
  const ls = new Set<string>();
  for (const eid of graph.adj.get(n.id) ?? []) { const e = graph.edges.find((x) => x.id === eid); if (e) for (const l of e.lines) ls.add(l.id); }
  const w = Math.max(1, Math.min(4, ls.size));
  for (let i = 0; i < w; i++) ws.push(p);
}
const warp = buildDensityWarp(ws, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

const dHat = 16;
const params: TopoParams = { dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8, stationCandidateRadius: 2 * dHat, preserveStations: false };
const h = buildSupportGraph(graph, groups, params);
const divisor = Number(process.env.OCTI_DIVISOR) || (h.edges.size > 800 ? 1.2 : 1.6);
const densityPen = Number(process.env.OCTI_DENSITY ?? 0.5);
const ndMovePen = Number(process.env.OCTI_NDMOVE ?? 0.5);
const affinity = Number(process.env.OCTI_AFFINITY ?? 0.05);
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h) / divisor),
  geographicAffinity: Number.isFinite(affinity) ? affinity : 0.05,
  penalties: {
    densityPen: Number.isFinite(densityPen) ? densityPen : 0.5,
    ndMovePen: Number.isFinite(ndMovePen) ? ndMovePen : 0.5,
  },
};
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
separateFusedStations(merged.h, merged.img, dHat);
const hh = merged.h;
const image = merged.img;

// group name -> center coordinate
const centerByName = new Map<string, Coordinate>();
for (const g of groups) if (!centerByName.has(g.name)) centerByName.set(g.name, g.center);
// station name -> nodeId + truePos (from the merged support graph stations)
const stByName = new Map<string, { nodeId: string; truePos?: Pixel; deg: number }>();
for (const st of hh.stations.values()) {
  if (stByName.has(st.label)) continue;
  stByName.set(st.label, { nodeId: st.nodeId, truePos: st.truePos, deg: (hh.adj.get(st.nodeId) ?? []).length });
}

const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(?)');
console.log('station                base(noWarp)   warp(true)     drawn(octi)    | dY base->warp  warp->drawn');
const rows: Array<{ name: string; base: Pixel; warp: Pixel; drawn?: Pixel }> = [];
for (const name of NAMES) {
  const c = centerByName.get(name);
  if (!c) { console.log(`${name}: (no group)`); continue; }
  const base = baseProj.toSVG(c) as Pixel;
  const warpP = proj.toSVG(c) as Pixel;
  const st = stByName.get(name);
  const drawn = st ? image.placement.get(st.nodeId) : undefined;
  rows.push({ name, base, warp: warpP, drawn: drawn as Pixel | undefined });
  const dyBW = (warpP[1] - base[1]).toFixed(0);
  const dyWD = drawn ? (drawn[1] - warpP[1]).toFixed(0) : '?';
  console.log(
    `${name.padEnd(22)} ${fmt(base).padEnd(14)} ${fmt(warpP).padEnd(14)} ${fmt(drawn).padEnd(14)} | ${dyBW.padStart(8)}      ${dyWD.padStart(8)}  ` +
    `${st ? `deg=${st.deg} node=${st.nodeId}` : '(no node)'}`,
  );
}

// pairwise vertical gaps among the listed stations at each stage (so we can see
// who got pushed close to whom). Sorted top-to-bottom by drawn y.
console.log('\nvertical order + gaps (drawn):');
const drawn = rows.filter((r) => r.drawn).sort((a, b) => a.drawn![1] - b.drawn![1]);
for (let i = 0; i < drawn.length; i++) {
  const r = drawn[i];
  const gap = i > 0 ? (r.drawn![1] - drawn[i - 1].drawn![1]).toFixed(0) : '-';
  console.log(`  ${fmt(r.drawn)}  ${r.name.padEnd(20)} dY-from-above=${gap}`);
}
console.log('\nvertical order + gaps (warp/true):');
const warpOrder = rows.slice().sort((a, b) => a.warp[1] - b.warp[1]);
for (let i = 0; i < warpOrder.length; i++) {
  const r = warpOrder[i];
  const gap = i > 0 ? (r.warp[1] - warpOrder[i - 1].warp[1]).toFixed(0) : '-';
  console.log(`  ${fmt(r.warp)}  ${r.name.padEnd(20)} dY-from-above=${gap}`);
}

// ---- parseable sweep summary --------------------------------------------
// Global switchback metric: count vertices in the FINAL drawn corridors where
// the path turns by ≥~107° (a near-reversal = a switchback zigzag). A spike vs
// baseline = densityPen bought zigzags. Cap each path at its real bends; ignore
// micro-segments (<1px).
let switchbacks = 0;
for (const path of image.paths.values()) {
  for (let i = 2; i < path.length; i++) {
    const ax = path[i - 1][0] - path[i - 2][0], ay = path[i - 1][1] - path[i - 2][1];
    const bx = path[i][0] - path[i - 1][0], by = path[i][1] - path[i - 1][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1 || lb < 1) continue;
    if ((ax * bx + ay * by) / (la * lb) < -0.3) switchbacks++;
  }
}
const drawnYs = rows.filter((r) => r.drawn).map((r) => r.drawn![1]);
const spread = drawnYs.length ? Math.max(...drawnYs) - Math.min(...drawnYs) : 0;
const wh = rows.find((r) => r.name === 'Watts St');
const ho = rows.find((r) => r.name === 'Howard St');
const whGap = wh?.drawn && ho?.drawn ? Math.abs(ho.drawn[1] - wh.drawn[1]) : -1;
const warpYs = rows.map((r) => r.warp[1]);
const warpSpread = Math.max(...warpYs) - Math.min(...warpYs);
console.log(
  `\nSUMMARY density=${densityPen} ndMove=${ndMovePen} divisor=${divisor} affinity=${affinity} ` +
  `drawnSpread=${spread.toFixed(0)} warpSpread=${warpSpread.toFixed(0)} ` +
  `wattsHowardGap=${whGap.toFixed(0)} switchbacks=${switchbacks}`,
);
