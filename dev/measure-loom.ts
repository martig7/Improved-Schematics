/**
 * Compare JS LOOM pipeline metrics against paper/LOOM targets on a real save.
 * Usage: pnpm exec tsx dev/measure-loom.ts [save.json]
 */
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import { orderLines } from '../src/render/layout/lineOrder';
import { computeCanonicalOffsets, offsetPolyline } from '../src/render/layout/offsets';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';
import type { Pixel, Layout, SupportGraph, TraversalStep } from '../src/render/layout/types';

const APP =
  process.env.APPDATA +
  '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const savePath = process.argv[2] ?? APP + 'new_york_freeplay_590fec73.json';
const data = JSON.parse(readFileSync(savePath, 'utf-8')).data ?? JSON.parse(readFileSync(savePath, 'utf-8'));
const groups = getOrBuildStationGroups(data.stations, data.stationGroups);
const graph = buildTransitGraph(data.stations, data.routes, groups, data.tracks);

const LINE_WIDTH = 4;
const bounds = (() => {
  const framePts = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
  for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
  const b = computeBounds(framePts);
  return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
})();
const proj = createProjection(bounds, 2700, 2700, 0.06);
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

// Same tuning as renderGeographic.ts renderSmoothed / renderGeographicTopo
const dHat = Math.max(8, LINE_WIDTH * 4);
const topoParams: TopoParams = {
  dHat,
  step: Math.max(2, dHat / 4),
  convergenceEpsilon: 0.002,
  maxRounds: 8,
  stationCandidateRadius: 2 * dHat,
  preserveStations: false,
};

function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function isOctiSeg(a: Pixel, b: Pixel): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  if (dx < 1e-3 && dy < 1e-3) return true;
  return dx < 1e-3 || dy < 1e-3 || Math.abs(dx - dy) < 1e-3;
}

function countDiscontinuities(
  traversals: Map<string, TraversalStep[]>,
  edges: SupportGraph['edges'],
): { total: number; byLine: Map<string, number> } {
  let total = 0;
  const byLine = new Map<string, number>();
  for (const [lid, steps] of traversals) {
    let d = 0;
    for (let i = 1; i < steps.length; i++) {
      const e0 = edges.get(steps[i - 1].edgeId)!;
      const e1 = edges.get(steps[i].edgeId)!;
      const end0 = steps[i - 1].reversed ? e0.from : e0.to;
      const start1 = steps[i].reversed ? e1.to : e1.from;
      if (end0 !== start1) {
        d++;
        total++;
      }
    }
    if (d) byLine.set(lid, d);
  }
  return { total, byLine };
}

function polylineOctiScore(pts: Pixel[]): { ok: number; bad: number } {
  let ok = 0;
  let bad = 0;
  for (let i = 1; i < pts.length; i++) {
    if (isOctiSeg(pts[i - 1], pts[i])) ok++;
    else bad++;
  }
  return { ok, bad };
}

function supportToLayoutMinimal(h: SupportGraph): Layout {
  const nodes = new Map<string, { id: string; cell: [number, number]; label: string; lngLat: [number, number] }>();
  for (const [id, n] of h.nodes) {
    nodes.set(id, { id, cell: [n.pos[0], n.pos[1]], label: '', lngLat: [0, 0] });
  }
  const edges = [...h.edges.values()].map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    path: e.points.map((p) => [p[0], p[1]] as [number, number]),
    lines: [...e.lineIds].map((id) => h.lineRefs.get(id)!),
    lineOrder: [...e.lineIds].sort(),
    stops: new Map(),
  }));
  return { cellSize: 1, nodes, edges, lineTraversals: h.lineTraversals };
}

/** Gap at each consecutive traversal step: offset path end vs next start (px). */
function renderGapMetrics(layout: Layout, nodePx: Map<string, Pixel>): {
  gapsOver1px: number;
  gapsOverLineWidth: number;
  maxGap: number;
  avgGap: number;
  samples: number;
} {
  const offsets = computeCanonicalOffsets(layout);
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  let gapsOver1 = 0;
  let gapsOverLw = 0;
  let maxGap = 0;
  let sum = 0;
  let samples = 0;

  for (const [lineId, traversal] of layout.lineTraversals) {
    const off = offsets.get(lineId) ?? 0;
    let prevEnd: Pixel | null = null;
    let prevEndNode: string | null = null;
    for (let i = 0; i < traversal.length; i++) {
      const step = traversal[i];
      const edge = edgeById.get(step.edgeId);
      if (!edge) continue;
      const base = edge.path.map((c) => [c[0], c[1]] as Pixel);
      const path = off === 0 ? base : offsetPolyline(base, off);
      const oriented = step.reversed ? [...path].reverse() : path;
      const startNode = step.reversed ? edge.to : edge.from;
      const endNode = step.reversed ? edge.from : edge.to;

      if (prevEnd && prevEndNode === startNode) {
        const g = dist(prevEnd, oriented[0]);
        sum += g;
        samples++;
        if (g > maxGap) maxGap = g;
        if (g > 1) gapsOver1++;
        if (g > LINE_WIDTH) gapsOverLw++;
      } else if (i > 0) {
        // topological discontinuity — counts as infinite gap for rendering
        gapsOver1++;
        gapsOverLw++;
        samples++;
        sum += 999;
        if (999 > maxGap) maxGap = 999;
      }
      prevEnd = oriented[oriented.length - 1];
      prevEndNode = endNode;
    }
  }
  return {
    gapsOver1px: gapsOver1,
    gapsOverLineWidth: gapsOverLw,
    maxGap,
    avgGap: samples ? sum / samples : 0,
    samples,
  };
}

function section(title: string) {
  console.log('\n=== ' + title + ' ===');
}

section('Input');
console.log('nodes', graph.nodes.size, 'edges', graph.edges.length, 'lines', graph.lineTraversals.size);
const inputLens: number[] = [];
for (const e of graph.edges) {
  const a = graph.nodes.get(e.from)!.pos;
  const b = graph.nodes.get(e.to)!.pos;
  inputLens.push(dist(a, b));
}
inputLens.sort((x, y) => x - y);
console.log('edge length px: min', inputLens[0].toFixed(1), 'median', inputLens[inputLens.length >> 1].toFixed(1), 'max', inputLens.at(-1)!.toFixed(1));
console.log('dHat (render tuning)', dHat, 'px  |  paper formula', (2.5 * LINE_WIDTH * 2).toFixed(0), 'px (maxLines=2)');

section('Topo merge');
const support = buildSupportGraph(graph, groups, topoParams);
reportTopo('with preserveStations', support, graph.edges.length);

const noPreserveParams = { ...topoParams, preserveStations: false };
const supportLean = buildSupportGraph(graph, groups, noPreserveParams);
reportTopo('without preserveStations (paper-like)', supportLean, graph.edges.length);

function reportTopo(label: string, h: SupportGraph, inputEdgeCount: number) {
  const mergeRatio = 1 - h.edges.size / inputEdgeCount;
  const multiLineEdges = [...h.edges.values()].filter((e) => e.lineIds.size > 1).length;
  const disc = countDiscontinuities(h.lineTraversals, h.edges);
  console.log(`\n[${label}]`);
  console.log('  nodes', h.nodes.size, 'edges', h.edges.size);
  console.log('  edge reduction', (mergeRatio * 100).toFixed(1) + '%');
  console.log('  multi-line corridors', multiLineEdges);
  console.log('  traversal discontinuities', disc.total);
}

// Continue full pipeline on production settings (preserveStations=true)
const mergeRatio = 1 - support.edges.size / graph.edges.length;
const multiLineEdges = [...support.edges.values()].filter((e) => e.lineIds.size > 1).length;
const supDisc = countDiscontinuities(support.lineTraversals, support.edges);
console.log('support nodes', support.nodes.size, 'edges', support.edges.size, 'stations', support.stations.size);
console.log('edge reduction', (mergeRatio * 100).toFixed(1) + '%', `(${graph.edges.length} → ${support.edges.size})`);
console.log('multi-line corridor edges', multiLineEdges, '/', support.edges.size);
console.log('avg lines per support edge', (() => {
  let s = 0;
  for (const e of support.edges.values()) s += e.lineIds.size;
  return (s / support.edges.size).toFixed(2);
})());
console.log('original line traversal discontinuities', 0);
console.log('support line traversal discontinuities', supDisc.total, '← render pen-lifts if >0');
if (supDisc.byLine.size) {
  const worst = [...supDisc.byLine.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('worst lines:', worst.map(([id, n]) => `${id}:${n}`).join(', '));
}
const degs = [...support.adj.values()].map((a) => a.length);
console.log('node degree max', Math.max(...degs), 'deg≥4', degs.filter((d) => d >= 4).length);

section('Octi schematicization');
const image = octi(support, DEFAULT_OCTI_OPTIONS);
console.log('cellSize dg', image.cellSize.toFixed(1), 'px  (median edge', medianEdgeLength(support).toFixed(1), ')');
let dispMax = 0;
let dispSum = 0;
for (const [id, n] of support.nodes) {
  const p = image.placement.get(id);
  if (!p) continue;
  const d = dist(p, n.pos);
  dispSum += d;
  if (d > dispMax) dispMax = d;
}
console.log('node displacement: avg', (dispSum / support.nodes.size).toFixed(1), 'px  max', dispMax.toFixed(1), 'px  budget', (1.5 * image.cellSize).toFixed(1), 'px');
let octOk = 0;
let octBad = 0;
let pathVerts = 0;
for (const path of image.paths.values()) {
  const s = polylineOctiScore(path);
  octOk += s.ok;
  octBad += s.bad;
  pathVerts += path.length;
}
console.log('octilinear segments', octOk, 'ok /', octBad, 'non-octi  (', ((octOk / (octOk + octBad || 1)) * 100).toFixed(1) + '% compliant)');
console.log('avg verts per routed edge', (pathVerts / support.edges.size).toFixed(1));

section('Render-quality proxies (smoothed pipeline)');
const layout = supportToLayoutMinimal(support);
for (const e of layout.edges) {
  const routed = image.paths.get(e.id);
  if (routed) e.path = routed.map((p) => [p[0], p[1]] as [number, number]);
}
orderLines(layout);
const nodePx = new Map<string, Pixel>();
for (const [id, n] of support.nodes) nodePx.set(id, image.placement.get(id) ?? n.pos);
const gaps = renderGapMetrics(layout, nodePx);
console.log('offset stitch gaps >1px', gaps.gapsOver1px, '/', gaps.samples);
console.log('offset stitch gaps >lineWidth', gaps.gapsOverLineWidth, '/', gaps.samples);
console.log('max stitch gap', gaps.maxGap === 999 ? 'DISCONTINUITY' : gaps.maxGap.toFixed(2) + 'px');

section('LOOM parity scorecard (heuristic targets)');
const targets = [
  ['Edge reduction ≥30%', mergeRatio >= 0.3, `${(mergeRatio * 100).toFixed(0)}%`],
  ['Multi-line corridors present', multiLineEdges > 0, String(multiLineEdges)],
  ['Traversal discontinuities = 0', supDisc.total === 0, String(supDisc.total)],
  ['Octilinear ≥99%', octOk / (octOk + octBad || 1) >= 0.99, ((octOk / (octOk + octBad || 1)) * 100).toFixed(1) + '%'],
  ['Displacement ≤ budget', dispMax <= 1.5 * image.cellSize + 1, `${dispMax.toFixed(1)}/${(1.5 * image.cellSize).toFixed(1)}px`],
  ['Render gaps = 0', gaps.gapsOver1px === 0, String(gaps.gapsOver1px)],
] as const;
let pass = 0;
for (const [name, ok, val] of targets) {
  console.log((ok ? '✓' : '✗'), name, '→', val);
  if (ok) pass++;
}
console.log(`\nOverall: ${pass}/${targets.length} checks pass`);
