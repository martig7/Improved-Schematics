// Throwaway Q1 probe: do blue (#0039a6) and pink (#b933ad) share support edges
// (topo merged) or only drawn paths? Also measure true pre-merge lateral
// separation (warped px AND ground meters) along the conjoined stretch.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;

const BLUE = '6b681564-4446-4daa-96be-17f7620b8d5c';
const PINKS = ['a3f11a38-2a9e-4fe2-bd23-2c1a73bbcb12', 'bbf5a87e-686a-42c0-927b-365871373427'];

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

// ---- ground-meter helpers ----
const R = 6378137;
function groundMeters(a: Coordinate, b: Coordinate): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return R * Math.hypot(dLat, dLng * Math.cos(lat));
}

// ---- input-graph corridors for blue/pink ----
type GeoSeg = { eid: string; from: string; to: string; geo: Coordinate[] };
function corridorOf(lineId: string): GeoSeg[] {
  const out: GeoSeg[] = [];
  for (const e of graph.edges) {
    if (!e.lines.some((l) => l.id === lineId)) continue;
    const geo = e.geo ?? [graph.nodes.get(e.from)!.lngLat, graph.nodes.get(e.to)!.lngLat];
    out.push({ eid: e.id, from: e.from, to: e.to, geo });
  }
  return out;
}
const blueCorr = corridorOf(BLUE);
const pinkCorrs = PINKS.map((p) => corridorOf(p));
console.log(`input graph: blue edges=${blueCorr.length} pink0 edges=${pinkCorrs[0].length} pink1 edges=${pinkCorrs[1].length}`);

// node label helper
const nodeLabel = (id: string) => graph.nodes.get(id)?.label ?? id.slice(0, 8);

// ---- support graph at production dHat ----
const dHat = Math.max(8, 4 * 4); // theme.lineWidth=4 -> 16
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);

// support edges carrying blue AND any pink
console.log(`\n== support edges (dHat=${dHat}px) carrying BLUE + PINK ==`);
let shared = 0;
for (const e of h.edges.values()) {
  const hasBlue = e.lineIds.has(BLUE);
  const hasPink = PINKS.some((p) => e.lineIds.has(p));
  if (hasBlue && hasPink) {
    shared++;
    const pf = h.nodes.get(e.from)!.pos, pt = h.nodes.get(e.to)!.pos;
    let len = 0;
    for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i][0] - e.points[i-1][0], e.points[i][1] - e.points[i-1][1]);
    // nearest stations to endpoints
    const near = (p: Pixel) => {
      let best = '', bd = Infinity;
      for (const s of h.stations.values()) {
        const np = h.nodes.get(s.nodeId)?.pos; if (!np) continue;
        const d = Math.hypot(np[0]-p[0], np[1]-p[1]);
        if (d < bd) { bd = d; best = s.label; }
      }
      return `${best}(${bd.toFixed(0)}px)`;
    };
    console.log(`  ${e.id}: (${pf[0].toFixed(0)},${pf[1].toFixed(0)})->(${pt[0].toFixed(0)},${pt[1].toFixed(0)}) len=${len.toFixed(0)} lines=[${[...e.lineIds].map(l=>l.slice(0,6)).join(',')}] near ${near(pf)} .. ${near(pt)}`);
  }
}
console.log(`total shared blue+pink support edges: ${shared}`);

// ---- pre-merge separation along the conjoined stretch ----
// For every densified point on the blue corridor (warped px), distance to the
// nearest pink corridor point (warped px) and the geo equivalents.
function densify(geo: Coordinate[], maxM = 60): Coordinate[] {
  const out: Coordinate[] = [geo[0]];
  for (let i = 1; i < geo.length; i++) {
    const a = geo[i-1], b = geo[i];
    const d = groundMeters(a, b);
    const n = Math.max(1, Math.ceil(d / maxM));
    for (let k = 1; k <= n; k++) out.push([a[0]+(b[0]-a[0])*k/n, a[1]+(b[1]-a[1])*k/n]);
  }
  return out;
}
const pinkPtsGeo: Coordinate[] = [];
for (const corr of pinkCorrs) for (const s of corr) pinkPtsGeo.push(...densify(s.geo));
const pinkPtsPx = pinkPtsGeo.map((c) => proj.toSVG(c) as Pixel);

console.log('\n== blue corridor vs nearest pink (densified, per blue input edge) ==');
console.log('edge  from->to  minPx  minM  (at warped px)  localScale m/px');
for (const s of blueCorr) {
  const dg = densify(s.geo);
  let minPx = Infinity, minM = Infinity, at: Pixel = [0,0], atGeo: Coordinate = [0,0];
  for (const g of dg) {
    const p = proj.toSVG(g) as Pixel;
    for (let j = 0; j < pinkPtsGeo.length; j++) {
      const dPx = Math.hypot(p[0]-pinkPtsPx[j][0], p[1]-pinkPtsPx[j][1]);
      if (dPx < minPx) {
        minPx = dPx; minM = groundMeters(g, pinkPtsGeo[j]); at = p; atGeo = g;
      }
    }
  }
  // local scale: meters per warped px at atGeo (sample small offsets)
  const eps = 0.0005;
  const g2: Coordinate = [atGeo[0] + eps, atGeo[1]];
  const g3: Coordinate = [atGeo[0], atGeo[1] + eps];
  const p2 = proj.toSVG(g2) as Pixel, p3 = proj.toSVG(g3) as Pixel;
  const scaleX = groundMeters(atGeo, g2) / Math.hypot(p2[0]-at[0], p2[1]-at[1]);
  const scaleY = groundMeters(atGeo, g3) / Math.hypot(p3[0]-at[0], p3[1]-at[1]);
  console.log(`  ${s.eid.slice(0,10)} ${nodeLabel(s.from)}->${nodeLabel(s.to)}  ${minPx.toFixed(1)}px  ${minM.toFixed(0)}m  @(${at[0].toFixed(0)},${at[1].toFixed(0)})  scale=(${scaleX.toFixed(1)},${scaleY.toFixed(1)})`);
}
