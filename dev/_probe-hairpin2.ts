// Throwaway probe #2: characterize the SEA NW red+yellow hairpin in detail.
// - support edges in the box with line colors
// - stations anchored on the loop nodes
// - traversal passes through the box per line
// - RAW geojson LineString self-proximity with leg-separation profile vs dHat
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';
import type { Route, Track, Station } from '../src/types/game-state';

type Coord = [number, number];
const ROOT = 'C:/Users/darkd/Downloads/Improved Schematics/';
const BOX = { x0: 850, x1: 1120, y0: 680, y1: 980 };

function dist(a: Pixel, b: Pixel): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
const inBox = (p: Pixel) => p[0] >= BOX.x0 && p[0] <= BOX.x1 && p[1] >= BOX.y0 && p[1] <= BOX.y1;

// --- SEA loader (same as probe 1, trimmed) ---
function projectOnPolyline(pts: Coord[], p: Coord): { arclen: number; snapD: number } {
  let bestD = Infinity, bestArc = 0, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
    const q: Coord = [a[0] + t * vx, a[1] + t * vy];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) { bestD = d; bestArc = acc + Math.hypot(q[0] - a[0], q[1] - a[1]); }
    acc += Math.hypot(vx, vy);
  }
  return { arclen: bestArc, snapD: bestD };
}
function slicePolyline(pts: Coord[], a0: number, a1: number): Coord[] {
  if (a0 > a1) [a0, a1] = [a1, a0];
  const d2 = (a: Coord, b: Coord) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const at = (target: number): Coord => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = d2(pts[i - 1], pts[i]);
      if (acc + seg >= target - 1e-12) {
        const t = seg === 0 ? 0 : (target - acc) / seg;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      }
      acc += seg;
    }
    return pts[pts.length - 1];
  };
  const start = at(a0), end = at(a1);
  const out: Coord[] = [start];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = d2(pts[i - 1], pts[i]);
    if (acc + seg > a0 + 1e-9 && acc < a1 - 1e-9) {
      if (d2(out[out.length - 1], pts[i - 1]) > 1e-9) out.push(pts[i - 1]);
      if (d2(out[out.length - 1], pts[i]) > 1e-9 && d2(pts[i], end) > 1e-9) out.push(pts[i]);
    }
    acc += seg;
  }
  if (d2(out[out.length - 1], end) > 1e-9) out.push(end);
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

const raw = JSON.parse(readFileSync(ROOT + 'SEA-metro.geojson', 'utf-8'));
const stations: Station[] = [];
const routes: Route[] = [];
const tracks: Track[] = [];
const routePolys = new Map<string, { id: string; bullet: string; color: string; coords: Coord[] }>();
for (const f of raw.features) {
  const layer = f.properties.layer as string | undefined;
  if (layer === 'stations' && f.geometry.type === 'Point') {
    const id = String(f.properties.id);
    stations.push({
      id, name: String(f.properties.name ?? id), coords: f.geometry.coordinates as Coordinate,
      trackIds: [], trackGroupId: id, buildType: 'constructed', stNodeIds: ['sn-' + id],
      routeIds: Array.isArray(f.properties.routeIds) ? (f.properties.routeIds as string[]) : [],
      createdAt: 0, nearbyStations: [],
    } as never);
  } else if (layer === 'routes' && f.geometry.type === 'LineString') {
    routePolys.set(String(f.properties.id), {
      id: String(f.properties.id), bullet: String(f.properties.bullet ?? f.properties.id),
      color: String(f.properties.color ?? '#888888'), coords: f.geometry.coordinates as Coord[],
    });
  }
}
for (const route of routePolys.values()) {
  if (route.coords.length < 2) continue;
  const onRoute = stations
    .filter((s) => (s as never as { routeIds: string[] }).routeIds.includes(route.id))
    .map((s) => { const { arclen, snapD } = projectOnPolyline(route.coords, s.coords as Coord); return { station: s, arclen, snapD }; })
    .filter((x) => x.snapD <= 0.002)
    .sort((a, b) => a.arclen - b.arclen);
  const ordered: typeof onRoute = [];
  for (const item of onRoute) {
    const last = ordered[ordered.length - 1];
    if (last && last.station.id === item.station.id) continue;
    if (last && Math.abs(last.arclen - item.arclen) < 1e-6) continue;
    ordered.push(item);
  }
  const stNodes = ordered.map(({ station }) => ({ id: station.stNodeIds[0], center: station.coords, trackIds: [] as string[], buildType: 'constructed' as const }));
  const stCombos = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i].station, to = ordered[i + 1].station;
    const seg = simplifyPolyline(slicePolyline(route.coords, ordered[i].arclen, ordered[i + 1].arclen));
    const trackId = `t-${route.id}-${from.id}-${to.id}`;
    tracks.push({
      id: trackId, coords: seg as Coordinate[], buildType: 'constructed', displayType: 'normal', type: 'mainline',
      reversable: true, interactable: true, length: 0, startElevation: 0, endElevation: 0, trackType: 'mainline',
      waterIntersectionPercentage: 0, createdAt: 0,
    } as never);
    from.trackIds.push(trackId);
    stCombos.push({ startStNodeId: from.stNodeIds[0], endStNodeId: to.stNodeIds[0], path: [{ trackId, reversed: false, length: 0, signals: [] }], distance: 0 });
  }
  routes.push({ id: route.id, bullet: route.bullet, color: route.color, stNodes, stCombos } as never);
}

// --- pipeline (same as renderSmoothed) ---
const groups = getOrBuildStationGroups(stations, undefined);
const graph = buildTransitGraph(stations, routes, groups, tracks);
const bounds = (() => {
  const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
  for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
  const b = computeBounds(framePts);
  return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
})();
const baseProj = createProjection(bounds, 2700, 2700, 0.06);
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
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: 2700, maxY: 2700 }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;
const dHat = 16;
const topoParams: TopoParams = { dHat, step: 4, convergenceEpsilon: 0.002, maxRounds: 8, stationCandidateRadius: 32, preserveStations: false };
const support = buildSupportGraph(graph, groups, topoParams);

const lineInfo = new Map<string, { label: string; color: string }>();
for (const e of graph.edges) for (const l of e.lines) if (!lineInfo.has(l.id)) lineInfo.set(l.id, { label: l.label, color: l.color });
const fmtLine = (id: string) => { const i = lineInfo.get(id); return i ? `${i.label}(${i.color})` : id; };
const f1 = (n: number) => n.toFixed(1);

// 1) support edges in box
console.log('--- support edges intersecting box', JSON.stringify(BOX), '---');
for (const e of support.edges.values()) {
  if (!e.points.some(inBox)) continue;
  const a = support.nodes.get(e.from)!.pos, b = support.nodes.get(e.to)!.pos;
  console.log(`${e.id} ${e.from}(${f1(a[0])},${f1(a[1])}) -> ${e.to}(${f1(b[0])},${f1(b[1])}) lines=[${[...e.lineIds].map(fmtLine).join(' ')}] pts=${e.points.length}`);
}

// 2) stations anchored in box
console.log('\n--- support stations in box ---');
for (const s of support.stations.values()) {
  const n = support.nodes.get(s.nodeId);
  if (n && inBox(n.pos)) console.log(`station "${s.label}" group=${s.id} node=${s.nodeId} pos=(${f1(n.pos[0])},${f1(n.pos[1])})`);
}

// 3) traversal passes through box per line
console.log('\n--- traversal node sequences through box ---');
for (const [lineId, steps] of support.lineTraversals) {
  const seq: { id: string; pos: Pixel }[] = [];
  let prevEnd: string | null = null;
  for (const st of steps) {
    const e = support.edges.get(st.edgeId);
    if (!e) continue;
    const fromId = st.reversed ? e.to : e.from;
    const toId = st.reversed ? e.from : e.to;
    if (seq.length === 0 || prevEnd !== fromId) seq.push({ id: fromId, pos: support.nodes.get(fromId)!.pos });
    seq.push({ id: toId, pos: support.nodes.get(toId)!.pos });
    prevEnd = toId;
  }
  // contiguous runs inside box
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) console.log(`${fmtLine(lineId)}: ${run.join(' ')}`);
    run = [];
  };
  for (const s of seq) {
    if (inBox(s.pos)) run.push(`${s.id}(${f1(s.pos[0])},${f1(s.pos[1])})`);
    else flush();
  }
  flush();
}

// 4) RAW geojson LineStrings: self-proximity in box + leg separation profile
console.log('\n--- RAW route LineStrings (projected through same warp) ---');
function sampleArc(pts: Pixel[], step: number): { p: Pixel; a: number }[] {
  const out: { p: Pixel; a: number }[] = [{ p: pts[0], a: 0 }];
  let acc = 0, carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = dist(a, b);
    if (seg === 0) continue;
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], a: acc + t });
      t += step;
    }
    carry = seg - (t - step);
    acc += seg;
  }
  out.push({ p: pts[pts.length - 1], a: acc });
  return out;
}
function pAt(samples: { p: Pixel; a: number }[], a: number): Pixel {
  if (a <= 0) return samples[0].p;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].a >= a) {
      const s0 = samples[i - 1], s1 = samples[i];
      const f = s1.a === s0.a ? 0 : (a - s0.a) / (s1.a - s0.a);
      return [s0.p[0] + (s1.p[0] - s0.p[0]) * f, s0.p[1] + (s1.p[1] - s0.p[1]) * f];
    }
  }
  return samples[samples.length - 1].p;
}
for (const route of routePolys.values()) {
  const px = route.coords.map((c) => proj.toSVG(c as Coordinate) as Pixel);
  const samples = sampleArc(px, 5);
  // find self-proximity pairs with apex in box
  let best: { i: number; j: number; gap: number } | null = null;
  for (let j = 0; j < samples.length; j++) {
    for (let i = 0; i < j; i++) {
      const d = dist(samples[i].p, samples[j].p);
      const gap = samples[j].a - samples[i].a;
      if (d <= 25 && gap > Math.max(4 * Math.max(d, 1), 80)) {
        const apex = pAt(samples, (samples[i].a + samples[j].a) / 2);
        if (inBox(apex)) {
          if (!best || gap > best.gap) best = { i, j, gap };
        }
      }
    }
  }
  if (!best) continue;
  const aApex = (samples[best.i].a + samples[best.j].a) / 2;
  const apex = pAt(samples, aApex);
  console.log(`\nroute ${route.bullet} (${route.color}) id=${route.id}`);
  console.log(`  raw LineString pts=${route.coords.length}, loop arc=${f1(best.gap)}px, apex=(${f1(apex[0])},${f1(apex[1])})`);
  console.log('  leg separation profile (arc k from apex -> dist between legs):');
  const prof: string[] = [];
  for (let k = 10; k <= Math.min(best.gap / 2, 500); k += 20) {
    const d = dist(pAt(samples, aApex - k), pAt(samples, aApex + k));
    prof.push(`k=${k}:${f1(d)}`);
  }
  console.log('   ', prof.join('  '));
  console.log(`  dHat=${dHat} -> legs wider than dHat where profile > 16`);
}

// 5) which stations sit on the L hairpin loop nodes (apex capsule)
console.log('\n--- graph (input) nodes in box, with positions ---');
for (const n of graph.nodes.values()) {
  if (inBox(n.pos)) {
    const lines = new Set<string>();
    for (const eid of graph.adj.get(n.id) ?? []) {
      const e = graph.edges.find((x) => x.id === eid);
      if (e) for (const l of e.lines) lines.add(l.label);
    }
    console.log(`gnode ${n.id} "${n.label}" (${f1(n.pos[0])},${f1(n.pos[1])}) lines=[${[...lines].join(',')}]`);
  }
}
