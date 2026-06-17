// Probe: where do the abrupt corridor corners live? Build the merged graph +
// octi image (same path as _probe-flat) and scan the DRAWN corridor geometry
// for sharp turns. For each support node, gather incident drawn-edge departure
// directions, and for every pair of incident edges that SHARE a line (a
// through-corridor / bundle), measure the deflection. Classify the node by
// degree, distinct line count, and station status. The goal is to confirm the
// "straight multi-bundle node" predicate for the octi turn-angle bias.
//
// Usage: npx tsx dev/_probe-turn.ts            (global sharp-turn report)
//        npx tsx dev/_probe-turn.ts <x> <y>    (also dump nodes near a coord)
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const focus = process.argv.length >= 4 ? ([Number(process.argv[2]), Number(process.argv[3])] as Pixel) : null;

const dump = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
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
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medianEdgeLength(h) / divisor), geographicAffinity: 0.05 };
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
separateFusedStations(merged.h, merged.img, dHat);

const hh = merged.h;
const image = merged.img;
const bullet = (lid: string) => hh.lineRefs.get(lid)?.label ?? lid.slice(0, 4);

const nodeNames = new Map<string, string[]>();
for (const st of hh.stations.values()) {
  const a = nodeNames.get(st.nodeId) ?? []; a.push(st.label); nodeNames.set(st.nodeId, a);
}
const isStation = (nid: string) => nodeNames.has(nid);

const posOf = (nid: string): Pixel | undefined => image.placement.get(nid) ?? hh.nodes.get(nid)?.pos;

// Departure direction (unit vector) of edge e leaving node nid, taken a short
// distance along the DRAWN path so micro-wiggles at the node don't dominate.
const departDir = (eid: string, nid: string): Pixel | null => {
  const e = hh.edges.get(eid);
  if (!e) return null;
  const path = image.paths.get(eid);
  if (!path || path.length < 2) {
    const other = e.from === nid ? e.to : e.from;
    const a = posOf(nid); const b = posOf(other);
    if (!a || !b) return null;
    const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy);
    return L < 1e-6 ? null : [dx / L, dy / L];
  }
  const pts = e.from === nid ? path : [...path].reverse();
  const a = pts[0];
  let ref = pts[pts.length - 1];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc >= 18) { ref = pts[i]; break; }
  }
  const dx = ref[0] - a[0], dy = ref[1] - a[1]; const L = Math.hypot(dx, dy);
  return L < 1e-6 ? null : [dx / L, dy / L];
};

const linesOf = (eid: string): Set<string> => hh.edges.get(eid)?.lineIds ?? new Set();

interface PairInfo { e: string; f: string; deg: number; shared: string[]; }

// For each node: distinct line count, station status, and the through-corridor
// pairs (incident edges sharing >=1 line) with their deflection angle.
interface NodeReport {
  nid: string; pos: Pixel; deg: number; lineCount: number; station: boolean;
  maxShareDefl: number; pairs: Array<{ deflDeg: number; shared: number; e: string; f: string }>;
}
const reports: NodeReport[] = [];
for (const nid of hh.nodes.keys()) {
  const inc = hh.adj.get(nid) ?? [];
  if (inc.length < 2) continue;
  const pos = posOf(nid);
  if (!pos) continue;
  const lineSet = new Set<string>();
  for (const eid of inc) for (const l of linesOf(eid)) lineSet.add(l);
  const dirs = new Map<string, Pixel>();
  for (const eid of inc) { const d = departDir(eid, nid); if (d) dirs.set(eid, d); }
  const pairs: NodeReport['pairs'] = [];
  for (let i = 0; i < inc.length; i++) {
    for (let j = i + 1; j < inc.length; j++) {
      const a = dirs.get(inc[i]); const b = dirs.get(inc[j]);
      if (!a || !b) continue;
      const la = linesOf(inc[i]); const lb = linesOf(inc[j]);
      let shared = 0; for (const l of la) if (lb.has(l)) shared++;
      if (shared === 0) continue;
      // deflection of a line going e->f: 180 - interiorAngle(dirE,dirF)
      const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
      const interior = Math.acos(dot) * 180 / Math.PI;
      const defl = 180 - interior;
      pairs.push({ deflDeg: defl, shared, e: inc[i], f: inc[j] });
    }
  }
  if (pairs.length === 0) continue;
  pairs.sort((x, y) => y.deflDeg - x.deflDeg);
  reports.push({
    nid, pos, deg: inc.length, lineCount: lineSet.size, station: isStation(nid),
    maxShareDefl: pairs[0].deflDeg, pairs,
  });
}

const fmt = (p: Pixel) => `(${p[0].toFixed(0)},${p[1].toFixed(0)})`;
const sharedBullets = (e: string, f: string): string => {
  const la = linesOf(e); const lb = linesOf(f);
  return [...la].filter((l) => lb.has(l)).map(bullet).sort().join(',');
};

// GLOBAL: non-station, multi-bundle (>=2 lines) nodes whose through-corridor
// bends >=80deg — the abrupt corner candidates the bias should soften.
console.log('=== Non-station multi-bundle nodes with a sharp (>=80) through-bend ===');
const sharp = reports
  .filter((r) => !r.station && r.lineCount >= 2 && r.maxShareDefl >= 80)
  .sort((a, b) => b.maxShareDefl - a.maxShareDefl);
console.log(`count=${sharp.length}`);
for (const r of sharp.slice(0, 40)) {
  const p = r.pairs[0];
  console.log(
    `  ${r.nid} ${fmt(r.pos)} deg=${r.deg} lines=${r.lineCount} ` +
    `maxDefl=${r.maxShareDefl.toFixed(0)} on {${sharedBullets(p.e, p.f)}}`,
  );
}

if (focus) {
  console.log(`\n=== Nodes within 70px of ${fmt(focus)} ===`);
  const near = reports
    .filter((r) => Math.hypot(r.pos[0] - focus[0], r.pos[1] - focus[1]) < 70)
    .sort((a, b) => Math.hypot(a.pos[0] - focus[0], a.pos[1] - focus[1]) - Math.hypot(b.pos[0] - focus[0], b.pos[1] - focus[1]));
  for (const r of near) {
    console.log(
      `  ${r.nid} ${fmt(r.pos)} deg=${r.deg} lines=${r.lineCount} station=${r.station} ` +
      `names=[${(nodeNames.get(r.nid) ?? []).join('+')}]`,
    );
    for (const p of r.pairs) {
      console.log(`      defl=${p.deflDeg.toFixed(0)} shared=${p.shared} {${sharedBullets(p.e, p.f)}}  ${p.e}<->${p.f}`);
    }
    for (const eid of hh.adj.get(r.nid) ?? []) {
      const path = image.paths.get(eid);
      if (!path) continue;
      const e = hh.edges.get(eid)!;
      const pts = e.from === r.nid ? path : [...path].reverse();
      console.log(`      PATH ${eid} {${[...e.lineIds].map(bullet).sort().join(',')}}: ${pts.map((q) => `(${q[0].toFixed(0)},${q[1].toFixed(0)})`).join(' ')}`);
    }
  }
}
