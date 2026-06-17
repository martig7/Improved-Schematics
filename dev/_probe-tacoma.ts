// Throwaway probe: west-Tacoma branch cluster (cyan U/V/W/X/Y/Z routes).
// Attribution only — graph-level ground truth, support-level topology per
// topo pass, drawn-level join positions, and station-marker capsule logic.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import {
  buildSupportGraph,
  runMergeRounds,
  type TopoParams,
  type HBuilder,
} from '../src/render/layout/topo';
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

// ---- cluster window in lng/lat --------------------------------------------
const LNG = [-122.625, -122.44];
const LAT = [47.095, 47.26];
const inWindowLL = (c: Coordinate) => c[0] >= LNG[0] && c[0] <= LNG[1] && c[1] >= LAT[0] && c[1] <= LAT[1];

const groupById = new Map(groups.map((g) => [g.id, g]));
const clusterGroups = groups.filter((g) => inWindowLL(g.center));
const nameOf = (gid: string) => {
  const g = groupById.get(gid);
  return g ? `${g.name}[${gid.slice(0, 6)}]` : gid.slice(0, 8);
};

const CYAN = '#00add0';
const cyanRoutes = new Map<string, string>(); // id -> bullet
for (const r of routes) if ((r.color?.startsWith('#') ? r.color : '#' + r.color) === CYAN) cyanRoutes.set(r.id, r.bullet);
const bullet = (lid: string) => cyanRoutes.get(lid) ?? '?' + lid.slice(0, 4);

console.log('=== A. GROUND TRUTH (transit graph, cluster window) ===');
console.log('cyan routes:', [...cyanRoutes.entries()].map(([id, b]) => `${b}=${id.slice(0, 8)}`).join(' '));
const clusterIds = new Set(clusterGroups.map((g) => g.id));
// edges with any cyan line, both endpoints in window
const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
const cyanEdges = graph.edges.filter(
  (e) => e.lines.some((l) => cyanRoutes.has(l.id)) && (clusterIds.has(e.from) || clusterIds.has(e.to)),
);
const degIn = new Map<string, number>();
for (const e of cyanEdges) {
  degIn.set(e.from, (degIn.get(e.from) ?? 0) + 1);
  degIn.set(e.to, (degIn.get(e.to) ?? 0) + 1);
}
for (const e of cyanEdges) {
  const bl = e.lines.filter((l) => cyanRoutes.has(l.id)).map((l) => bullet(l.id)).sort().join('');
  const other = e.lines.filter((l) => !cyanRoutes.has(l.id)).map((l) => l.label).join(',');
  console.log(
    `  ${nameOf(e.from)} -- ${nameOf(e.to)}  cyan:[${bl}]${other ? ' other:[' + other + ']' : ''}`,
  );
}
console.log('-- degrees (cyan subgraph, window):');
for (const [gid, d] of [...degIn.entries()].sort((a, b) => b[1] - a[1])) {
  if (d >= 3) console.log(`  JUNCTION deg=${d}  ${nameOf(gid)}  center=${groupById.get(gid)?.center}`);
}
for (const [gid, d] of degIn) if (d < 3) {
  const g = groupById.get(gid);
  if (g && ['83 Av', 'Lake Av', 'Lake Steilacoom Dr', '107 Av', '121 St', '70 Av Court', 'Union Av', 'Flora St', 'Circle Dr', 'Burke Court', 'Steilacoom Blvd'].includes(g.name))
    console.log(`  deg=${d}  ${nameOf(gid)}`);
}

// ---- replicate renderSmoothed pixel pipeline -------------------------------
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

// pixel window = bbox of cluster groups + margin
let pxMin: Pixel = [Infinity, Infinity], pxMax: Pixel = [-Infinity, -Infinity];
for (const g of clusterGroups) {
  const p = proj.toSVG(g.center);
  pxMin = [Math.min(pxMin[0], p[0]), Math.min(pxMin[1], p[1])];
  pxMax = [Math.max(pxMax[0], p[0]), Math.max(pxMax[1], p[1])];
}
const M = 40;
const inWinPx = (p: Pixel) =>
  p[0] >= pxMin[0] - M && p[0] <= pxMax[0] + M && p[1] >= pxMin[1] - M && p[1] <= pxMax[1] + M;
console.log(`\npixel window: x ${pxMin[0].toFixed(0)}..${pxMax[0].toFixed(0)}  y ${pxMin[1].toFixed(0)}..${pxMax[1].toFixed(0)}`);

// named group pixel positions for reference
const NAMED = ['83 Av', 'Lake Av', 'Lake Steilacoom Dr', '107 Av', '121 St', '70 Av Court', 'Union Av', 'Flora St', 'Circle Dr', 'Burke Court', 'Steilacoom Blvd', 'Zircon Dr', 'Bridgeport Way', '51 Av', '99 St', 'Montrose Av', 'Pacific Hwy'];
const namedPx: Array<{ name: string; gid: string; px: Pixel }> = [];
for (const g of clusterGroups) {
  if (NAMED.includes(g.name)) namedPx.push({ name: g.name, gid: g.id, px: proj.toSVG(g.center) as Pixel });
}
const nearestNamed = (p: Pixel): string => {
  let best = ''; let bd = Infinity;
  for (const n of namedPx) {
    const d = Math.hypot(n.px[0] - p[0], n.px[1] - p[1]);
    if (d < bd) { bd = d; best = n.name; }
  }
  return `${best}~${bd.toFixed(0)}px`;
};
console.log('named group pixels:');
for (const n of namedPx) console.log(`  ${n.name.padEnd(20)} (${n.px[0].toFixed(0)},${n.px[1].toFixed(0)})`);

// ---- B. support-level: stage-by-stage --------------------------------------
const dHat = 16;
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};

function reportBuilder(label: string, b: HBuilder) {
  const snap = b.snapshot();
  const deg = new Map<string, number>();   // cyan-edge degree
  const degAll = new Map<string, number>();
  const winEdges: string[] = [];
  for (const e of snap.edges) {
    const pa = snap.nodes.get(e.a)!;
    const pb = snap.nodes.get(e.b)!;
    const cy = [...e.lineIds].filter((l) => cyanRoutes.has(l));
    if (!(inWinPx(pa) || inWinPx(pb))) continue;
    degAll.set(e.a, (degAll.get(e.a) ?? 0) + 1);
    degAll.set(e.b, (degAll.get(e.b) ?? 0) + 1);
    if (cy.length === 0) continue;
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    winEdges.push(
      `    ${e.a.slice(0, 8)}(${pa[0].toFixed(0)},${pa[1].toFixed(0)}) -- ${e.b.slice(0, 8)}(${pb[0].toFixed(0)},${pb[1].toFixed(0)})  [${cy.map(bullet).sort().join('')}] len=${e.points.length}`,
    );
  }
  const junctions = [...deg.entries()].filter(([, d]) => d >= 3);
  console.log(`\n-- ${label}: window cyan edges=${winEdges.length} cyan-junctions=${junctions.length}`);
  for (const [nid, d] of junctions.sort((a, b) => b[1] - a[1])) {
    const p = snap.nodes.get(nid)!;
    console.log(`   JN ${nid.slice(0, 8)} deg=${d} (${p[0].toFixed(0)},${p[1].toFixed(0)}) near ${nearestNamed(p)}`);
  }
  if (process.env.PROBE_EDGES) for (const l of winEdges) console.log(l);
}

console.log('\n=== B. SUPPORT GRAPH — pass-by-pass ===');
{
  const p1 = { ...params, maxRounds: 1 };
  const b1 = runMergeRounds(graph, p1);
  reportBuilder('runMergeRounds maxRounds=1 (single collapse pass)', b1);
}
const builder = runMergeRounds(graph, params);
reportBuilder('runMergeRounds (converged)', builder);
builder.sanitizeEdgeGeometry(params.dHat);
reportBuilder('after sanitizeEdgeGeometry #1', builder);
builder.contractShortEdges(params.dHat);
reportBuilder('after contractShortEdges(dHat)', builder);
builder.contractDegree2WithMatchingLines();
reportBuilder('after contractDegree2WithMatchingLines', builder);
builder.sanitizeEdgeGeometry(params.dHat);
reportBuilder('after sanitizeEdgeGeometry #2', builder);
builder.intersectionSmoothing(params.dHat);
reportBuilder('after intersectionSmoothing', builder);

// ---- full buildSupportGraph (fresh, like production) ------------------------
const h = buildSupportGraph(graph, groups, params);
console.log(`\n=== B2. FROZEN SUPPORT GRAPH (buildSupportGraph) ===`);
{
  const deg = new Map<string, number>();
  let count = 0;
  for (const e of h.edges.values()) {
    const pa = h.nodes.get(e.from)!.pos;
    const pb = h.nodes.get(e.to)!.pos;
    if (!(inWinPx(pa) || inWinPx(pb))) continue;
    const cy = [...e.lineIds].filter((l) => cyanRoutes.has(l));
    if (cy.length === 0) continue;
    count++;
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    if (process.env.PROBE_EDGES)
      console.log(`  ${e.from.slice(0, 10)}(${pa[0].toFixed(0)},${pa[1].toFixed(0)}) -- ${e.to.slice(0, 10)}(${pb[0].toFixed(0)},${pb[1].toFixed(0)}) [${cy.map(bullet).sort().join('')}]`);
  }
  console.log(`window cyan edges=${count}`);
  for (const [nid, d] of [...deg.entries()].filter(([, d]) => d >= 3).sort((a, b) => b[1] - a[1])) {
    const p = h.nodes.get(nid)!.pos;
    console.log(`  JN ${nid.slice(0, 10)} deg=${d} (${p[0].toFixed(0)},${p[1].toFixed(0)}) near ${nearestNamed(p)}`);
  }
}

// ---- C. drawn level ---------------------------------------------------------
console.log('\n=== C. DRAWN (octi + mergeCoincidentPaths) ===');
const medLen = medianEdgeLength(h);
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = { ...DEFAULT_OCTI_OPTIONS, cellSize: Math.max(12, medLen / divisor), geographicAffinity: 0.05 };
console.log(`support edges=${h.edges.size} medLen=${medLen.toFixed(1)} divisor=${divisor} cellSize=${octiOpts.cellSize.toFixed(1)}`);
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
const mh = merged.h;
const mimg = merged.img;

{
  const deg = new Map<string, number>();
  const lines: string[] = [];
  for (const e of mh.edges.values()) {
    const pa = mh.nodes.get(e.from)!.pos;
    const pb = mh.nodes.get(e.to)!.pos;
    if (!(inWinPx(pa) || inWinPx(pb))) continue;
    const cy = [...e.lineIds].filter((l) => cyanRoutes.has(l));
    if (cy.length === 0) continue;
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    const da = mimg.placement.get(e.from);
    const db = mimg.placement.get(e.to);
    lines.push(
      `  ${e.from.slice(0, 10)} drawn(${da?.[0].toFixed(0)},${da?.[1].toFixed(0)}) -- ${e.to.slice(0, 10)} drawn(${db?.[0].toFixed(0)},${db?.[1].toFixed(0)}) [${cy.map(bullet).sort().join('')}]`,
    );
  }
  if (process.env.PROBE_EDGES) for (const l of lines) console.log(l);
  const jns: Array<{ id: string; d: number; drawn: Pixel | undefined; true_: Pixel }> = [];
  for (const [nid, d] of deg) {
    if (d < 3) continue;
    jns.push({ id: nid, d, drawn: mimg.placement.get(nid), true_: mh.nodes.get(nid)!.pos });
  }
  console.log(`merged-graph cyan junctions in window: ${jns.length}`);
  for (const j of jns.sort((a, b) => (a.true_[1] - b.true_[1]))) {
    console.log(
      `  JN ${j.id.slice(0, 10)} deg=${j.d} true=(${j.true_[0].toFixed(0)},${j.true_[1].toFixed(0)}) drawn=(${j.drawn?.[0].toFixed(0)},${j.drawn?.[1].toFixed(0)}) near ${nearestNamed(j.true_)}`,
    );
  }
  // pairwise drawn distances between junctions
  for (let i = 0; i < jns.length; i++) {
    for (let k = i + 1; k < jns.length; k++) {
      const a = jns[i].drawn, b = jns[k].drawn;
      const at = jns[i].true_, bt = jns[k].true_;
      if (!a || !b) continue;
      console.log(
        `  dist ${jns[i].id.slice(0, 8)}..${jns[k].id.slice(0, 8)}: drawn=${Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(0)}px  support=${Math.hypot(at[0] - bt[0], at[1] - bt[1]).toFixed(0)}px`,
      );
    }
  }
}

// ---- D. station markers -----------------------------------------------------
console.log('\n=== D. STATION MARKERS (capsule rule: >=2 stop marks per node) ===');
// replicate renderRibbons mark counting on the merged graph
const usesEdge = new Map<string, Set<string>>();
for (const [lineId, trav] of mh.lineTraversals) {
  const s = new Set<string>();
  for (const st of trav) s.add(st.edgeId);
  if (s.size > 0) usesEdge.set(lineId, s);
}
const drawsOn = (lineId: string, edgeId: string) => {
  const s = usesEdge.get(lineId);
  return s ? s.has(edgeId) : true;
};
// marks per node: distinct lineIds with a stop flag (stopAt) at the node AND a drawn edge at the node
const marksPerNode = new Map<string, Set<string>>();
for (const e of mh.edges.values()) {
  for (const lid of e.lineIds) {
    const atFrom = mh.stopAt.has(lid + '|' + e.from);
    const atTo = mh.stopAt.has(lid + '|' + e.to);
    // drawnEndAt: line must draw on SOME edge incident to the node
    const check = (nid: string, flagged: boolean) => {
      if (!flagged) return;
      let drawn = false;
      for (const eid2 of mh.adj.get(nid) ?? []) {
        const e2 = mh.edges.get(eid2);
        if (e2 && e2.lineIds.has(lid) && drawsOn(lid, eid2)) { drawn = true; break; }
      }
      if (!drawn) return;
      const set = marksPerNode.get(nid) ?? new Set<string>();
      set.add(lid);
      marksPerNode.set(nid, set);
    };
    check(e.from, atFrom);
    check(e.to, atTo);
  }
}
for (const { name, gid } of namedPx) {
  const st = mh.stations.get(gid);
  if (!st) { console.log(`  ${name.padEnd(20)} NOT in mh.stations`); continue; }
  const nid = st.nodeId;
  const d = (mh.adj.get(nid) ?? []).length;
  const marks = marksPerNode.get(nid) ?? new Set();
  const stopLines = [...mh.stopAt].filter((k) => k.endsWith('|' + nid)).map((k) => bullet(k.split('|')[0]));
  const drawn = mimg.placement.get(nid);
  console.log(
    `  ${name.padEnd(20)} node=${nid.slice(0, 10)} deg=${d} stopAtLines=[${stopLines.sort().join('')}] marks=${marks.size} [${[...marks].map(bullet).sort().join('')}] -> ${marks.size > 1 ? 'CAPSULE' : marks.size === 1 ? 'circle' : 'NONE'} drawn=(${drawn?.[0].toFixed(0)},${drawn?.[1].toFixed(0)})`,
  );
}
// also: which OTHER nodes in window get capsules?
console.log('-- all capsule nodes in window:');
for (const [nid, set] of marksPerNode) {
  if (set.size < 2) continue;
  const p = mh.nodes.get(nid)?.pos;
  if (!p || !inWinPx(p)) continue;
  const stationNames = [...mh.stations.values()].filter((s) => s.nodeId === nid).map((s) => s.label);
  console.log(
    `  ${nid.slice(0, 10)} marks=[${[...set].map(bullet).sort().join('')}] deg=${(mh.adj.get(nid) ?? []).length} pos=(${p[0].toFixed(0)},${p[1].toFixed(0)}) stations=[${stationNames.join('; ')}] near ${nearestNamed(p)}`,
  );
}
