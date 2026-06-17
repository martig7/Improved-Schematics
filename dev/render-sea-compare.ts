/**
 * Render Seattle metro GeoJSON through our LOOM-style pipeline and compare
 * against reference LOOM output (dev/out-loom-sea.svg).
 *
 * Usage:
 *   pnpm exec tsx dev/render-sea-compare.ts [metro.geojson] [water.geojson]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { octi, DEFAULT_OCTI_OPTIONS, medianEdgeLength } from '../src/render/layout/octi';
import type { Route, Track, Station } from '../src/types/game-state';
import type { Coordinate } from '../src/types/core';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';
import type { Pixel } from '../src/render/layout/types';
import type { WaterCollection } from '../src/render/types';

type Coord = [number, number];

const metroPath = process.argv[2] ?? 'SEA-metro.geojson';
const waterPath = process.argv[3] ?? 'sea_water.geojson';
const OUT_SMOOTH = 'dev/out-sea-smooth.svg';
const OUT_LOOM = 'dev/out-loom-sea.svg';
const PNG_OURS = 'dev/out-sea-smooth.png';
const PNG_LOOM = 'dev/out-loom-sea.png';

function dist(a: Coord, b: Coord): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function projectOnPolyline(pts: Coord[], p: Coord): { arclen: number; snapD: number } {
  let bestD = Infinity;
  let bestArc = 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
    const q: Coord = [a[0] + t * vx, a[1] + t * vy];
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      bestArc = acc + Math.hypot(q[0] - a[0], q[1] - a[1]);
    }
    acc += Math.hypot(vx, vy);
  }
  return { arclen: bestArc, snapD: bestD };
}

function slicePolyline(pts: Coord[], a0: number, a1: number): Coord[] {
  if (a0 > a1) [a0, a1] = [a1, a0];
  const at = (target: number): Coord => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (acc + seg >= target - 1e-12) {
        const t = seg === 0 ? 0 : (target - acc) / seg;
        return [
          pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
          pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
        ];
      }
      acc += seg;
    }
    return pts[pts.length - 1];
  };
  const start = at(a0);
  const end = at(a1);
  const out: Coord[] = [start];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (acc + seg > a0 + 1e-9 && acc < a1 - 1e-9) {
      if (dist(out[out.length - 1], pts[i - 1]) > 1e-9) out.push(pts[i - 1]);
      if (dist(out[out.length - 1], pts[i]) > 1e-9 && dist(pts[i], end) > 1e-9) out.push(pts[i]);
    }
    acc += seg;
  }
  if (dist(out[out.length - 1], end) > 1e-9) out.push(end);
  return out.length >= 2 ? out : [start, end];
}

function simplifyPolyline(pts: Coord[], maxPts = 32): Coord[] {
  if (pts.length <= maxPts) return pts;
  const out: Coord[] = [pts[0]];
  const step = (pts.length - 1) / (maxPts - 1);
  for (let i = 1; i < maxPts - 1; i++) out.push(pts[Math.round(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

/** Convert metro GeoJSON export → minimal game-state shapes for buildTransitGraph. */
function metroGeoJsonToGame(raw: { features: Array<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }> }) {
  const stations: Station[] = [];
  const routes: Route[] = [];
  const tracks: Track[] = [];
  const routePolys = new Map<string, { id: string; bullet: string; color: string; coords: Coord[] }>();

  for (const f of raw.features) {
    const layer = f.properties.layer as string | undefined;
    if (layer === 'stations' && f.geometry.type === 'Point') {
      const id = String(f.properties.id);
      const stNodeId = 'sn-' + id;
      stations.push({
        id,
        name: String(f.properties.name ?? id),
        coords: f.geometry.coordinates as Coordinate,
        trackIds: [],
        trackGroupId: id,
        buildType: 'constructed',
        stNodeIds: [stNodeId],
        routeIds: Array.isArray(f.properties.routeIds) ? (f.properties.routeIds as string[]) : [],
        createdAt: 0,
        nearbyStations: [],
      });
    } else if (layer === 'routes' && f.geometry.type === 'LineString') {
      routePolys.set(String(f.properties.id), {
        id: String(f.properties.id),
        bullet: String(f.properties.bullet ?? f.properties.id),
        color: String(f.properties.color ?? '#888888'),
        coords: f.geometry.coordinates as Coord[],
      });
    }
  }

  const stationById = new Map(stations.map((s) => [s.id, s]));
  const maxSnap = 0.002;

  for (const route of routePolys.values()) {
    if (route.coords.length < 2) continue;
    const onRoute = stations
      .filter((s) => s.routeIds.includes(route.id))
      .map((s) => {
        const { arclen, snapD } = projectOnPolyline(route.coords, s.coords as Coord);
        return { station: s, arclen, snapD };
      })
      .filter((x) => x.snapD <= maxSnap)
      .sort((a, b) => a.arclen - b.arclen);

    const ordered: typeof onRoute = [];
    for (const item of onRoute) {
      const last = ordered[ordered.length - 1];
      if (last && last.station.id === item.station.id) continue;
      if (last && Math.abs(last.arclen - item.arclen) < 1e-6) continue;
      ordered.push(item);
    }

    const stNodes = ordered.map(({ station }) => ({
      id: station.stNodeIds[0],
      center: station.coords,
      trackIds: [] as string[],
      buildType: 'constructed' as const,
    }));

    const stCombos = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      const from = ordered[i].station;
      const to = ordered[i + 1].station;
      const seg = simplifyPolyline(slicePolyline(route.coords, ordered[i].arclen, ordered[i + 1].arclen));
      const trackId = `t-${route.id}-${from.id}-${to.id}`;
      tracks.push({
        id: trackId,
        coords: seg as Coordinate[],
        buildType: 'constructed',
        displayType: 'normal',
        type: 'mainline',
        reversable: true,
        interactable: true,
        length: 0,
        startElevation: 0,
        endElevation: 0,
        trackType: 'mainline',
        waterIntersectionPercentage: 0,
        createdAt: 0,
      });
      from.trackIds.push(trackId);
      stCombos.push({
        startStNodeId: from.stNodeIds[0],
        endStNodeId: to.stNodeIds[0],
        path: [{ trackId, reversed: false, length: 0, signals: [] }],
        distance: 0,
      });
    }

    routes.push({
      id: route.id,
      bullet: route.bullet,
      color: route.color,
      stNodes,
      stCombos,
    });
  }

  return { stations, routes, tracks };
}

function svgStats(svg: string) {
  return {
    kb: (svg.length / 1024).toFixed(0),
    paths: (svg.match(/<path/g) ?? []).length,
    circles: (svg.match(/<circle/g) ?? []).length,
    lines: (svg.match(/<line/g) ?? []).length,
    viewBox: svg.match(/viewBox="([^"]+)"/)?.[1] ?? '?',
  };
}

function toPng(svgPath: string, pngPath: string, whiteBg = false) {
  if (!existsSync(svgPath)) {
    console.error('Missing', svgPath);
    return false;
  }
  let svg = readFileSync(svgPath, 'utf-8');
  if (whiteBg) {
    const vb = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 1000 1000';
    svg = svg.replace(/<svg([^>]*)>/, `<svg$1><rect width="100%" height="100%" fill="#ffffff"/>`);
    if (!svg.includes('viewBox')) svg = svg.replace('<svg', `<svg viewBox="${vb}"`);
  }
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: whiteBg ? 'white' : undefined }).render().asPng();
  writeFileSync(pngPath, png);
  console.log(`  ${svgPath} → ${pngPath}`);
  return true;
}

function pipelineMetrics(stations: Station[], routes: Route[], tracks: Track[], width = 2700, height = 2700) {
  const groups = getOrBuildStationGroups(stations, undefined);
  console.log('  buildTransitGraph…');
  const graph = buildTransitGraph(stations, routes, groups, tracks);
  const bounds = (() => {
    const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
    for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
    const b = computeBounds(framePts);
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, 0.06);
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;
  const LINE_WIDTH = 4;
  const dHat = Math.max(8, LINE_WIDTH * 4);
  const topoParams: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
    preserveStations: false,
  };
  console.log('  buildSupportGraph…');
  const support = buildSupportGraph(graph, groups, topoParams);
  const medLen = medianEdgeLength(support);
  const octiOpts = { ...DEFAULT_OCTI_OPTIONS };
  if (support.nodes.size > 350) {
    octiOpts.cellSize = Math.max(18, medLen / 1.5);
    octiOpts.cellDivisor = 2;
  }
  console.log('  octi… (cellSize', octiOpts.cellSize?.toFixed(1) ?? 'auto', ')');
  const image = octi(support, octiOpts);
  const mergeRatio = 1 - support.edges.size / graph.edges.length;
  let disc = 0;
  for (const [, steps] of support.lineTraversals) {
    for (let i = 1; i < steps.length; i++) {
      const e0 = support.edges.get(steps[i - 1].edgeId)!;
      const e1 = support.edges.get(steps[i].edgeId)!;
      const end0 = steps[i - 1].reversed ? e0.from : e0.to;
      const start1 = steps[i].reversed ? e1.to : e1.from;
      if (end0 !== start1) disc++;
    }
  }
  return {
    inputNodes: graph.nodes.size,
    inputEdges: graph.edges.length,
    supportNodes: support.nodes.size,
    supportEdges: support.edges.size,
    edgeReductionPct: (mergeRatio * 100).toFixed(1),
    discontinuities: disc,
    cellSize: image.cellSize.toFixed(1),
    medianEdge: medianEdgeLength(support).toFixed(1),
  };
}

// --- main ---
console.log('Loading…');
const raw = JSON.parse(readFileSync(metroPath, 'utf-8'));
const water: WaterCollection = JSON.parse(readFileSync(waterPath, 'utf-8'));
console.log('Converting to game state…');
const { stations, routes, tracks } = metroGeoJsonToGame(raw);

console.log('Input:', metroPath);
console.log(`  ${routes.length} routes, ${stations.length} stations, ${tracks.length} track segments`);

console.log('Rendering SVG…');
// SEA_W/SEA_H/SEA_OUT: render at a different canvas size (e.g. the in-game
// panel's 840x880) without touching the default comparison outputs.
const W = Number(process.env.SEA_W ?? 2700);
const H = Number(process.env.SEA_H ?? 2700);
const outSmooth = process.env.SEA_OUT ?? OUT_SMOOTH;
const svg = generateSchematicSVG({
  routes,
  tracks,
  stations,
  water,
  options: {
    mode: 'smoothed',
    width: W,
    height: H,
    showStations: true,
    showLabels: false,
    useTopoMerge: true,
  },
});
writeFileSync(outSmooth, svg);

console.log('\nOur pipeline (smoothed + topo):');
console.log(' ', OUT_SMOOTH, svgStats(svg));

console.log('\nPipeline metrics…');
const metrics = pipelineMetrics(stations, routes, tracks);
for (const [k, v] of Object.entries(metrics)) console.log(`  ${k}: ${v}`);

if (existsSync(OUT_LOOM)) {
  const loomSvg = readFileSync(OUT_LOOM, 'utf-8');
  console.log('\nReference LOOM:');
  console.log(' ', OUT_LOOM, svgStats(loomSvg));
} else {
  console.warn('\nMissing', OUT_LOOM, '— run LOOM Docker pipeline first');
}

console.log('\nRasterizing…');
toPng(OUT_SMOOTH, PNG_OURS);
toPng(OUT_LOOM, PNG_LOOM, true);
console.log('\nCompare PNGs:', PNG_OURS, 'vs', PNG_LOOM);
