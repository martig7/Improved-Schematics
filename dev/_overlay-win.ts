// Truth-vs-drawn overlay for an arbitrary window: dashed = true support
// courses, solid = drawn paths, distinct synthetic colors per line + legend.
// Usage: npx tsx dev/_overlay-win.ts x0 y0 x1 y1 [out]
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths, separateFusedStations } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const [x0s = '700', y0s = '1950', x1s = '900', y1s = '2100', out = 'dev/_overlay.png'] = process.argv.slice(2);
const win = { x0: +x0s, y0: +y0s, x1: +x1s, y1: +y1s };

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

const params: TopoParams = {
  dHat: 16, step: 4, convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 32, preserveStations: false,
};
const h0 = buildSupportGraph(graph, groups, params);
const octiOpts = {
  ...DEFAULT_OCTI_OPTIONS,
  cellSize: Math.max(12, medianEdgeLength(h0) / (h0.edges.size > 800 ? 1.2 : 1.6)),
  geographicAffinity: 0.05,
};
const img0 = octi(h0, octiOpts);
const merged = mergeCoincidentPaths(h0, img0);
separateFusedStations(merged.h, merged.img, 16);
const h = merged.h;
const img = merged.img;

const inWin = (p: Pixel) =>
  p[0] >= win.x0 - 60 && p[0] <= win.x1 + 60 && p[1] >= win.y0 - 60 && p[1] <= win.y1 + 60;
const lines = new Set<string>();
for (const e of h.edges.values()) {
  if (e.points.some(inWin)) for (const l of e.lineIds) lines.add(l);
}
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa6a6', '#f032e6', '#9a6324', '#000075', '#808000', '#42d4f4', '#bfef45'];
const lineColor = new Map<string, string>();
for (const lid of [...lines].sort()) lineColor.set(lid, PALETTE[lineColor.size % PALETTE.length]);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${win.x0} ${win.y0} ${win.x1 - win.x0} ${win.y1 - win.y0}">`;
svg += `<rect x="${win.x0}" y="${win.y0}" width="${win.x1 - win.x0}" height="${win.y1 - win.y0}" fill="white"/>`;
let ly = win.y0 + 8;
for (const [lid, c] of lineColor) {
  const ref = h.lineRefs.get(lid);
  svg += `<text x="${win.x0 + 4}" y="${ly}" font-size="6" fill="${c}">${ref?.label ?? lid.slice(0, 8)} (${lid.slice(0, 8)})</text>`;
  ly += 7;
}
const poly = (pts: Pixel[], stroke: string, dash: string, w: number, op: number) =>
  `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
for (const lid of lines) {
  const trav = h.lineTraversals.get(lid);
  if (!trav) continue;
  const seen = new Set<string>();
  for (const step of trav) {
    if (seen.has(step.edgeId)) continue;
    seen.add(step.edgeId);
    const e = h.edges.get(step.edgeId);
    if (!e || !e.points.some(inWin)) continue;
    svg += poly(e.points, lineColor.get(lid)!, '4 3', 1.2, 0.9);
    const dp = img.paths.get(step.edgeId);
    if (dp) svg += poly(dp, lineColor.get(lid)!, '', 2.5, 0.45);
  }
}
for (const st of h.stations.values()) {
  const p = img.placement.get(st.nodeId);
  if (!p || !inWin(p)) continue;
  svg += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="black" fill-opacity="0.6"/>`;
  svg += `<text x="${(p[0] + 3).toFixed(1)}" y="${(p[1] - 2).toFixed(1)}" font-size="5" fill="#333">${st.label}</text>`;
}
svg += '</svg>';
writeFileSync(out.replace(/\.png$/, '.svg'), svg);
writeFileSync(out, new Resvg(svg, { fitTo: { mode: 'width', value: 1300 } }).render().asPng());
console.log('wrote', out);
