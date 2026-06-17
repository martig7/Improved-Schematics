// Throwaway: drawn-geometry comparison for the SW Tacoma clump.
// OURS: run octi + mergeCoincidentPaths exactly like renderSmoothed, then
// measure detour ratio, bends/10km, and tight parallel runs in the window.
// LOOM: parse out-loom-sea.svg cyan polylines in the same geographic bbox.
// Artifacts: dev/_parity-loom-sw.png (geo-matched LOOM crop),
//            dev/_parity-support-sw.png (our support graph, raw polylines),
//            dev/_parity-octi-sw.png (our octi corridors, no decoration).
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

type Pt = [number, number];
const R = 6378137;
const merc = (lng: number, lat: number): Pt => [
  (R * lng * Math.PI) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
const polyLen = (pts: Pt[]): number => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
};
const bendCount = (pts: Pt[], minDeg = 30): number => {
  let n = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
    if ((Math.acos(cos) * 180) / Math.PI >= minDeg) n++;
  }
  return n;
};
const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
const minDistToPoly = (p: Pt, Q: Pt[]): number => {
  let mn = Infinity;
  for (let i = 1; i < Q.length; i++) mn = Math.min(mn, segDist(p, Q[i - 1], Q[i]));
  return mn;
};
const resample = (pts: Pt[], step: number): Pt[] => {
  const out: Pt[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    let d = Math.hypot(x1 - x0, y1 - y0);
    while (acc + d >= step) {
      const t = (step - acc) / d;
      const nx = x0 + t * (x1 - x0), ny = y0 + t * (y1 - y0);
      out.push([nx, ny]); x0 = nx; y0 = ny;
      d = Math.hypot(x1 - x0, y1 - y0); acc = 0;
    }
    acc += d;
  }
  out.push(pts[pts.length - 1]);
  return out;
};

// ---------- OUR PIPELINE ----------
const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const cyanIds = new Set<string>(routes.filter((r: { color: string }) => r.color?.toLowerCase() === '#00add0').map((r: { id: string }) => r.id));
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
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, params);
const medLen = medianEdgeLength(support);
const divisor = support.edges.size > 800 ? 1.2 : 2.5;
const cellPx = Math.max(12, medLen / divisor);
console.log(`support ${support.nodes.size}n/${support.edges.size}e cell=${cellPx.toFixed(1)}px`);

const t0 = Date.now();
const imageRaw = octi(support, { ...DEFAULT_OCTI_OPTIONS, cellSize: cellPx });
const { h: hM, img } = mergeCoincidentPaths(support, imageRaw);
console.log(`octi done in ${((Date.now() - t0) / 1000).toFixed(1)}s; merged ${hM.edges.size} edges, cell=${img.cellSize.toFixed(1)}`);

const WIN = { x0: 450, y0: 1850, x1: 1700, y1: 2750 };
const inWinP = (p: Pt) => p[0] >= WIN.x0 && p[0] <= WIN.x1 && p[1] >= WIN.y0 && p[1] <= WIN.y1;
const M_PER_PX = 63.3;

// window edges: both placed endpoints in window
interface DrawnE { id: string; drawn: Pt[]; sup: Pt[]; lines: Set<string>; from: string; to: string }
const drawn: DrawnE[] = [];
for (const e of hM.edges.values()) {
  const pf = img.placement.get(e.from), pt = img.placement.get(e.to);
  const path = img.paths.get(e.id);
  if (!pf || !pt || !path) continue;
  if (!inWinP(pf as Pt) || !inWinP(pt as Pt)) continue;
  drawn.push({ id: e.id, drawn: path as Pt[], sup: e.points as Pt[], lines: e.lineIds, from: e.from, to: e.to });
}
const cyanD = drawn.filter((d) => [...d.lines].some((l) => cyanIds.has(l)));
const supLen = cyanD.reduce((a, d) => a + polyLen(d.sup), 0);
const drawnLen = cyanD.reduce((a, d) => a + polyLen(d.drawn), 0);
const bends = cyanD.reduce((a, d) => a + bendCount(d.drawn), 0);
console.log(`\n==== OURS drawn (octi) SW window ====`);
console.log(`window corridors: ${drawn.length} (cyan-carrying ${cyanD.length})`);
console.log(`cyan: supportLen=${(supLen * M_PER_PX / 1000).toFixed(1)}km drawnLen=${(drawnLen * M_PER_PX / 1000).toFixed(1)}km detour=${(drawnLen / supLen).toFixed(2)}`);
console.log(`cyan bends(>=30deg): ${bends} = ${(bends / (drawnLen * M_PER_PX / 10000)).toFixed(1)} per 10km`);

// tight parallel runs in drawn output: disjoint lines, no shared node, median
// min-dist < 2 cells over an overlap of >= 3 cells
let tight = 0; let tightLen = 0;
const tightEx: string[] = [];
for (let i = 0; i < drawn.length; i++) {
  for (let j = i + 1; j < drawn.length; j++) {
    const a = drawn[i], b = drawn[j];
    let share = a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
    if (share) continue;
    let disjoint = true;
    for (const x of a.lines) if (b.lines.has(x)) { disjoint = false; break; }
    if (!disjoint) continue;
    const samples = resample(a.drawn, cellPx / 2);
    const close = samples.filter((p) => minDistToPoly(p, b.drawn) < 2 * cellPx);
    const overlap = close.length * (cellPx / 2);
    if (overlap >= 3 * cellPx) {
      tight++; tightLen += overlap;
      if (tightEx.length < 10) tightEx.push(`  ${a.id}||${b.id} overlap=${overlap.toFixed(0)}px (${(overlap * M_PER_PX / 1000).toFixed(1)}km)`);
    }
  }
}
console.log(`tight parallel runs (<2 cells apart, disjoint lines, no shared node): ${tight} pairs, total overlap ${(tightLen * M_PER_PX / 1000).toFixed(1)}km`);
for (const x of tightEx) console.log(x);

// ---------- LOOM drawn ----------
const svg = readFileSync('dev/out-loom-sea.svg', 'utf-8');
const mX0 = merc(-122.612413, 47.022228)[0];
const mY1 = merc(-122.612413, 47.988860)[1];
// geographic bbox of the window (from _parity-sw-anatomy.ts run)
const BB = { x0: -13646399, y0: 5946002, x1: -13605122, y1: 5994278 };
const toMerc = (x: number, y: number): Pt => [mX0 + x * 10, mY1 - y * 10];

const polyRe = /<polyline class="transit-edge[^"]*" points="([^"]+)" style="[^"]*stroke:(#[0-9a-fA-F]{6})/g;
let m: RegExpExecArray | null;
const loomStrokes: { pts: Pt[]; color: string }[] = [];
while ((m = polyRe.exec(svg))) {
  const pts = m[1].trim().split(/\s+/).map((s) => s.split(',').map(Number) as Pt).map(([x, y]) => toMerc(x, y));
  loomStrokes.push({ pts, color: m[2].toLowerCase() });
}
const inBB = (p: Pt) => p[0] >= BB.x0 - 500 && p[0] <= BB.x1 + 500 && p[1] >= BB.y0 - 500 && p[1] <= BB.y1 + 500;
const loomCyan = loomStrokes.filter((s) => s.color === '#00add0' && s.pts.every(inBB));
const loomCyanLen = loomCyan.reduce((a, s) => a + polyLen(s.pts), 0);
console.log(`\n==== LOOM drawn SW bbox ====`);
console.log(`cyan stroke segments: ${loomCyan.length}, raw stroke length: ${(loomCyanLen / 1000).toFixed(1)}km`);

// stitch into chains via shared endpoints, then count bends at joints+interior
const key = (p: Pt) => `${p[0].toFixed(0)}|${p[1].toFixed(0)}`;
const ends = new Map<string, number[]>();
loomCyan.forEach((s, i) => {
  for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
    const k = key(p);
    (ends.get(k) ?? ends.set(k, []).get(k)!).push(i);
  }
});
const used = new Set<number>();
let loomBends = 0;
const chains: Pt[][] = [];
for (let i = 0; i < loomCyan.length; i++) {
  if (used.has(i)) continue;
  // walk both directions
  let chain = loomCyan[i].pts.slice();
  used.add(i);
  let extended = true;
  while (extended) {
    extended = false;
    for (const [endIdx, atFront] of [[chain.length - 1, false], [0, true]] as [number, boolean][]) {
      const k = key(chain[endIdx]);
      const cands = (ends.get(k) ?? []).filter((x) => !used.has(x));
      // only continue over deg-2 joints (exactly one continuation)
      if (cands.length !== 1) continue;
      const nxt = loomCyan[cands[0]];
      used.add(cands[0]);
      let pts = nxt.pts.slice();
      if (key(pts[0]) !== k) pts.reverse();
      if (atFront) chain = pts.reverse().concat(chain.slice(1));
      else chain = chain.concat(pts.slice(1));
      extended = true;
    }
  }
  chains.push(chain);
}
for (const c of chains) loomBends += bendCount(c);
console.log(`stitched cyan chains: ${chains.length}; bends(>=30deg): ${loomBends} = ${(loomBends / (loomCyanLen / 10000)).toFixed(1)} per 10km (lane-multiplied)`);

// corridor-level: mean cyan lane multiplicity from topo edges in bbox
const topoOut = JSON.parse(readFileSync('dev/_probe-topo-out.json', 'utf-8'));
let wSum = 0, lSum = 0;
for (const f of topoOut.features) {
  if (f.geometry.type !== 'LineString') continue;
  const pts = (f.geometry.coordinates as number[][]).map(([lng, lat]) => merc(lng, lat));
  if (!pts.every(inBB)) continue;
  const lines = (f.properties.lines ?? []) as { id: string }[];
  const nCyan = lines.filter((l) => cyanIds.has(l.id)).length;
  if (nCyan === 0) continue;
  const len = polyLen(pts);
  wSum += len * nCyan; lSum += len;
}
const meanMult = wSum / Math.max(1, lSum);
console.log(`mean cyan lane multiplicity (topo, bbox): ${meanMult.toFixed(2)}`);
console.log(`corridor-level LOOM drawn cyan ~= ${(loomCyanLen / meanMult / 1000).toFixed(1)}km vs topo corridor cyan ${(lSum / 1000).toFixed(1)}km => detour ~${(loomCyanLen / meanMult / lSum).toFixed(2)}`);

// ---------- artifacts ----------
// 1. geo-matched LOOM crop
const sx0 = (BB.x0 - mX0) / 10, sx1 = (BB.x1 - mX0) / 10;
const sy0 = (mY1 - BB.y1) / 10, sy1 = (mY1 - BB.y0) / 10;
{
  let s = svg.replace(/viewBox="[^"]*"/, `viewBox="${sx0} ${sy0} ${sx1 - sx0} ${sy1 - sy0}"`)
    .replace(/width="[^"]*"/, `width="${sx1 - sx0}"`).replace(/height="[^"]*"/, `height="${sy1 - sy0}"`);
  writeFileSync('dev/_parity-loom-sw.png', new Resvg(s, { fitTo: { mode: 'width', value: 1000 }, background: 'white' }).render().asPng());
  console.log(`\nwrote dev/_parity-loom-sw.png (svg box ${sx0.toFixed(0)} ${sy0.toFixed(0)} ${(sx1 - sx0).toFixed(0)} ${(sy1 - sy0).toFixed(0)})`);
}
// 2. our raw support polylines in window
const drawSvg = (edges: { pts: Pt[]; cyan: boolean }[], file: string) => {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${WIN.x0} ${WIN.y0} ${WIN.x1 - WIN.x0} ${WIN.y1 - WIN.y0}">`);
  parts.push(`<rect x="${WIN.x0}" y="${WIN.y0}" width="${WIN.x1 - WIN.x0}" height="${WIN.y1 - WIN.y0}" fill="white"/>`);
  for (const e of edges) {
    const d = 'M' + e.pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    parts.push(`<path d="${d}" fill="none" stroke="${e.cyan ? '#00add0' : '#999'}" stroke-width="2.5"/>`);
  }
  parts.push('</svg>');
  writeFileSync(file, new Resvg(parts.join(''), { fitTo: { mode: 'width', value: 1000 } }).render().asPng());
  console.log('wrote', file);
};
const supEdges: { pts: Pt[]; cyan: boolean }[] = [];
for (const e of support.edges.values()) {
  const pf = support.nodes.get(e.from)!.pos as Pt, pt = support.nodes.get(e.to)!.pos as Pt;
  if (!inWinP(pf) && !inWinP(pt)) continue;
  supEdges.push({ pts: e.points as Pt[], cyan: [...e.lineIds].some((l) => cyanIds.has(l)) });
}
drawSvg(supEdges, 'dev/_parity-support-sw.png');
// 3. octi drawn corridors in window
const octiEdges: { pts: Pt[]; cyan: boolean }[] = [];
for (const e of hM.edges.values()) {
  const pf = img.placement.get(e.from), pt = img.placement.get(e.to);
  const path = img.paths.get(e.id);
  if (!pf || !pt || !path) continue;
  if (!inWinP(pf as Pt) && !inWinP(pt as Pt)) continue;
  octiEdges.push({ pts: path as Pt[], cyan: [...e.lineIds].some((l) => cyanIds.has(l)) });
}
drawSvg(octiEdges, 'dev/_parity-octi-sw.png');
