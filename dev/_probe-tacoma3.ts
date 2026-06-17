// Throwaway probe 3: southern-loop chain length (support vs routed), plus
// graph/support/drawn crop renders for the west-Tacoma cluster.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
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
const bullet = (lid: string) => cyanRoutes.get(lid) ?? '?';

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

const dHat = 16;
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const medLen = medianEdgeLength(h);
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medLen / divisor), geographicAffinity: 0.05 };
const img = octi(h, octiOpts);

const polyLen = (p: Pixel[]) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0]-p[i-1][0], p[i][1]-p[i-1][1]); return l; };

// ---- walk the deg-2 chain from h5756 southward (start edge he859) ----------
console.log('=== SOUTHERN LOOP CHAIN (h5756 -> ... -> next deg>=3 node) ===');
{
  const deg = (nid: string) => (h.adj.get(nid) ?? []).length;
  let prev = 'h5756';
  let cur = 'ha470'; // 121 St
  let curEdge = h.edges.get('he859')!;
  let supLen = polyLen(curEdge.points);
  let drawnLen = polyLen(img.paths.get(curEdge.id) ?? []);
  const chainNodes = [prev, cur];
  const chainEdges = [curEdge.id];
  while (deg(cur) === 2) {
    const nextEid = (h.adj.get(cur) ?? []).find((eid) => eid !== curEdge.id);
    if (!nextEid) break;
    curEdge = h.edges.get(nextEid)!;
    const nxt = curEdge.from === cur ? curEdge.to : curEdge.from;
    supLen += polyLen(curEdge.points);
    drawnLen += polyLen(img.paths.get(curEdge.id) ?? []);
    chainNodes.push(nxt);
    chainEdges.push(nextEid);
    prev = cur;
    cur = nxt;
  }
  console.log(`chain: ${chainNodes.length} nodes, ends at ${cur} deg=${deg(cur)}`);
  console.log(`nodes: ${chainNodes.join(' ')}`);
  const pA = h.nodes.get(chainNodes[0])!.pos;
  const pB = h.nodes.get(cur)!.pos;
  const dA = img.placement.get(chainNodes[0]);
  const dB = img.placement.get(cur);
  console.log(`skeleton ends: ${chainNodes[0]} support=(${pA[0].toFixed(0)},${pA[1].toFixed(0)}) drawn=(${dA?.[0].toFixed(0)},${dA?.[1].toFixed(0)})  ${cur} support=(${pB[0].toFixed(0)},${pB[1].toFixed(0)}) drawn=(${dB?.[0].toFixed(0)},${dB?.[1].toFixed(0)})`);
  console.log(`support arc len=${supLen.toFixed(0)}px  drawn arc len=${drawnLen.toFixed(0)}px (${(100*drawnLen/supLen).toFixed(0)}%)  endpoint span support=${Math.hypot(pA[0]-pB[0],pA[1]-pB[1]).toFixed(0)}px`);
  // max southern extent
  let maxSupY = 0, maxDrawnY = 0;
  for (const eid of chainEdges) {
    for (const p of h.edges.get(eid)!.points) maxSupY = Math.max(maxSupY, p[1]);
    for (const p of img.paths.get(eid) ?? []) maxDrawnY = Math.max(maxDrawnY, p[1]);
  }
  console.log(`southern extent: support maxY=${maxSupY.toFixed(0)}  drawn maxY=${maxDrawnY.toFixed(0)}`);
}

// ---- crops ------------------------------------------------------------------
// window (drawn space is compressed northwest, so use a window covering both)
const VX = 540, VY = 2080, VW = 320, VH = 290;
const sc = 4;
const header = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VX} ${VY} ${VW} ${VH}" width="${VW * sc}" height="${VH * sc}"><rect x="${VX}" y="${VY}" width="${VW}" height="${VH}" fill="white"/>`;

const NAMED = ['83 Av', 'Lake Av', 'Lake Steilacoom Dr', '107 Av', '121 St', '70 Av Court', 'Union Av', 'Flora St', 'Circle Dr', 'Burke Court', 'Steilacoom Blvd', 'Zircon Dr', 'Bridgeport Way', '51 Av', '99 St', 'Montrose Av', 'Pacific Hwy', 'Cedar St', '94 Av Court', 'Chicago Av'];
const inWin = (g: { center: Coordinate }) => g.center[0] >= -122.625 && g.center[0] <= -122.44 && g.center[1] >= 47.095 && g.center[1] <= 47.26;

// 1) graph level: straight cyan edges + named stations
{
  let s = header;
  for (const e of graph.edges) {
    const cy = e.lines.filter((l) => cyanRoutes.has(l.id));
    if (cy.length === 0) continue;
    const a = graph.nodes.get(e.from)!.pos;
    const b = graph.nodes.get(e.to)!.pos;
    s += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="#00add0" stroke-width="2"/>`;
  }
  for (const g of groups) {
    if (!inWin(g)) continue;
    const p = proj.toSVG(g.center);
    s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="white" stroke="#111" stroke-width="0.8"/>`;
    if (NAMED.includes(g.name)) s += `<text x="${(p[0] + 4).toFixed(1)}" y="${(p[1] - 3).toFixed(1)}" font-size="7" font-family="Arial">${g.name}</text>`;
  }
  s += '</svg>';
  writeFileSync('dev/_tacoma-graph.png', new Resvg(s).render().asPng());
}

// 2) support level: h cyan edge polylines + station nodes + junction marks
{
  let s = header;
  for (const e of h.edges.values()) {
    const cy = [...e.lineIds].filter((l) => cyanRoutes.has(l));
    if (cy.length === 0) continue;
    const d = e.points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    s += `<path d="${d}" fill="none" stroke="${cy.length > 1 ? '#d02090' : '#00add0'}" stroke-width="${1 + cy.length}"/>`;
  }
  for (const g of groups) {
    if (!inWin(g) || !NAMED.includes(g.name)) continue;
    const st = h.stations.get(g.id);
    if (!st) continue;
    const p = h.nodes.get(st.nodeId)!.pos;
    s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="white" stroke="#111" stroke-width="0.8"/>`;
    s += `<text x="${(p[0] + 4).toFixed(1)}" y="${(p[1] - 3).toFixed(1)}" font-size="7" font-family="Arial">${g.name}</text>`;
  }
  // junctions
  for (const [nid, eids] of h.adj) {
    if (eids.length < 3) continue;
    const cy = eids.some((eid) => [...(h.edges.get(eid)?.lineIds ?? [])].some((l) => cyanRoutes.has(l)));
    if (!cy) continue;
    const p = h.nodes.get(nid)!.pos;
    s += `<rect x="${(p[0] - 3).toFixed(1)}" y="${(p[1] - 3).toFixed(1)}" width="6" height="6" fill="none" stroke="red" stroke-width="1"/>`;
  }
  s += '</svg>';
  writeFileSync('dev/_tacoma-support.png', new Resvg(s).render().asPng());
}

// 3) drawn level: crop the production render
{
  if (existsSync('dev/_dump.svg')) {
    let svg = readFileSync('dev/_dump.svg', 'utf-8');
    svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${VX} ${VY} ${VW} ${VH}"`);
    svg = svg.replace(/width="\d+" height="\d+"/, `width="${VW * sc}" height="${VH * sc}"`);
    writeFileSync('dev/_tacoma-drawn.png', new Resvg(svg, { fitTo: { mode: 'width', value: VW * sc } }).render().asPng());
    console.log('drawn crop from existing dev/_dump.svg');
  } else {
    console.log('dev/_dump.svg missing');
  }
}
console.log('wrote dev/_tacoma-graph.png dev/_tacoma-support.png dev/_tacoma-drawn.png');
