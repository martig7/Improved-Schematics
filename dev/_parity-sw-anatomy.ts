// Throwaway: structural comparison of the SW "Tacoma clump" between LOOM's
// topo output (dev/_probe-topo-out.json) and our support graph (built exactly
// like renderSmoothed). Counts nodes/edges/degree, near-duplicate parallel
// corridors (Hausdorff < 1 cell, disjoint line sets), termini/stump patterns,
// and effective merge-radius / cell-size in webmercator meters.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { medianEdgeLength } from '../src/render/layout/octi';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

// ---------- shared helpers ----------
type Pt = [number, number];
const R = 6378137;
const merc = (lng: number, lat: number): Pt => [
  (R * lng * Math.PI) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
const polyLen = (pts: Pt[]): number => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
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
      out.push([nx, ny]);
      x0 = nx; y0 = ny;
      d = Math.hypot(x1 - x0, y1 - y0);
      acc = 0;
    }
    acc += d;
  }
  out.push(pts[pts.length - 1]);
  return out;
};
const hausdorff = (A: Pt[], B: Pt[], step: number): number => {
  const dDir = (P: Pt[], Q: Pt[]): number => {
    let mx = 0;
    for (const p of resample(P, step)) {
      let mn = Infinity;
      for (let i = 1; i < Q.length; i++) mn = Math.min(mn, segDist(p, Q[i - 1], Q[i]));
      if (mn > mx) mx = mn;
    }
    return mx;
  };
  return Math.max(dDir(A, B), dDir(B, A));
};
const disjoint = (a: Set<string>, b: Set<string>): boolean => {
  for (const x of a) if (b.has(x)) return false;
  return true;
};

interface SideEdge { id: string; from: string; to: string; pts: Pt[]; lines: Set<string>; len: number }
interface SideStats { name: string; cell: number }

function analyze(
  name: string,
  nodesIn: Map<string, Pt>,
  edgesAll: SideEdge[],
  cell: number,
  hausStep: number,
  cyanLineIds: Set<string>,
) {
  const edges = edgesAll.filter((e) => nodesIn.has(e.from) && nodesIn.has(e.to));
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const usedNodes = [...nodesIn.keys()].filter((n) => (deg.get(n) ?? 0) > 0);
  const degVals = usedNodes.map((n) => deg.get(n)!);
  const avgDeg = degVals.reduce((a, b) => a + b, 0) / Math.max(1, degVals.length);
  const hist = new Map<number, number>();
  for (const d of degVals) hist.set(d, (hist.get(d) ?? 0) + 1);
  const lens = edges.map((e) => e.len).sort((a, b) => a - b);
  const med = lens[Math.floor(lens.length / 2)] ?? 0;
  const subCell = edges.filter((e) => e.len < cell).length;
  const subHalfCell = edges.filter((e) => e.len < cell / 2).length;

  console.log(`\n==== ${name} ====`);
  console.log(`nodes(in-window, deg>0): ${usedNodes.length}  edges(both-ends-in): ${edges.length}  avgDeg: ${avgDeg.toFixed(2)}`);
  console.log(`degree hist: ${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}:${c}`).join(' ')}`);
  console.log(`edge len: median=${med.toFixed(1)}  <1cell(${cell.toFixed(0)}): ${subCell}/${edges.length}  <0.5cell: ${subHalfCell}`);

  // multigraph: same node pair, >1 edge
  const pairKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
  const pairs = new Map<string, SideEdge[]>();
  for (const e of edges) {
    const k = pairKey(e.from, e.to);
    (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(e);
  }
  const multi = [...pairs.values()].filter((v) => v.length > 1);
  console.log(`same-node-pair parallel edge groups: ${multi.length}`);

  // near-duplicate parallel corridors: disjoint line sets, Hausdorff < 1 cell,
  // not sharing a node (sharing-node pairs are legitimate branches), len >= cell
  let nearDup = 0;
  const examples: string[] = [];
  let nearDupShared = 0; // sharing one endpoint but still parallel over their length
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      if (a.len < cell || b.len < cell) continue;
      if (!disjoint(a.lines, b.lines)) continue;
      const shareNode = a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
      // cheap bbox reject
      const bb = (e: SideEdge) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of e.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        return [x0, y0, x1, y1];
      };
      const A = bb(a), B = bb(b);
      if (A[0] > B[2] + cell || B[0] > A[2] + cell || A[1] > B[3] + cell || B[1] > A[3] + cell) continue;
      const h = hausdorff(a.pts, b.pts, hausStep);
      if (h < cell) {
        if (shareNode) nearDupShared++;
        else {
          nearDup++;
          if (examples.length < 8) {
            examples.push(`  ${a.id}<->${b.id} H=${h.toFixed(1)} lenA=${a.len.toFixed(0)} lenB=${b.len.toFixed(0)} linesA=[${[...a.lines].map(s => s.slice(0, 6)).join(',')}] linesB=[${[...b.lines].map(s => s.slice(0, 6)).join(',')}]`);
          }
        }
      }
    }
  }
  console.log(`near-duplicate parallel corridors (disjoint lines, H<1cell, no shared node): ${nearDup}`);
  console.log(`  (additionally sharing an endpoint but H<1cell over full length: ${nearDupShared})`);
  for (const ex of examples) console.log(ex);

  // termini / stump patterns
  const adj = new Map<string, SideEdge[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e);
  }
  let termini = 0, multiLineTermini = 0, yAtTerminus = 0, stumps = 0;
  for (const n of usedNodes) {
    const es = adj.get(n) ?? [];
    if (es.length !== 1) continue;
    termini++;
    const e = es[0];
    if (e.lines.size >= 2) {
      multiLineTermini++;
      // Y candidate: at other end, e's lines leave over >=2 different edges
      const other = e.from === n ? e.to : e.from;
      const oes = (adj.get(other) ?? []).filter((x) => x !== e);
      const exits = oes.filter((x) => !disjoint(x.lines, e.lines));
      if (exits.length >= 2) yAtTerminus++;
    }
    if (e.lines.size === 1 && e.len < 2 * cell) {
      // stump candidate: single-line short spur off a node that carries other lines
      const other = e.from === n ? e.to : e.from;
      const oes = (adj.get(other) ?? []).filter((x) => x !== e);
      const carriesOthers = oes.some((x) => [...x.lines].some((l) => !e.lines.has(l)));
      if (carriesOthers) stumps++;
    }
  }
  console.log(`termini(deg1): ${termini}  multi-line termini: ${multiLineTermini}  Y-at-terminus: ${yAtTerminus}  single-line short stumps: ${stumps}`);

  // cyan-only subset
  const cyanEdges = edges.filter((e) => [...e.lines].some((l) => cyanLineIds.has(l)));
  console.log(`cyan-carrying edges: ${cyanEdges.length}  total cyan polyline length: ${cyanEdges.reduce((a, e) => a + e.len, 0).toFixed(0)}`);
  return { edges, usedNodes };
}

// ---------- OUR SIDE ----------
const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const cyanRouteIds = new Set<string>(routes.filter((r: { color: string }) => r.color?.toLowerCase() === '#00add0').map((r: { id: string }) => r.id));

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

const dHat = Math.max(8, 4 * 4);
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const support = buildSupportGraph(graph, groups, params);
const medLen = medianEdgeLength(support);
const divisor = support.edges.size > 800 ? 1.2 : 2.5;
const cellPx = Math.max(12, medLen / divisor);
console.log(`support: ${support.nodes.size} nodes ${support.edges.size} edges  medianEdgeLen=${medLen.toFixed(1)}px  divisor=${divisor}  cellSize=${cellPx.toFixed(1)}px  dHat=${dHat}px`);

// SW window in SVG px (matches dev/_parity-dump-sw.png crop)
const WIN = { x0: 450, y0: 1850, x1: 1700, y1: 2750 };
const inWin = (p: Pixel) => p[0] >= WIN.x0 && p[0] <= WIN.x1 && p[1] >= WIN.y0 && p[1] <= WIN.y1;

const ourNodes = new Map<string, Pt>();
for (const n of support.nodes.values()) if (inWin(n.pos)) ourNodes.set(n.id, [n.pos[0], n.pos[1]]);
const ourEdges: SideEdge[] = [...support.edges.values()].map((e) => ({
  id: e.id, from: e.from, to: e.to, pts: e.points.map((p) => [p[0], p[1]] as Pt),
  lines: e.lineIds, len: polyLen(e.points.map((p) => [p[0], p[1]] as Pt)),
}));

// effective scale meters-per-px inside the window (warped): use graph nodes
let ratioSum = 0, ratioN = 0;
const gn = [...graph.nodes.values()].filter((n) => n.pos && inWin(n.pos as Pixel));
for (let i = 0; i < gn.length; i++) {
  for (let j = i + 1; j < Math.min(gn.length, i + 6); j++) {
    const a = gn[i], b = gn[j];
    const dpx = Math.hypot(a.pos![0] - b.pos![0], a.pos![1] - b.pos![1]);
    if (dpx < 5 || dpx > 300) continue;
    const am = merc(a.lngLat[0], a.lngLat[1]);
    const bm = merc(b.lngLat[0], b.lngLat[1]);
    const dm = Math.hypot(am[0] - bm[0], am[1] - bm[1]);
    ratioSum += dm / dpx; ratioN++;
  }
}
const mPerPx = ratioSum / Math.max(1, ratioN);
console.log(`window meters-per-px (warped, webmerc): ${mPerPx.toFixed(1)}  => dHat=${(dHat * mPerPx).toFixed(0)}m  cellSize=${(cellPx * mPerPx).toFixed(0)}m  (LOOM: aggr=50m, cell=2300m)`);

const our = analyze('OURS support graph SW window', ourNodes, ourEdges, cellPx, 4, cyanRouteIds);

// station labels in window for cross-location
const labels = new Set<string>();
for (const s of support.stations.values()) {
  const n = support.nodes.get(s.nodeId);
  if (n && inWin(n.pos)) labels.add(s.label);
}
console.log(`\nstations in window: ${labels.size}`);

// ---------- LOOM SIDE ----------
const topoOut = JSON.parse(readFileSync('dev/_probe-topo-out.json', 'utf-8'));
type Feat = { geometry: { type: string; coordinates: number[] | number[][] }; properties: Record<string, unknown> };
const feats: Feat[] = topoOut.features;
const lPoints = feats.filter((f) => f.geometry.type === 'Point');
const lEdgesF = feats.filter((f) => f.geometry.type === 'LineString');

// cross-locate: exact geographic bbox of our window via graph-node lngLat
// (graph nodes carry both warped px pos and lngLat; same network both sides)
let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, matched = 0;
for (const n of graph.nodes.values()) {
  if (!n.pos || !inWin(n.pos as Pixel)) continue;
  const m = merc(n.lngLat[0], n.lngLat[1]);
  matched++;
  bx0 = Math.min(bx0, m[0]); by0 = Math.min(by0, m[1]);
  bx1 = Math.max(bx1, m[0]); by1 = Math.max(by1, m[1]);
}
console.log(`our window graph nodes: ${matched}; bbox(webmerc) [${bx0.toFixed(0)},${by0.toFixed(0)}]-[${bx1.toFixed(0)},${by1.toFixed(0)}] (${((bx1 - bx0) / 1000).toFixed(1)}km x ${((by1 - by0) / 1000).toFixed(1)}km)`);
const PAD = 500; // m
const inB = (m: Pt) => m[0] >= bx0 - PAD && m[0] <= bx1 + PAD && m[1] >= by0 - PAD && m[1] <= by1 + PAD;

const loomNodes = new Map<string, Pt>();
for (const p of lPoints) {
  const [lng, lat] = p.geometry.coordinates as number[];
  const m = merc(lng, lat);
  if (inB(m)) loomNodes.set(p.properties.id as string, m);
}
const loomEdges: SideEdge[] = lEdgesF.map((f) => {
  const pts = (f.geometry.coordinates as number[][]).map(([lng, lat]) => merc(lng, lat));
  const lines = new Set<string>(((f.properties.lines as { id: string }[]) ?? []).map((l) => l.id));
  return { id: f.properties.id as string, from: f.properties.from as string, to: f.properties.to as string, pts, lines, len: polyLen(pts) };
});
const LOOM_CELL = 2300;
analyze('LOOM topo output SW bbox', loomNodes, loomEdges, LOOM_CELL, 100, cyanRouteIds);

// LOOM station count inside bbox
let loomStationsIn = 0;
for (const p of lPoints) {
  const [lng, lat] = p.geometry.coordinates as number[];
  if (inB(merc(lng, lat)) && p.properties.station_label) loomStationsIn++;
}
console.log(`\nLOOM stations in bbox: ${loomStationsIn}`);
