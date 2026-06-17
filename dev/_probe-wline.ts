// Probe: Lawrence -> Burke Ct corridor fidelity, support level vs drawn level.
// For the route serving both endpoints, measure each stop's distance from its
// true (warped) position to the support corridor polyline and to the final
// octi-drawn corridor. Separates "topo bent the course" from "octi ignored it".
// Usage: npx tsx dev/_probe-wline.ts [nameA] [nameB]
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const nameA = (process.argv[2] ?? 'lawrence').toLowerCase();
const nameB = (process.argv[3] ?? 'burke').toLowerCase();

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

// ---- find the route serving both endpoint names ----------------------------
const byName = (needle: string) => groups.filter((g) => g.name.toLowerCase().includes(needle));
const gA = byName(nameA);
const gB = byName(nameB);
console.log(`name "${nameA}": ${gA.map((g) => `${g.name}(${g.id.slice(0, 6)})`).join(', ') || 'NONE'}`);
console.log(`name "${nameB}": ${gB.map((g) => `${g.name}(${g.id.slice(0, 6)})`).join(', ') || 'NONE'}`);

// route -> ordered groupIds it stops at, recovered from graph edges' line sets
// plus stop flags later; for route identification just use edge.lines.
const groupIdsA = new Set(gA.map((g) => g.id));
const groupIdsB = new Set(gB.map((g) => g.id));
const linesTouching = (ids: Set<string>) => {
  const out = new Set<string>();
  for (const e of graph.edges) {
    if (ids.has(e.from) || ids.has(e.to)) for (const l of e.lines) out.add(l.id);
  }
  return out;
};
const lA = linesTouching(groupIdsA);
const lB = linesTouching(groupIdsB);
const shared = [...lA].filter((id) => lB.has(id));
console.log(`lines at A: ${[...lA].join(',')} | at B: ${[...lB].join(',')} | shared: ${shared.join(',')}`);
if (shared.length === 0) {
  console.log('no shared line; aborting');
  process.exit(1);
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
const affEnv = Number(process.env.OCTI_AFFINITY);
if (Number.isFinite(affEnv) && affEnv > 0) octiOpts.geographicAffinity = affEnv;
const img = octi(h, octiOpts);
const merged = mergeCoincidentPaths(h, img);

const dist = (a: Pixel, b: Pixel) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ptSeg = (p: Pixel, a: Pixel, b: Pixel): number => {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return dist(p, a);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return dist(p, b);
  const t = c1 / c2;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
};
const distToPoly = (p: Pixel, poly: Pixel[]): number => {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) best = Math.min(best, ptSeg(p, poly[i - 1], poly[i]));
  return best;
};
const bbox = (poly: Pixel[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return `[${x0.toFixed(0)},${y0.toFixed(0)} .. ${x1.toFixed(0)},${y1.toFixed(0)}]`;
};

// ---- visual overlay: true support courses (dashed) vs drawn paths (solid)
// for every line touching the A/B window, cropped to the corridor bbox.
{
  const win = { x0: 450, y0: 1900, x1: 900, y1: 2350 };
  const inWin = (p: Pixel) => p[0] >= win.x0 - 60 && p[0] <= win.x1 + 60 && p[1] >= win.y0 - 60 && p[1] <= win.y1 + 60;
  const lines = new Set<string>();
  for (const e of h.edges.values()) {
    if (e.points.some(inWin)) for (const l of e.lineIds) lines.add(l);
  }
  const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa6a6', '#f032e6', '#9a6324', '#000075', '#808000'];
  const lineColor = new Map<string, string>();
  for (const lid of [...lines].sort()) lineColor.set(lid, PALETTE[lineColor.size % PALETTE.length]);
  const colorOf = (lid: string) => lineColor.get(lid) ?? '#888';
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${win.x0} ${win.y0} ${win.x1 - win.x0} ${win.y1 - win.y0}">`;
  svg += `<rect x="${win.x0}" y="${win.y0}" width="${win.x1 - win.x0}" height="${win.y1 - win.y0}" fill="white"/>`;
  let ly = win.y0 + 12;
  for (const [lid, c] of lineColor) {
    const ref = h.lineRefs.get(lid);
    svg += `<text x="${win.x0 + 6}" y="${ly}" font-size="9" fill="${c}">${ref?.label ?? lid.slice(0, 8)} (${lid.slice(0, 8)})</text>`;
    ly += 11;
  }
  const poly = (pts: Pixel[], stroke: string, dash: string, w: number, op: number) =>
    `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  for (const lid of lines) {
    const trav = h.lineTraversals.get(lid);
    if (!trav) continue;
    for (const step of trav) {
      const e = h.edges.get(step.edgeId);
      if (!e || !e.points.some(inWin)) continue;
      svg += poly(e.points, colorOf(lid), '6 5', 2, 0.85);
      const dp = img.paths.get(step.edgeId);
      if (dp) svg += poly(dp, colorOf(lid), '', 3.5, 0.55);
    }
  }
  // station truths for the shared (W) line
  for (const g of groups) {
    const truePx = proj.toSVG(g.center) as Pixel;
    if (!inWin(truePx)) continue;
    svg += `<circle cx="${truePx[0].toFixed(1)}" cy="${truePx[1].toFixed(1)}" r="3" fill="black" fill-opacity="0.5"/>`;
    svg += `<text x="${(truePx[0] + 4).toFixed(1)}" y="${(truePx[1] - 3).toFixed(1)}" font-size="7" fill="#333">${g.name}</text>`;
  }
  svg += '</svg>';
  const { writeFileSync } = await import('fs');
  writeFileSync('dev/_wline-overlay.svg', svg);
  const { Resvg } = await import('@resvg/resvg-js');
  writeFileSync('dev/_wline-overlay.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1300 } }).render().asPng());
  console.log('wrote dev/_wline-overlay.{svg,png} — dashed=true course, solid=drawn');
}

for (const lineId of shared) {
  const ref = [...h.lineRefs.values()].find((r) => r.id === lineId);
  console.log(`\n=== line ${lineId} (${ref?.label ?? '?'} ${ref?.color ?? ''}) ===`);

  for (const [tag, hh, image] of [
    ['support', h, img],
    ['merged ', merged.h, merged.img],
  ] as const) {
    const trav = hh.lineTraversals.get(lineId);
    if (!trav) { console.log(`${tag}: NO TRAVERSAL`); continue; }

    // corridor polylines: support-level (edge.points) and drawn-level (img.paths)
    const supPoly: Pixel[] = [];
    const drawnPoly: Pixel[] = [];
    for (const step of trav) {
      const e = hh.edges.get(step.edgeId);
      if (!e) continue;
      const sp = step.reversed ? [...e.points].reverse() : e.points;
      supPoly.push(...sp);
      const dp0 = image.paths.get(step.edgeId);
      if (dp0) drawnPoly.push(...(step.reversed ? [...dp0].reverse() : dp0));
    }
    console.log(`${tag}: trav=${trav.length} edges, supBBox=${bbox(supPoly)} drawnBBox=${bbox(drawnPoly)}`);

    // every group whose support station node lies on this traversal
    const travNodes = new Set<string>();
    for (const step of trav) {
      const e = hh.edges.get(step.edgeId);
      if (e) { travNodes.add(e.from); travNodes.add(e.to); }
    }
    const rows: Array<{ name: string; supErr: number; drawnErr: number; markErr: number }> = [];
    for (const g of groups) {
      const st = hh.stations.get(g.id);
      if (!st || !travNodes.has(st.nodeId)) continue;
      if (!hh.stopAt.has(`${lineId}|${st.nodeId}`)) continue;
      const truePx = proj.toSVG(g.center) as Pixel;
      const drawnPos = image.placement.get(st.nodeId);
      rows.push({
        name: g.name,
        supErr: distToPoly(truePx, supPoly),
        drawnErr: distToPoly(truePx, drawnPoly),
        markErr: drawnPos ? dist(drawnPos, truePx) : NaN,
      });
    }
    rows.sort((a, b) => b.drawnErr - a.drawnErr);
    for (const r of rows.slice(0, 18)) {
      console.log(
        `  ${r.name.padEnd(20)} sup=${r.supErr.toFixed(1).padStart(6)}  ` +
        `drawn=${r.drawnErr.toFixed(1).padStart(6)}  marker=${r.markErr.toFixed(1).padStart(6)}`,
      );
    }
    if (rows.length > 18) console.log(`  ... ${rows.length - 18} more (sorted by drawn err)`);
  }
}
