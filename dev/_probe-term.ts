// Probe: terminus "branch" artifact — e.g. 1 Pl (yellow) and 12 Av (lime).
// For each named station: group, true order in its route(s) (from stCombos),
// support node, degree, and the support traversal tail near the terminus.
// Usage: npx tsx dev/_probe-term.ts "1 Pl" "10 St" "12 Pl" ...
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const NAMES = process.argv.slice(2);
if (NAMES.length === 0) NAMES.push('1 Pl', '10 St', '12 Pl', '36 St');

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
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

// group name lookup
const gByName = new Map<string, typeof groups>();
for (const g of groups) {
  const arr = gByName.get(g.name) ?? [];
  arr.push(g);
  gByName.set(g.name, arr as typeof groups);
}
const nameOfGroup = new Map<string, string>();
for (const g of groups) nameOfGroup.set(g.id, g.name);

// station -> group (for stCombos resolution)
const stToGroup = new Map<string, string>();
for (const g of groups) for (const sid of g.stationIds ?? []) stToGroup.set(sid, g.id);

const wanted = new Set<string>();
for (const n of NAMES) for (const g of gByName.get(n) ?? []) wanted.add(g.id);

// routes whose stop sequence touches a wanted group: print true stop order
console.log('=== true route stop orders (from stCombos) ===');
const touchedLines = new Set<string>();
for (const r of routes) {
  if (r.tempParentId) continue;
  const seq: string[] = [];
  for (const combo of r.stCombos ?? []) {
    const sid = combo?.stations?.[0]?.id ?? combo?.id;
    const gid = stToGroup.get(sid) ?? sid;
    seq.push(gid);
  }
  if (!seq.some((gid) => wanted.has(gid))) continue;
  touchedLines.add(r.id);
  const namesSeq = seq.map((gid) => {
    const nm = nameOfGroup.get(gid) ?? gid?.slice?.(0, 6) ?? '?';
    return wanted.has(gid) ? `[${nm}]` : nm;
  });
  console.log(`route ${r.id.slice(0, 8)} (${r.bullet ?? '?'} ${r.color}):`);
  console.log(`  ${namesSeq.join(' > ')}`);
}

// ---- support + octi (production opts) ---------------------------------------
const dHat = 16;
const params: TopoParams = {
  dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};
const h = buildSupportGraph(graph, groups, params);
const divisor = h.edges.size > 800 ? 1.2 : 1.6;
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h) / divisor),
  geographicAffinity: 0.05,
};
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);
separateFusedStations(merged.h, merged.img, dHat);

const fmt = (p?: Pixel) => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(?)');

for (const [tag, hh, image] of [
  ['support', h, img],
  ['merged ', merged.h, merged.img],
] as const) {
  console.log(`\n=== ${tag}: wanted stations ===`);
  const nodeNames = new Map<string, string[]>();
  for (const st of hh.stations.values()) {
    const arr = nodeNames.get(st.nodeId) ?? [];
    arr.push(st.label);
    nodeNames.set(st.nodeId, arr);
  }
  for (const gid of wanted) {
    const st = hh.stations.get(gid);
    if (!st) { console.log(`${nameOfGroup.get(gid)}: MISSING`); continue; }
    const deg = (hh.adj.get(st.nodeId) ?? []).length;
    const truePx = proj.toSVG(groups.find((g) => g.id === gid)!.center) as Pixel;
    console.log(
      `${st.label.padEnd(22)} node=${st.nodeId} deg=${deg} drawn=${fmt(image.placement.get(st.nodeId))} ` +
      `nodeTrue=${fmt(hh.nodes.get(st.nodeId)?.pos)} true=${fmt(truePx)}`,
    );
    for (const eid of hh.adj.get(st.nodeId) ?? []) {
      const e = hh.edges.get(eid);
      if (!e) continue;
      const other = e.from === st.nodeId ? e.to : e.from;
      console.log(
        `    edge ${eid} -> ${other} ${fmt(hh.nodes.get(other)?.pos)} ` +
        `[${nodeNames.get(other)?.join('+') ?? ''}] lines={${[...e.lineIds].map((l) => l.slice(0, 8)).join(',')}}`,
      );
    }
  }

  console.log(`\n=== ${tag}: traversal tails for touched lines ===`);
  for (const lineId of touchedLines) {
    const trav = hh.lineTraversals.get(lineId);
    if (!trav) { console.log(`line ${lineId.slice(0, 8)}: NO TRAVERSAL`); continue; }
    // node sequence
    const seq: string[] = [];
    for (let i = 0; i < trav.length; i++) {
      const e = hh.edges.get(trav[i].edgeId);
      if (!e) continue;
      const a = trav[i].reversed ? e.to : e.from;
      const b = trav[i].reversed ? e.from : e.to;
      if (i === 0) seq.push(a);
      seq.push(b);
    }
    const lbl = (nid: string) => {
      const names = nodeNames.get(nid);
      return `${nid}${names ? `[${names.join('+')}]` : ''}${fmt(hh.nodes.get(nid)?.pos)}`;
    };
    const head = seq.slice(0, 6).map(lbl).join(' > ');
    const tail = seq.slice(-6).map(lbl).join(' > ');
    console.log(`line ${lineId.slice(0, 8)} (${hh.lineRefs.get(lineId)?.label ?? '?'}): ${seq.length} nodes`);
    console.log(`  head: ${head}`);
    console.log(`  tail: ${tail}`);
  }
}
