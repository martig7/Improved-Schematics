// Throwaway: (1) cyan lane multiplicity of our support corridors vs LOOM topo,
// (2) geo-matched transect stroke counts across the SW trunk in both FINAL
// renders, (3) LOOM corridor tight-parallel pairs for symmetry.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
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
const segInt = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
  const det = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(det) < 1e-12) return false;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / det;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / det;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
};

// ---------- our pipeline up to support ----------
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
const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, params);

const WIN = { x0: 450, y0: 1850, x1: 1700, y1: 2750 };
const inWinP = (p: Pt) => p[0] >= WIN.x0 && p[0] <= WIN.x1 && p[1] >= WIN.y0 && p[1] <= WIN.y1;

// (1) cyan multiplicity ours
let wSum = 0, lSum = 0, maxMult = 0, len2 = 0, len3 = 0, totalLines = 0, nE = 0;
for (const e of support.edges.values()) {
  const pf = support.nodes.get(e.from)!.pos as Pt, pt = support.nodes.get(e.to)!.pos as Pt;
  if (!inWinP(pf) || !inWinP(pt)) continue;
  const nCyan = [...e.lineIds].filter((l) => cyanIds.has(l)).length;
  nE++; totalLines += e.lineIds.size;
  if (nCyan === 0) continue;
  const len = polyLen(e.points as Pt[]);
  wSum += len * nCyan; lSum += len;
  if (nCyan >= 2) len2 += len;
  if (nCyan >= 3) len3 += len;
  maxMult = Math.max(maxMult, nCyan);
}
console.log(`OURS window: mean lines/edge=${(totalLines / nE).toFixed(2)}; cyan multiplicity (len-weighted)=${(wSum / lSum).toFixed(2)} max=${maxMult}; cyan length with >=2 cyan lines: ${(100 * len2 / lSum).toFixed(0)}% >=3: ${(100 * len3 / lSum).toFixed(0)}%`);

// LOOM topo multiplicity in bbox
const BB = { x0: -13646399, y0: 5946002, x1: -13605122, y1: 5994278 };
const inBB = (p: Pt) => p[0] >= BB.x0 - 500 && p[0] <= BB.x1 + 500 && p[1] >= BB.y0 - 500 && p[1] <= BB.y1 + 500;
const topoOut = JSON.parse(readFileSync('dev/_probe-topo-out.json', 'utf-8'));
let lw = 0, ll = 0, lmax = 0, ll2 = 0, ltot = 0, lnE = 0;
for (const f of topoOut.features) {
  if (f.geometry.type !== 'LineString') continue;
  const pts = (f.geometry.coordinates as number[][]).map(([lng, lat]) => merc(lng, lat));
  if (!pts.every(inBB)) continue;
  const lines = (f.properties.lines ?? []) as { id: string }[];
  lnE++; ltot += lines.length;
  const nCyan = lines.filter((l) => cyanIds.has(l.id)).length;
  if (nCyan === 0) continue;
  const len = polyLen(pts);
  lw += len * nCyan; ll += len;
  if (nCyan >= 2) ll2 += len;
  lmax = Math.max(lmax, nCyan);
}
console.log(`LOOM bbox: mean lines/edge=${(ltot / lnE).toFixed(2)}; cyan multiplicity=${(lw / ll).toFixed(2)} max=${lmax}; cyan length with >=2 cyan lines: ${(100 * ll2 / ll).toFixed(0)}%`);

// (2) transects: find longest cyan support edge in window = the trunk
let trunk: { pts: Pt[]; len: number } | null = null;
for (const e of support.edges.values()) {
  const pf = support.nodes.get(e.from)!.pos as Pt, pt = support.nodes.get(e.to)!.pos as Pt;
  if (!inWinP(pf) || !inWinP(pt)) continue;
  if (![...e.lineIds].some((l) => cyanIds.has(l))) continue;
  const len = polyLen(e.points as Pt[]);
  if (!trunk || len > trunk.len) trunk = { pts: e.points as Pt[], len };
}
if (!trunk) throw new Error('no trunk');
// transect at fractions along the trunk, normal direction, +-90px
const fracs = [0.3, 0.5, 0.7];
const ourSvg = readFileSync('dev/_dump.svg', 'utf-8');
const tagRe = /<path\b[^>]*>/g;
const ourCyanPaths: Pt[][] = [];
let mm: RegExpExecArray | null;
while ((mm = tagRe.exec(ourSvg))) {
  const tag = mm[0];
  if (!/stroke="#00add0"/.test(tag)) continue;
  const dm = tag.match(/\bd="([^"]+)"/);
  if (!dm) continue;
  const pts = dm[1].replace(/[MLZz]/g, ' ').trim().split(/\s+/).map((s) => s.split(',').map(Number) as Pt).filter((p) => p.length === 2 && isFinite(p[0]) && isFinite(p[1]));
  if (pts.length >= 2) ourCyanPaths.push(pts);
}
console.log(`our svg cyan path elements: ${ourCyanPaths.length}`);

const loomSvg = readFileSync('dev/out-loom-sea.svg', 'utf-8');
const mX0 = merc(-122.612413, 47.022228)[0];
const mY1 = merc(-122.612413, 47.988860)[1];
const polyRe = /<polyline class="transit-edge[^"]*" points="([^"]+)" style="[^"]*stroke:(#[0-9a-fA-F]{6})/g;
const loomCyanM: Pt[][] = [];
while ((mm = polyRe.exec(loomSvg))) {
  if (mm[2].toLowerCase() !== '#00add0') continue;
  const pts = mm[1].trim().split(/\s+/).map((s) => s.split(',').map(Number) as Pt).map(([x, y]) => [mX0 + x * 10, mY1 - y * 10] as Pt);
  loomCyanM.push(pts);
}

// helper: nearest graph node to a px point (for px->merc mapping)
const nearestNode = (p: Pt) => {
  let best: { d: number; n: { lngLat: Coordinate; pos?: Pixel } } | null = null;
  for (const n of graph.nodes.values()) {
    if (!n.pos) continue;
    const d = Math.hypot(n.pos[0] - p[0], n.pos[1] - p[1]);
    if (!best || d < best.d) best = { d, n };
  }
  return best!;
};

for (const f of fracs) {
  // point at fraction f along trunk + tangent
  const target = trunk.len * f;
  let acc = 0, mid: Pt = trunk.pts[0], tan: Pt = [1, 0];
  for (let i = 1; i < trunk.pts.length; i++) {
    const d = Math.hypot(trunk.pts[i][0] - trunk.pts[i - 1][0], trunk.pts[i][1] - trunk.pts[i - 1][1]);
    if (acc + d >= target) {
      const t = (target - acc) / d;
      mid = [trunk.pts[i - 1][0] + t * (trunk.pts[i][0] - trunk.pts[i - 1][0]), trunk.pts[i - 1][1] + t * (trunk.pts[i][1] - trunk.pts[i - 1][1])];
      break;
    }
    acc += d;
  }
  // tangent: use coarse direction over +-60px along trunk to skip sawtooth noise
  const at = (tt: number): Pt => {
    let a2 = 0;
    for (let i = 1; i < trunk.pts.length; i++) {
      const d = Math.hypot(trunk.pts[i][0] - trunk.pts[i - 1][0], trunk.pts[i][1] - trunk.pts[i - 1][1]);
      if (a2 + d >= tt) {
        const t = (tt - a2) / d;
        return [trunk.pts[i - 1][0] + t * (trunk.pts[i][0] - trunk.pts[i - 1][0]), trunk.pts[i - 1][1] + t * (trunk.pts[i][1] - trunk.pts[i - 1][1])];
      }
      a2 += d;
    }
    return trunk.pts[trunk.pts.length - 1];
  };
  const p1 = at(Math.max(0, target - 60)), p2 = at(Math.min(trunk.len, target + 60));
  const tl = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  tan = [(p2[0] - p1[0]) / tl, (p2[1] - p1[1]) / tl];
  const nrm: Pt = [-tan[1], tan[0]];
  const T = 150;
  const a: Pt = [mid[0] - nrm[0] * T, mid[1] - nrm[1] * T];
  const b: Pt = [mid[0] + nrm[0] * T, mid[1] + nrm[1] * T];
  // collect crossing parameter t along transect for stroke + corridor counts
  const crossTs = (paths: Pt[][], A: Pt, B: Pt): number[] => {
    const ts: number[] = [];
    for (const p of paths) {
      let any = false;
      for (let i = 1; i < p.length; i++) {
        const c = p[i - 1], d = p[i];
        const det = (B[0] - A[0]) * (d[1] - c[1]) - (B[1] - A[1]) * (d[0] - c[0]);
        if (Math.abs(det) < 1e-12) continue;
        const t = ((c[0] - A[0]) * (d[1] - c[1]) - (c[1] - A[1]) * (d[0] - c[0])) / det;
        const u = ((c[0] - A[0]) * (B[1] - A[1]) - (c[1] - A[1]) * (B[0] - A[0])) / det;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { ts.push(t); any = true; break; }
      }
      void any;
    }
    return ts.sort((x, y) => x - y);
  };
  const cluster = (ts: number[], gap: number): number => {
    if (ts.length === 0) return 0;
    let n = 1;
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > gap) n++;
    return n;
  };
  const ourTs = crossTs(ourCyanPaths, a, b);
  const ourCross = ourTs.length;
  const ourCorr = cluster(ourTs, 8 / (2 * T)); // crossings >8px apart = corridors
  // LOOM: map mid via nearest graph node + offset is rough; use two nearest
  // nodes near p1,p2 to build merc transect
  const n1 = nearestNode(p1), n2 = nearestNode(p2), nm = nearestNode(mid);
  const m1 = merc(n1.n.lngLat[0], n1.n.lngLat[1]);
  const m2 = merc(n2.n.lngLat[0], n2.n.lngLat[1]);
  const mc = merc(nm.n.lngLat[0], nm.n.lngLat[1]);
  const mtl = Math.hypot(m2[0] - m1[0], m2[1] - m1[1]);
  const mtan: Pt = [(m2[0] - m1[0]) / mtl, (m2[1] - m1[1]) / mtl];
  const mnrm: Pt = [-mtan[1], mtan[0]];
  const MT = 150 * 63.3;
  const ma: Pt = [mc[0] - mnrm[0] * MT, mc[1] - mnrm[1] * MT];
  const mb: Pt = [mc[0] + mnrm[0] * MT, mc[1] + mnrm[1] * MT];
  const loomTs = crossTs(loomCyanM, ma, mb);
  const loomCross = loomTs.length;
  const loomCorr = cluster(loomTs, 300 / (2 * MT)); // crossings >300m apart = corridors
  console.log(`transect f=${f}: mid=(${mid[0].toFixed(0)},${mid[1].toFixed(0)}) OURS strokes=${ourCross} corridors=${ourCorr}  (node-snap ${nm.d.toFixed(0)}px)  LOOM strokes=${loomCross} corridors=${loomCorr}`);
  console.log(`  our crossing offsets px: ${ourTs.map((t) => ((t * 2 - 1) * T).toFixed(1)).join(', ')}`);
  console.log(`  loom crossing offsets m: ${loomTs.map((t) => ((t * 2 - 1) * MT).toFixed(0)).join(', ')}`);
}

// trunk sawtooth quantification: trunk polyline length vs chord
const chord = Math.hypot(
  trunk.pts[0][0] - trunk.pts[trunk.pts.length - 1][0],
  trunk.pts[0][1] - trunk.pts[trunk.pts.length - 1][1],
);
console.log(`\ntrunk: polylineLen=${trunk.len.toFixed(0)}px chord=${chord.toFixed(0)}px sawtooth factor=${(trunk.len / chord).toFixed(2)} points=${trunk.pts.length}`);
// count direction reversals (zigzag teeth)
let teeth = 0;
for (let i = 2; i < trunk.pts.length; i++) {
  const v1: Pt = [trunk.pts[i - 1][0] - trunk.pts[i - 2][0], trunk.pts[i - 1][1] - trunk.pts[i - 2][1]];
  const v2: Pt = [trunk.pts[i][0] - trunk.pts[i - 1][0], trunk.pts[i][1] - trunk.pts[i - 1][1]];
  const cross = v1[0] * v2[1] - v1[1] * v2[0];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  if (Math.atan2(Math.abs(cross), dot) > Math.PI / 3) teeth++;
}
console.log(`trunk bend vertices >60deg: ${teeth}`);
