// Probe: junction structure at a named NYC station (default Flatbush Av) — to
// decide the ordering-vs-topology fork for the within-bundle braid. For the
// station node AND its 1-hop neighbours: degree, incident corridors, and the
// line BULLETS on each corridor (so we can see how the band splits by exit).
// Usage: npx tsx dev/_probe-flat.ts ["Flatbush Av" ...]
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import { orderLines } from '../src/render/layout/lineOrder';
import { untangleLineOrder } from '../src/render/layout/untangle';
import type { Pixel, Layout, LayoutEdge, LayoutNode, EdgeStop, Cell } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const NAMES = process.argv.slice(2);
if (NAMES.length === 0) NAMES.push('Flatbush Av');

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

const gByName = new Map<string, string[]>();
for (const g of groups) { const a = gByName.get(g.name) ?? []; a.push(g.id); gByName.set(g.name, a); }
const nameOfGroup = new Map<string, string>();
for (const g of groups) nameOfGroup.set(g.id, g.name);
const wanted = new Set<string>();
for (const n of NAMES) for (const gid of gByName.get(n) ?? []) wanted.add(gid);

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
const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(?)');
const nodeNames = new Map<string, string[]>();
for (const st of hh.stations.values()) {
  const a = nodeNames.get(st.nodeId) ?? []; a.push(st.label); nodeNames.set(st.nodeId, a);
}
const lbl = (nid: string) => `${nid}${nodeNames.has(nid) ? `[${nodeNames.get(nid)!.join('+')}]` : ''}`;

// node ids of wanted stations
const seedNodes = new Set<string>();
for (const gid of wanted) { const st = hh.stations.get(gid); if (st) seedNodes.add(st.nodeId); }

const describe = (nid: string, indent = '') => {
  const deg = (hh.adj.get(nid) ?? []).length;
  console.log(`${indent}${lbl(nid)} deg=${deg} drawn=${fmt(image.placement.get(nid))} stopAt=[${
    [...hh.stopAt].filter((k) => k.endsWith('|' + nid)).map((k) => bullet(k.split('|')[0])).join(',')
  }]`);
  for (const eid of hh.adj.get(nid) ?? []) {
    const e = hh.edges.get(eid);
    if (!e) continue;
    const other = e.from === nid ? e.to : e.from;
    console.log(`${indent}    -> ${lbl(other)} ${fmt(hh.nodes.get(other)?.pos)} lines={${[...e.lineIds].map(bullet).sort().join(',')}}`);
  }
};

for (const nid of seedNodes) {
  console.log(`\n=== JUNCTION ${lbl(nid)} ===`);
  describe(nid);
  console.log(`  --- 1-hop neighbours ---`);
  const seen = new Set([nid]);
  for (const eid of hh.adj.get(nid) ?? []) {
    const e = hh.edges.get(eid);
    if (!e) continue;
    const other = e.from === nid ? e.to : e.from;
    if (seen.has(other)) continue;
    seen.add(other);
    describe(other, '  ');
  }
}

// ---- build layout, run orderLines + untangle, dump the produced order --------
const layout: Layout = (() => {
  const nodes = new Map<string, LayoutNode>();
  for (const [id, n] of hh.nodes) {
    nodes.set(id, { id, cell: [n.pos[0], n.pos[1]] as Cell, label: nodeNames.get(id)?.[0] ?? '', lngLat: [0, 0] as Coordinate });
  }
  const edges: LayoutEdge[] = [];
  for (const e of hh.edges.values()) {
    const lines = [...e.lineIds].map((id) => hh.lineRefs.get(id)!).filter(Boolean);
    const stops = new Map<string, EdgeStop>();
    for (const id of e.lineIds) {
      const atFrom = hh.stopAt.has(id + '|' + e.from);
      const atTo = hh.stopAt.has(id + '|' + e.to);
      if (atFrom || atTo) stops.set(id, { atFrom, atTo });
    }
    const routed = image.paths.get(e.id) ?? e.points;
    edges.push({ id: e.id, from: e.from, to: e.to, path: routed.map((p) => [p[0], p[1]] as Cell), lines, lineOrder: lines.map((l) => l.id).sort(), stops });
  }
  return { cellSize: 1, nodes, edges, lineTraversals: hh.lineTraversals };
})();
orderLines(layout);
untangleLineOrder(layout);

const dumpOrders = (tag: string) => {
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  for (const nid of seedNodes) {
    console.log(`\n=== ${tag}: untangle lineOrder at ${lbl(nid)} (leaving the node) ===`);
    for (const eid of hh.adj.get(nid) ?? []) {
      const e = edgeById.get(eid);
      if (!e) continue;
      const other = e.from === nid ? e.to : e.from;
      const ord = e.from === nid ? e.lineOrder : [...e.lineOrder].reverse();
      console.log(`  -> ${lbl(other)}: [${ord.map(bullet).join(',')}]`);
    }
  }
};
dumpOrders('BASELINE');

// PHASE-0 TEST A: relabel the non-station split nodes around Flatbush (mn59, mn152)
// as STATIONS, so a braided arrival's crossing there costs inStatCrossPen. Does
// untangle then GROUP the band (clean marker)? Tests the §2.0 "make split expensive".
const EXPENSIVE = (process.env.PHASE0_STATIONS ?? 'mn59,mn152').split(',').filter(Boolean);
for (const id of EXPENSIVE) {
  const n = layout.nodes.get(id);
  if (n) n.label = n.label || `EXP_${id}`;
}
orderLines(layout);
untangleLineOrder(layout);
dumpOrders(`STATIONS+={${EXPENSIVE.join(',')}}`);

// PHASE-0 TEST B: FORCE the clean grouped band onto the trunk + east edges, then
// run untangle. If untangle KEEPS it -> grouped is reachable/stable (a seed
// problem, fixable). If it REVERTS to the braid -> grouped genuinely scores worse
// (a real crossing trade-off; decomposition can't help either). Decisive.
const idOf = new Map<string, string>(); // bullet -> lineId
for (const [id, ref] of hh.lineRefs) idOf.set(ref.label ?? id, id);
const force = (a: string, b: string, bullets: string[]) => {
  const e = layout.edges.find(
    (x) => (x.from === a && x.to === b) || (x.from === b && x.to === a),
  );
  if (!e) { console.log(`  (force: no edge ${a}-${b})`); return; }
  const ids = bullets.map((x) => idOf.get(x)!).filter(Boolean);
  e.lineOrder = e.from === a ? ids : [...ids].reverse(); // bullets read leaving a
};
orderLines(layout);
// grouped band leaving mn147: greens, grays, 9 (9 at the gray end -> Adelphi)
force('mn147', 'mn59', ['5', '6', '7', '8', 'Y', 'Z', '9']);
force('mn147', 'mn152', ['7', '8', 'Y', 'Z', '9']); // east portion, same grouping
untangleLineOrder(layout);
dumpOrders('FORCED-GROUPED then untangle');
