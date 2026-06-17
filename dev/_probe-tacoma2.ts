// Throwaway probe 2: pre-merge station mapping, octi placement compression,
// merge-round attribution for the west-Tacoma cluster.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, runMergeRounds, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const groups = getOrBuildStationGroups(stations, stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);
const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

const CYAN = '#00add0';
const cyanRoutes = new Map<string, string>();
for (const r of routes) if ((r.color?.startsWith('#') ? r.color : '#' + r.color) === CYAN) cyanRoutes.set(r.id, r.bullet);
const bullet = (lid: string) => cyanRoutes.get(lid) ?? '?' + lid.slice(0, 4);

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
    const e = edgeById.get(eid);
    if (e) for (const l of e.lines) lines.add(l.id);
  }
  const w = Math.max(1, Math.min(4, lines.size));
  for (let i = 0; i < w; i++) warpSamples.push(p);
}
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

// SW cluster window
const LNG = [-122.625, -122.44];
const LAT = [47.095, 47.26];
const clusterGroups = groups.filter((g) => g.center[0] >= LNG[0] && g.center[0] <= LNG[1] && g.center[1] >= LAT[0] && g.center[1] <= LAT[1]);
let pxMin: Pixel = [Infinity, Infinity], pxMax: Pixel = [-Infinity, -Infinity];
for (const g of clusterGroups) {
  const p = proj.toSVG(g.center);
  pxMin = [Math.min(pxMin[0], p[0]), Math.min(pxMin[1], p[1])];
  pxMax = [Math.max(pxMax[0], p[0]), Math.max(pxMax[1], p[1])];
}
const M = 40;
const inWinPx = (p: Pixel) =>
  p[0] >= pxMin[0] - M && p[0] <= pxMax[0] + M && p[1] >= pxMin[1] - M && p[1] <= pxMax[1] + M;

const dHat = 16;
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};

// ---- merge-round attribution: junction signature per maxRounds -------------
console.log('=== ROUND-BY-ROUND (83 Av degree + Flora-area junction) ===');
const px83: Pixel = proj.toSVG(groups.find((g) => g.name === '83 Av' && g.center[1] < 47.2)!.center) as Pixel;
const pxFlora: Pixel = proj.toSVG(groups.find((g) => g.name === 'Flora St')!.center) as Pixel;
for (let mr = 1; mr <= 8; mr++) {
  const b = runMergeRounds(graph, { ...params, maxRounds: mr });
  const snap = b.snapshot();
  const deg = new Map<string, number>();
  for (const e of snap.edges) {
    const cy = [...e.lineIds].some((l) => cyanRoutes.has(l));
    if (!cy) continue;
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  // node nearest 83 Av and any deg>=3 node within 35px of Flora St
  let n83 = ''; let d83 = Infinity;
  for (const [id, p] of snap.nodes) {
    const d = Math.hypot(p[0] - px83[0], p[1] - px83[1]);
    if (d < d83) { d83 = d; n83 = id; }
  }
  const floraJns: string[] = [];
  for (const [id, dg] of deg) {
    if (dg < 3) continue;
    const p = snap.nodes.get(id)!;
    const d = Math.hypot(p[0] - pxFlora[0], p[1] - pxFlora[1]);
    if (d < 35) floraJns.push(`${id}@(${p[0].toFixed(0)},${p[1].toFixed(0)})deg=${dg}d=${d.toFixed(0)}`);
  }
  console.log(`maxRounds=${mr}: 83Av-node=${n83} d=${d83.toFixed(1)} deg=${deg.get(n83) ?? 0}; flora-area-jn: ${floraJns.join(' ') || 'none'}`);
}

// ---- full pipeline ----------------------------------------------------------
const h = buildSupportGraph(graph, groups, params);
const medLen = medianEdgeLength(h);
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medLen / divisor), geographicAffinity: 0.05 };
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
const mh = merged.h;

// ---- pre-merge support edges in window (cyan) --------------------------------
console.log('\n=== PRE-MERGE SUPPORT (frozen h): cyan edges in window ===');
const hDeg = new Map<string, number>();
for (const e of h.edges.values()) {
  const pa = h.nodes.get(e.from)!.pos;
  const pb = h.nodes.get(e.to)!.pos;
  if (!(inWinPx(pa) || inWinPx(pb))) continue;
  const cy = [...e.lineIds].filter((l) => cyanRoutes.has(l));
  if (cy.length === 0) continue;
  hDeg.set(e.from, (hDeg.get(e.from) ?? 0) + 1);
  hDeg.set(e.to, (hDeg.get(e.to) ?? 0) + 1);
  // only print edges south/west of the Tacoma hub fan (x<760 or y>2100)
  if (pa[0] < 770 || pa[1] > 2100 || pb[0] < 770 || pb[1] > 2100) {
    console.log(
      `  ${e.id.padEnd(8)} ${e.from.slice(0, 8)}(${pa[0].toFixed(0)},${pa[1].toFixed(0)}) -- ${e.to.slice(0, 8)}(${pb[0].toFixed(0)},${pb[1].toFixed(0)}) [${cy.map(bullet).sort().join('')}]`,
    );
  }
}

// ---- station mapping pre/post merge -----------------------------------------
console.log('\n=== STATION MAPPING (pre-merge h -> octi placement -> merged mh) ===');
const NAMED = ['83 Av', 'Lake Av', 'Lake Steilacoom Dr', '107 Av', '121 St', '70 Av Court', 'Union Av', 'Flora St', 'Circle Dr', 'Burke Court', 'Steilacoom Blvd', 'Zircon Dr', 'Bridgeport Way', '51 Av', '99 St', 'Montrose Av', 'Pacific Hwy', 'Cedar St', '94 Av Court', 'Chicago Av', 'Mullen St', '75 St'];
for (const g of clusterGroups) {
  if (!NAMED.includes(g.name)) continue;
  const truePx = proj.toSVG(g.center);
  const pre = h.stations.get(g.id);
  const post = mh.stations.get(g.id);
  if (!pre) { console.log(`  ${g.name}: no pre station`); continue; }
  const preNode = h.nodes.get(pre.nodeId)!;
  const placed = img.placement.get(pre.nodeId);
  const preDeg = (h.adj.get(pre.nodeId) ?? []).length;
  const preStops = [...h.stopAt].filter((k) => k.endsWith('|' + pre.nodeId)).map((k) => bullet(k.split('|')[0])).sort().join('');
  const postDeg = post ? (mh.adj.get(post.nodeId) ?? []).length : -1;
  const postStops = post ? [...mh.stopAt].filter((k) => k.endsWith('|' + post.nodeId)).map((k) => bullet(k.split('|')[0])).sort().join('') : '';
  const postPos = post ? mh.nodes.get(post.nodeId)!.pos : null;
  console.log(
    `  ${g.name.padEnd(20)} true=(${truePx[0].toFixed(0)},${truePx[1].toFixed(0)})  preNode=${pre.nodeId.padEnd(7)} pos=(${preNode.pos[0].toFixed(0)},${preNode.pos[1].toFixed(0)}) deg=${preDeg} stops=[${preStops}] placed=(${placed?.[0].toFixed(0)},${placed?.[1].toFixed(0)})` +
    `  ->  postNode=${post?.nodeId ?? 'NONE'} deg=${postDeg} stops=[${postStops}] pos=(${postPos?.[0].toFixed(0)},${postPos?.[1].toFixed(0)})`,
  );
}

// ---- compression: support vs drawn distances among key nodes -----------------
console.log('\n=== COMPRESSION (support pos vs octi placement) ===');
const keyNames = ['Burke Court', '107 Av', '83 Av', 'Lake Av', 'Lake Steilacoom Dr', '121 St', '70 Av Court', 'Pacific Hwy', 'Montrose Av', 'Steilacoom Blvd'];
const keyNodes: Array<{ name: string; nid: string; sup: Pixel; drawn: Pixel | undefined }> = [];
for (const g of clusterGroups) {
  if (!keyNames.includes(g.name)) continue;
  const pre = h.stations.get(g.id);
  if (!pre) continue;
  keyNodes.push({ name: g.name, nid: pre.nodeId, sup: h.nodes.get(pre.nodeId)!.pos, drawn: img.placement.get(pre.nodeId) });
}
// also the two support junctions
for (const [nid, label] of [['h5756', 'JN-83Av'], ['h3492', 'JN-Flora']] as const) {
  const n = h.nodes.get(nid);
  if (n) keyNodes.push({ name: label, nid, sup: n.pos, drawn: img.placement.get(nid) });
}
for (const k of keyNodes) {
  const disp = k.drawn ? Math.hypot(k.drawn[0] - k.sup[0], k.drawn[1] - k.sup[1]) : NaN;
  console.log(`  ${k.name.padEnd(20)} ${k.nid.padEnd(7)} support=(${k.sup[0].toFixed(0)},${k.sup[1].toFixed(0)}) drawn=(${k.drawn?.[0].toFixed(0)},${k.drawn?.[1].toFixed(0)}) displaced=${disp.toFixed(0)}px`);
}
const pair = (a: string, b: string) => {
  const ka = keyNodes.find((k) => k.name === a);
  const kb = keyNodes.find((k) => k.name === b);
  if (!ka || !kb || !ka.drawn || !kb.drawn) return;
  const ds = Math.hypot(ka.sup[0] - kb.sup[0], ka.sup[1] - kb.sup[1]);
  const dd = Math.hypot(ka.drawn[0] - kb.drawn[0], ka.drawn[1] - kb.drawn[1]);
  console.log(`  ${a} .. ${b}: support=${ds.toFixed(0)}px drawn=${dd.toFixed(0)}px (${(100 * dd / ds).toFixed(0)}%)`);
};
pair('Burke Court', 'JN-83Av');
pair('JN-Flora', 'JN-83Av');
pair('JN-83Av', '121 St');
pair('121 St', '70 Av Court');
pair('JN-83Av', '70 Av Court');
pair('Burke Court', '70 Av Court');
pair('Pacific Hwy', '70 Av Court');
