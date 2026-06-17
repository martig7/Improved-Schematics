// Throwaway probe: detect balloon-loop hairpins in (1) the raw per-line input
// polylines fed into topo and (2) the merged support-graph line traversals,
// on both the SEA geojson save and the NYC migration-backup save.
//
// Run: npx tsx dev/_probe-hairpin.ts
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel, TransitGraph, SupportGraph, TraversalStep } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';
import type { Route, Track, Station } from '../src/types/game-state';

type Coord = [number, number];

const PROX = 25;        // self-proximity trigger distance (px)
const ARC_FACTOR = 4;   // arc gap must exceed ARC_FACTOR * proximity distance
const ARC_FLOOR = 80;   // and an absolute floor so corners don't trigger
const SAMPLE = 5;       // resample step (px)

// ---------- generic geometry ----------
function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

interface Sample { p: Pixel; a: number } // point + cumulative arclen

function samplePolyline(pts: Pixel[], step: number): Sample[] {
  const out: Sample[] = [];
  if (pts.length === 0) return out;
  out.push({ p: pts[0].slice() as Pixel, a: 0 });
  let acc = 0;
  let carry = 0; // distance since last emitted sample
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
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
  const last = pts[pts.length - 1];
  if (out.length === 0 || dist(out[out.length - 1].p, last) > 1e-6) {
    out.push({ p: last.slice() as Pixel, a: acc });
  }
  return out;
}

function pointAtArc(samples: Sample[], a: number): Pixel {
  if (samples.length === 0) return [0, 0];
  if (a <= samples[0].a) return samples[0].p;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].a >= a) {
      const s0 = samples[i - 1];
      const s1 = samples[i];
      const f = s1.a === s0.a ? 0 : (a - s0.a) / (s1.a - s0.a);
      return [s0.p[0] + (s1.p[0] - s0.p[0]) * f, s0.p[1] + (s1.p[1] - s0.p[1]) * f];
    }
  }
  return samples[samples.length - 1].p;
}

interface LoopHit {
  aStart: number;     // arclen of the earlier point (loop entry)
  aEnd: number;       // arclen of the later point (loop exit)
  loopLen: number;    // aEnd - aStart of the OUTERMOST triggering pair
  minD: number;       // min triggering distance (legs' closest approach incl. junction)
  apex: Pixel;        // point at mid-arclen of the loop
  legSep: number;     // min antiparallel-leg distance measured symmetric around apex
}

/** Self-proximity balloon-loop detector over one polyline. Returns deduped
 *  loop clusters (overlapping [i,j] intervals merged). */
function detectLoops(pts: Pixel[]): LoopHit[] {
  const samples = samplePolyline(pts, SAMPLE);
  if (samples.length < 4) return [];
  // spatial hash of earlier samples, cell = PROX
  const cell = PROX;
  const grid = new Map<string, number[]>();
  const key = (p: Pixel) => Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell);
  interface Raw { i: number; j: number; d: number }
  const raws: Raw[] = [];
  for (let j = 0; j < samples.length; j++) {
    const sj = samples[j];
    const cx = Math.floor(sj.p[0] / cell);
    const cy = Math.floor(sj.p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cx + dx + ',' + (cy + dy));
        if (!bucket) continue;
        for (const i of bucket) {
          const si = samples[i];
          const d = dist(si.p, sj.p);
          const gap = sj.a - si.a;
          if (d <= PROX && gap > Math.max(ARC_FACTOR * Math.max(d, 1), ARC_FLOOR)) {
            raws.push({ i, j, d });
          }
        }
      }
    }
    const k = key(sj.p);
    let b = grid.get(k);
    if (!b) { b = []; grid.set(k, b); }
    b.push(j);
  }
  if (raws.length === 0) return [];
  // cluster raws whose [i,j] intervals overlap
  raws.sort((x, y) => x.i - y.i);
  const clusters: Raw[][] = [];
  let cur: Raw[] = [];
  let curMaxJ = -1;
  for (const r of raws) {
    if (cur.length === 0 || r.i <= curMaxJ) {
      cur.push(r);
      curMaxJ = Math.max(curMaxJ, r.j);
    } else {
      clusters.push(cur);
      cur = [r];
      curMaxJ = r.j;
    }
  }
  if (cur.length > 0) clusters.push(cur);

  const hits: LoopHit[] = [];
  for (const cl of clusters) {
    // outermost pair = max arc gap
    let outer = cl[0];
    let minD = Infinity;
    for (const r of cl) {
      if (samples[r.j].a - samples[r.i].a > samples[outer.j].a - samples[outer.i].a) outer = r;
      if (r.d < minD) minD = r.d;
    }
    const aStart = samples[outer.i].a;
    const aEnd = samples[outer.j].a;
    const loopLen = aEnd - aStart;
    const aApex = (aStart + aEnd) / 2;
    const apex = pointAtArc(samples, aApex);
    // antiparallel leg separation: symmetric pairs around the apex, skipping
    // the apex cap itself (k < 20px) where legs trivially converge
    let legSep = Infinity;
    for (let k = 20; k <= loopLen / 2 - 10; k += SAMPLE) {
      const d = dist(pointAtArc(samples, aApex - k), pointAtArc(samples, aApex + k));
      if (d < legSep) legSep = d;
    }
    if (!Number.isFinite(legSep)) legSep = minD;
    hits.push({ aStart, aEnd, loopLen, minD, apex, legSep });
  }
  return hits;
}

// ---------- SEA loading (copied from dev/render-sea-compare.ts) ----------
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
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
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
  const d2 = (a: Coord, b: Coord) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const at = (target: number): Coord => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = d2(pts[i - 1], pts[i]);
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
      } as never);
    } else if (layer === 'routes' && f.geometry.type === 'LineString') {
      routePolys.set(String(f.properties.id), {
        id: String(f.properties.id),
        bullet: String(f.properties.bullet ?? f.properties.id),
        color: String(f.properties.color ?? '#888888'),
        coords: f.geometry.coordinates as Coord[],
      });
    }
  }

  for (const route of routePolys.values()) {
    if (route.coords.length < 2) continue;
    const onRoute = stations
      .filter((s) => (s as never as { routeIds: string[] }).routeIds.includes(route.id))
      .map((s) => {
        const { arclen, snapD } = projectOnPolyline(route.coords, s.coords as Coord);
        return { station: s, arclen, snapD };
      })
      .filter((x) => x.snapD <= 0.002)
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
      } as never);
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
    } as never);
  }

  return { stations, routes, tracks };
}

// ---------- pipeline replication (renderSmoothed up to buildSupportGraph) ----------
interface Prepared {
  graph: TransitGraph;
  support: SupportGraph;
  dHat: number;
  colors: Map<string, { color: string; label: string }>;
  width: number;
  height: number;
}

function prepare(stations: Station[], routes: Route[], tracks: Track[], width: number, height: number, apiGroups?: unknown): Prepared {
  const groups = getOrBuildStationGroups(stations, apiGroups as never);
  const graph = buildTransitGraph(stations, routes, groups, tracks);

  const bounds = (() => {
    const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
    for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
    const b = computeBounds(framePts);
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const baseProj = createProjection(bounds, width, height, 0.06); // DEFAULT_OPTIONS.padding
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
  const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: width, maxY: height }, { alpha: 0.6 });
  const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

  const dHat = Math.max(8, 4 /* theme.lineWidth */ * 4);
  const topoParams: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
    preserveStations: false,
  };
  const support = buildSupportGraph(graph, groups, topoParams);

  const colors = new Map<string, { color: string; label: string }>();
  for (const e of graph.edges) for (const l of e.lines) if (!colors.has(l.id)) colors.set(l.id, { color: l.color, label: l.label });

  return { graph, support, dHat, colors, width, height };
}

// ---------- INPUT scope ----------
// renderSmoothed does NOT pass projectGeo, so inputFromGraph feeds straight
// node-to-node chords. The per-line input geometry is therefore exactly the
// ordered node-position polyline along each g.lineTraversals entry.
interface InputFinding {
  lineId: string;
  color: string;
  label: string;
  apex: Pixel;
  loopLen: number;
  legSep: number;
  minD: number;
  nodesOnLoop: number;
  terminal: boolean;
}

function inputScope(prep: Prepared): InputFinding[] {
  const { graph, colors } = prep;
  const out: InputFinding[] = [];
  for (const [lineId, steps] of graph.lineTraversals) {
    // split into contiguous runs at discontinuities
    const runs: { pts: Pixel[]; arcOfNode: number[] }[] = [];
    let pts: Pixel[] = [];
    let arcs: number[] = [];
    let acc = 0;
    let prevEnd: string | null = null;
    const flush = () => {
      if (pts.length >= 2) runs.push({ pts, arcOfNode: arcs });
      pts = []; arcs = []; acc = 0; prevEnd = null;
    };
    for (const step of steps) {
      const e = graph.edges.find((x) => x.id === step.edgeId);
      if (!e) continue;
      const fromId = step.reversed ? e.to : e.from;
      const toId = step.reversed ? e.from : e.to;
      if (prevEnd !== null && prevEnd !== fromId) flush();
      const pf = graph.nodes.get(fromId)?.pos;
      const pt = graph.nodes.get(toId)?.pos;
      if (!pf || !pt) { flush(); continue; }
      if (pts.length === 0) { pts.push(pf.slice() as Pixel); arcs.push(0); acc = 0; }
      acc += dist(pts[pts.length - 1], pt);
      pts.push(pt.slice() as Pixel);
      arcs.push(acc);
      prevEnd = toId;
    }
    flush();

    for (const run of runs) {
      const total = run.arcOfNode[run.arcOfNode.length - 1] ?? 0;
      for (const hit of detectLoops(run.pts)) {
        const nodesOnLoop = run.arcOfNode.filter((a) => a > hit.aStart + 1 && a < hit.aEnd - 1).length;
        const terminal = hit.aStart < 30 || hit.aEnd > total - 30;
        const c = colors.get(lineId);
        out.push({
          lineId,
          color: c?.color ?? '?',
          label: c?.label ?? lineId,
          apex: hit.apex,
          loopLen: hit.loopLen,
          legSep: hit.legSep,
          minD: hit.minD,
          nodesOnLoop,
          terminal,
        });
      }
    }
  }
  return out;
}

// ---------- SUPPORT scope ----------
interface SupportFinding {
  lineId: string;
  color: string;
  label: string;
  kind: 'node-revisit' | 'geometric';
  apex: Pixel;
  loopLen: number;
  legSep: number;
  diameter: number;
  stationsOnLoop: number;
  cycleLineIds: string[];
  terminal: boolean;
  cycleNodeIds: string[];
}

function supportScope(prep: Prepared): SupportFinding[] {
  const { support, colors } = prep;
  const out: SupportFinding[] = [];

  // station counts per node
  const stationsAtNode = new Map<string, number>();
  for (const s of support.stations.values()) {
    stationsAtNode.set(s.nodeId, (stationsAtNode.get(s.nodeId) ?? 0) + 1);
  }

  for (const [lineId, steps] of support.lineTraversals) {
    // node sequence + per-step oriented geometry, split at discontinuities
    interface Run { nodeSeq: string[]; stepGeoms: Pixel[][] }
    const runs: Run[] = [];
    let nodeSeq: string[] = [];
    let stepGeoms: Pixel[][] = [];
    let prevEnd: string | null = null;
    const flush = () => {
      if (nodeSeq.length >= 2) runs.push({ nodeSeq, stepGeoms });
      nodeSeq = []; stepGeoms = []; prevEnd = null;
    };
    for (const step of steps) {
      const e = support.edges.get(step.edgeId);
      if (!e) continue;
      const fromId = step.reversed ? e.to : e.from;
      const toId = step.reversed ? e.from : e.to;
      const geom = step.reversed ? [...e.points].reverse() : e.points;
      if (prevEnd !== null && prevEnd !== fromId) flush();
      if (nodeSeq.length === 0) nodeSeq.push(fromId);
      nodeSeq.push(toId);
      stepGeoms.push(geom.map((p) => p.slice() as Pixel));
      prevEnd = toId;
    }
    flush();

    const c = colors.get(lineId);

    for (const run of runs) {
      const { nodeSeq: seq, stepGeoms: geoms } = run;
      const nodePos = (id: string) => support.nodes.get(id)!.pos;

      // (a) node revisited within <= 10 steps
      const reported = new Set<string>();
      for (let j = 2; j < seq.length; j++) {
        for (let i = Math.max(0, j - 10); i <= j - 2; i++) {
          if (seq[i] !== seq[j]) continue;
          const cycleNodes = seq.slice(i, j + 1);
          const uniq = [...new Set(cycleNodes)];
          let diameter = 0;
          for (let x = 0; x < uniq.length; x++)
            for (let y = x + 1; y < uniq.length; y++)
              diameter = Math.max(diameter, dist(nodePos(uniq[x]), nodePos(uniq[y])));
          if (diameter >= 200) continue;
          const dedupKey = uniq.sort().join(',');
          if (reported.has(dedupKey)) continue;
          reported.add(dedupKey);
          // drawn polyline of the cycle
          const poly: Pixel[] = [];
          for (let s = i; s < j; s++) {
            const g = geoms[s];
            for (const p of g) {
              if (poly.length === 0 || dist(poly[poly.length - 1], p) > 1e-6) poly.push(p);
            }
          }
          const samples = samplePolyline(poly, SAMPLE);
          const total = samples[samples.length - 1]?.a ?? 0;
          const aApex = total / 2;
          let legSep = Infinity;
          for (let k = 20; k <= total / 2 - 10; k += SAMPLE) {
            const d = dist(pointAtArc(samples, aApex - k), pointAtArc(samples, aApex + k));
            if (d < legSep) legSep = d;
          }
          if (!Number.isFinite(legSep)) legSep = 0;
          const cycleLineIds = new Set<string>();
          for (let s = i; s < j; s++) {
            // find the edge id for this step again
            // (geoms parallel to steps within run; recover via seq pair)
          }
          // union of lineIds on the cycle's edges
          const cycEdges = new Set<string>();
          for (const eid of support.adj.get(seq[i]) ?? []) cycEdges.add(eid);
          const lineUnion = new Set<string>();
          for (const nid of uniq) {
            for (const eid of support.adj.get(nid) ?? []) {
              const e = support.edges.get(eid);
              if (!e) continue;
              const otherEnd = e.from === nid ? e.to : e.from;
              if (uniq.includes(otherEnd)) for (const l of e.lineIds) lineUnion.add(l);
            }
          }
          let stationsOnLoop = 0;
          for (const nid of uniq) stationsOnLoop += stationsAtNode.get(nid) ?? 0;
          const terminal = i <= 1 || j >= seq.length - 2;
          let cx = 0, cy = 0;
          for (const nid of uniq) { cx += nodePos(nid)[0]; cy += nodePos(nid)[1]; }
          out.push({
            lineId,
            color: c?.color ?? '?',
            label: c?.label ?? lineId,
            kind: 'node-revisit',
            apex: [cx / uniq.length, cy / uniq.length],
            loopLen: total,
            legSep,
            diameter,
            stationsOnLoop,
            cycleLineIds: [...lineUnion],
            terminal,
            cycleNodeIds: uniq,
          });
        }
      }

      // (b) geometric self-proximity over the drawn traversal polyline
      // (catches a U whose two legs are distinct corridors that never share a node)
      const poly: Pixel[] = [];
      const nodeArcs: { id: string; a: number }[] = [];
      let acc = 0;
      for (let s = 0; s < geoms.length; s++) {
        const g = geoms[s];
        if (poly.length === 0) { poly.push(g[0]); nodeArcs.push({ id: seq[0], a: 0 }); }
        for (let pI = 1; pI < g.length; pI++) {
          const prev = poly[poly.length - 1];
          const p = g[pI];
          const d = dist(prev, p);
          if (d <= 1e-6) continue;
          acc += d;
          poly.push(p);
        }
        nodeArcs.push({ id: seq[s + 1], a: acc });
      }
      for (const hit of detectLoops(poly)) {
        const onLoop = nodeArcs.filter((na) => na.a > hit.aStart + 1 && na.a < hit.aEnd - 1);
        let stationsOnLoop = 0;
        const loopNodeIds: string[] = [];
        for (const na of onLoop) {
          stationsOnLoop += stationsAtNode.get(na.id) ?? 0;
          loopNodeIds.push(na.id);
        }
        const lineUnion = new Set<string>();
        for (const nid of loopNodeIds) {
          for (const eid of support.adj.get(nid) ?? []) {
            const e = support.edges.get(eid);
            if (e) for (const l of e.lineIds) lineUnion.add(l);
          }
        }
        const totalArc = nodeArcs[nodeArcs.length - 1]?.a ?? 0;
        const terminal = hit.aStart < 30 || hit.aEnd > totalArc - 30;
        // diameter of the loop geometry
        const loopSamples = samplePolyline(poly, SAMPLE).filter((s2) => s2.a >= hit.aStart && s2.a <= hit.aEnd);
        let diameter = 0;
        for (let x = 0; x < loopSamples.length; x += 4)
          for (let y = x + 4; y < loopSamples.length; y += 4)
            diameter = Math.max(diameter, dist(loopSamples[x].p, loopSamples[y].p));
        out.push({
          lineId,
          color: c?.color ?? '?',
          label: c?.label ?? lineId,
          kind: 'geometric',
          apex: hit.apex,
          loopLen: hit.loopLen,
          legSep: hit.legSep,
          diameter,
          stationsOnLoop,
          cycleLineIds: [...lineUnion],
          terminal,
          cycleNodeIds: [...new Set(loopNodeIds)],
        });
      }
    }
  }
  return out;
}

// ---------- dedup across lines by apex proximity ----------
function fmt(n: number): string { return n.toFixed(1); }

function report(save: string, prep: Prepared) {
  console.log(`\n=== ${save} ===`);
  console.log(`graph: ${prep.graph.nodes.size} nodes, ${prep.graph.edges.length} edges, ${prep.graph.lineTraversals.size} lines`);
  console.log(`support: ${prep.support.nodes.size} nodes, ${prep.support.edges.size} edges, ${prep.support.lineTraversals.size} traversals`);
  console.log(`dHat (merge dCut) = ${prep.dHat}px, step = ${Math.max(2, prep.dHat / 4)}px`);

  const inputF = inputScope(prep);
  console.log(`\n-- INPUT scope: ${inputF.length} loop hits --`);
  for (const f of inputF) {
    console.log(
      `[input] line=${f.lineId} (${f.label}, ${f.color}) apex=(${fmt(f.apex[0])},${fmt(f.apex[1])}) ` +
      `loopLen=${fmt(f.loopLen)} legSep=${fmt(f.legSep)} minD=${fmt(f.minD)} nodesOnLoop=${f.nodesOnLoop} terminal=${f.terminal}`,
    );
  }

  const supF = supportScope(prep);
  console.log(`\n-- SUPPORT scope: ${supF.length} loop hits --`);
  for (const f of supF) {
    console.log(
      `[support/${f.kind}] line=${f.lineId} (${f.label}, ${f.color}) apex=(${fmt(f.apex[0])},${fmt(f.apex[1])}) ` +
      `loopLen=${fmt(f.loopLen)} legSep=${fmt(f.legSep)} diam=${fmt(f.diameter)} stationsOnLoop=${f.stationsOnLoop} ` +
      `terminal=${f.terminal} cycleLines=[${f.cycleLineIds.join(',')}] nodes=[${f.cycleNodeIds.join(',')}]`,
    );
  }
  return { inputF, supF };
}

// ---------- main ----------
const ROOT = 'C:/Users/darkd/Downloads/Improved Schematics/';

// Dump mode: probe the live-game input dump (exact panel inputs incl. the
// game's real stationGroups) instead of the geojson/NYC reconstructions.
//   npx tsx dev/_probe-hairpin.ts improvedschematics-input.json
const dumpArg = process.argv[2];
if (dumpArg) {
  const dump = JSON.parse(readFileSync(dumpArg, 'utf-8'));
  console.log(
    `dump: at=${dump.at} routes=${dump.routes.length} tracks=${dump.tracks.length} ` +
    `stations=${dump.stations.length} stationGroups=${dump.stationGroups?.length ?? 'none'}`,
  );
  const prep = prepare(dump.stations, dump.routes, dump.tracks, 2700, 2700, dump.stationGroups);
  report('LIVE DUMP (2700x2700, real stationGroups)', prep);
  process.exit(0);
}

console.log('Loading SEA…');
const seaRaw = JSON.parse(readFileSync(ROOT + 'SEA-metro.geojson', 'utf-8'));
const sea = metroGeoJsonToGame(seaRaw);
console.log(`SEA: ${sea.routes.length} routes, ${sea.stations.length} stations, ${sea.tracks.length} tracks`);
const seaPrep = prepare(sea.stations, sea.routes, sea.tracks, 2700, 2700);
const seaRes = report('SEA (2700x2700, smoothed-pipeline projection+warp)', seaPrep);

// NW window check
console.log('\n-- SEA NW window x[850,1450] y[650,1250] --');
const inWin = (p: Pixel) => p[0] >= 850 && p[0] <= 1450 && p[1] >= 650 && p[1] <= 1250;
for (const f of seaRes.inputF) if (inWin(f.apex)) console.log(`  [input] ${f.lineId} ${f.color} apex=(${fmt(f.apex[0])},${fmt(f.apex[1])})`);
for (const f of seaRes.supF) if (inWin(f.apex)) console.log(`  [support/${f.kind}] ${f.lineId} ${f.color} apex=(${fmt(f.apex[0])},${fmt(f.apex[1])}) legSep=${fmt(f.legSep)}`);

console.log('\nLoading NYC…');
const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const nycSave = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8'));
const nyc = nycSave.data ?? nycSave;
console.log(`NYC: ${(nyc.routes ?? []).length} routes, ${(nyc.stations ?? []).length} stations, ${(nyc.tracks ?? []).length} tracks`);
const nycPrep = prepare(nyc.stations ?? [], (nyc.routes ?? []) as Route[], (nyc.tracks ?? []) as Track[], 2000, 2000);
report('NYC (2000x2000, smoothed-pipeline projection+warp)', nycPrep);

console.log('\nDone.');
