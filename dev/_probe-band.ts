// Probe: trace lines 5 and Z (the lanes the user flagged) through the gray×green
// exchange. Build the full layout (orderLines + untangle, honoring
// OCTI_GROUP_SEED), then walk each line's traversal and print, per edge, the
// line's lateral INDEX in that edge's lineOrder + the edge's drawn direction.
// Where a line's index changes between consecutive edges in the bundle = the
// lane swap = where its 90° jog is drawn. This pinpoints the mechanism: is the
// swap forced by untangle's order, on which edge, and do 5 & Z cross as a clean
// band-on-band X or a line-by-line braid.
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
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h) / divisor),
  geographicAffinity: 0.05,
  penalties: { ndMovePen: Number(process.env.OCTI_NDMOVE ?? 0.5) },
};
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
separateFusedStations(merged.h, merged.img, dHat);
const hh = merged.h;
const image = merged.img;
const bullet = (lid: string) => hh.lineRefs.get(lid)?.label ?? lid.slice(0, 4);
const idOf = new Map<string, string>();
for (const [id, ref] of hh.lineRefs) idOf.set(ref.label ?? id, id);

const nodeNames = new Map<string, string>();
for (const st of hh.stations.values()) if (!nodeNames.has(st.nodeId)) nodeNames.set(st.nodeId, st.label);
const lbl = (nid: string) => `${nid}${nodeNames.has(nid) ? `[${nodeNames.get(nid)}]` : ''}`;

const layout: Layout = (() => {
  const nodes = new Map<string, LayoutNode>();
  for (const [id, n] of hh.nodes) nodes.set(id, { id, cell: [n.pos[0], n.pos[1]] as Cell, label: nodeNames.get(id) ?? '', lngLat: [0, 0] as Coordinate });
  const edges: LayoutEdge[] = [];
  for (const e of hh.edges.values()) {
    const lines = [...e.lineIds].map((id) => hh.lineRefs.get(id)!).filter(Boolean);
    const stops = new Map<string, EdgeStop>();
    for (const id of e.lineIds) { const af = hh.stopAt.has(id + '|' + e.from); const at = hh.stopAt.has(id + '|' + e.to); if (af || at) stops.set(id, { atFrom: af, atTo: at }); }
    const routed = image.paths.get(e.id) ?? e.points;
    edges.push({ id: e.id, from: e.from, to: e.to, path: routed.map((p) => [p[0], p[1]] as Cell), lines, lineOrder: lines.map((l) => l.id).sort(), stops });
  }
  return { cellSize: 1, nodes, edges, lineTraversals: hh.lineTraversals };
})();
orderLines(layout);
untangleLineOrder(layout);

const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
const posOf = (nid: string): Pixel => (image.placement.get(nid) ?? hh.nodes.get(nid)?.pos ?? [0, 0]);
const fmt = (p: Pixel) => `(${p[0].toFixed(0)},${p[1].toFixed(0)})`;
// drawn direction of edge leaving nid (first ~18px of routed path)
const dirLeaving = (e: LayoutEdge, nid: string): number => {
  const path = (image.paths.get(e.id) ?? []).map((p) => p as Pixel);
  const pts = e.from === nid ? path : [...path].reverse();
  if (pts.length < 2) { const o = posOf(e.from === nid ? e.to : e.from); const a = posOf(nid); return Math.atan2(o[1] - a[1], o[0] - a[0]) * 180 / Math.PI; }
  const a = pts[0]; let ref = pts[pts.length - 1]; let acc = 0;
  for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc >= 18) { ref = pts[i]; break; } }
  return Math.atan2(ref[1] - a[1], ref[0] - a[0]) * 180 / Math.PI;
};

for (const tag of ['5', 'Z']) {
  const lid = idOf.get(tag)!;
  const trav = hh.lineTraversals.get(lid) ?? [];
  console.log(`\n===== line ${tag} (${lid.slice(0, 8)}): ${trav.length} traversal steps =====`);
  let prevIdx = -999, prevTo = '';
  for (const step of trav) {
    const e = edgeById.get(step.edgeId);
    if (!e) continue;
    const ord = step.reversed ? [...e.lineOrder].reverse() : e.lineOrder;
    const idx = ord.indexOf(lid);
    const from = step.reversed ? e.to : e.from;
    const to = step.reversed ? e.from : e.to;
    // restrict to the Sands–Flatbush region
    const fp = posOf(from), tp = posOf(to);
    const inRegion = [fp, tp].some((p) => p[0] > 840 && p[0] < 1100 && p[1] > 1660 && p[1] < 1860);
    if (!inRegion) { prevTo = to; prevIdx = idx; continue; }
    const swap = prevTo === from && prevIdx !== -999 && idx !== prevIdx ? `  <<< INDEX ${prevIdx}->${idx} (swap)` : '';
    const dir = dirLeaving(e, from);
    console.log(
      `  ${lbl(from)} ${fmt(fp)} -> ${lbl(to)} ${fmt(tp)} | bundle=${e.lineOrder.length} idx=${idx} ` +
      `dir=${dir.toFixed(0)}° order=[${ord.map(bullet).join(',')}]${swap}`,
    );
    prevTo = to; prevIdx = idx;
  }
}
