// LOOM topo: build the support graph H by merging geographically-parallel
// transit edges into single corridor edges carrying the union of their line
// ids, then re-insert stations at the best-scoring support nodes.
// Reference: Brosi & Bast 2024, "Network Topology Extraction".

import type { Coordinate } from '../../types/core';
import type {
  Pixel,
  TransitGraph,
  GraphEdge,
  StationGroup,
  SupportGraph,
  SupportNode,
  SupportEdge,
  SupportStation,
  LineRef,
  TraversalStep,
} from './types';

/** sin(pi/4): the paper's line-creep angle factor. */
export const ALPHA = Math.SQRT1_2; // 0.70710678…

export function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(pts: Pixel[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/** Resample a polyline into equispaced points ~`step` apart. Always returns
 *  the exact first/last endpoints; returns just the endpoints when the line is
 *  shorter than one step. */
export function densify(pts: Pixel[], step: number): Pixel[] {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const total = polylineLength(pts);
  if (total <= step) return [pts[0].slice() as Pixel, pts[pts.length - 1].slice() as Pixel];
  const n = Math.max(1, Math.round(total / step));
  const seg = total / n;
  const out: Pixel[] = [pts[0].slice() as Pixel];
  let acc = 0;          // distance consumed along the source polyline
  let target = seg;     // next sample distance
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    while (target <= acc + segLen + 1e-9 && out.length < n) {
      const t = segLen === 0 ? 0 : (target - acc) / segLen;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      target += seg;
    }
    acc += segLen;
  }
  out.push(pts[pts.length - 1].slice() as Pixel);
  return out;
}

/** Walk `pts` from index 0 and return the point at arclength `d` from the
 *  start (clamped to the polyline end). */
export function pointAtDistance(pts: Pixel[], d: number): Pixel {
  if (pts.length === 0) return [0, 0];
  if (d <= 0) return pts[0].slice() as Pixel;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const segLen = dist(pts[i - 1], pts[i]);
    if (acc + segLen >= d) {
      const t = segLen === 0 ? 0 : (d - acc) / segLen;
      return [
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ];
    }
    acc += segLen;
  }
  return pts.at(-1)!.slice() as Pixel;
}

/** Paper's line-creep mitigation. With p1/pl the first/last samples of the
 *  edge being densified, reject candidate node `v` when it sits too far from
 *  the current sample relative to that sample's distance to either endpoint —
 *  this prevents two edges meeting at an obtuse angle from interlacing. */
export function creepBlocked(vPos: Pixel, pk: Pixel, samples: Pixel[]): boolean {
  const p1 = samples[0];
  const pl = samples[samples.length - 1];
  const dv = dist(pk, vPos);
  return ALPHA * dist(pk, p1) <= dv || ALPHA * dist(pk, pl) <= dv;
}

/** Uniform grid hash keyed by cell = floor(coord / cellSize). Queries scan the
 *  3×3 neighbourhood of the query cell, which is sufficient when cellSize >= the
 *  query radius. */
export class NodeIndex {
  private cell: number;
  private buckets = new Map<string, Set<string>>();
  private pos = new Map<string, Pixel>();

  constructor(cellSize: number) {
    this.cell = Math.max(1e-6, cellSize);
  }

  private key(p: Pixel): string {
    return Math.floor(p[0] / this.cell) + ',' + Math.floor(p[1] / this.cell);
  }

  insert(id: string, p: Pixel): void {
    this.pos.set(id, p);
    const k = this.key(p);
    let b = this.buckets.get(k);
    if (!b) {
      b = new Set();
      this.buckets.set(k, b);
    }
    b.add(id);
  }

  move(id: string, from: Pixel, to: Pixel): void {
    const k = this.key(from);
    this.buckets.get(k)?.delete(id);
    this.insert(id, to);
  }

  remove(id: string): void {
    const p = this.pos.get(id);
    if (!p) return;
    this.buckets.get(this.key(p))?.delete(id);
    this.pos.delete(id);
  }

  nearest(p: Pixel, radius: number, exclude?: ReadonlySet<string>): string | null {
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    let best: string | null = null;
    let bestD = radius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = this.buckets.get(cx + dx + ',' + (cy + dy));
        if (!b) continue;
        for (const id of b) {
          if (exclude?.has(id)) continue;
          const q = this.pos.get(id)!;
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d <= bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }
}

interface HEdge {
  id: string;
  a: string;
  b: string;
  points: Pixel[];          // a.pos … b.pos
  lineIds: Set<string>;
}

const setsEqual = (x: Set<string>, y: Set<string>): boolean => {
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
};

/** Mutable working support graph used during the merge rounds. */
export class HBuilder {
  private nodes = new Map<string, Pixel>();
  private edges = new Map<string, HEdge>();
  private adj = new Map<string, Set<string>>(); // nodeId -> edgeIds
  private index: NodeIndex;
  private nId = 0;
  private eId = 0;
  private protected_ = new Set<string>();

  constructor(indexCell: number) {
    this.index = new NodeIndex(indexCell);
  }

  addNode(p: Pixel): string {
    const id = 'h' + this.nId++;
    const pos = p.slice() as Pixel;
    this.nodes.set(id, pos);
    this.adj.set(id, new Set());
    this.index.insert(id, pos);
    return id;
  }

  markProtected(id: string): void {
    this.protected_.add(id);
  }

  nodePos(id: string): Pixel {
    return this.nodes.get(id)!;
  }

  nearestNode(p: Pixel, radius: number, exclude?: ReadonlySet<string>): string | null {
    return this.index.nearest(p, radius, exclude);
  }

  /** Move a node toward `sample`, averaging 50/50 (paper's running average).
   *  Protected nodes stay anchored. */
  snap(id: string, sample: Pixel): void {
    if (this.protected_.has(id)) return;
    const cur = this.nodes.get(id)!;
    const next: Pixel = [(cur[0] + sample[0]) / 2, (cur[1] + sample[1]) / 2];
    this.index.move(id, cur, next);
    this.nodes.set(id, next);
  }

  private edgeKey(a: string, b: string): string {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  addOrUnionEdge(a: string, b: string, lines: Set<string>, via?: Pixel): void {
    if (a === b) return;
    for (const eid of this.adj.get(a)!) {
      const e = this.edges.get(eid)!;
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) {
        for (const l of lines) e.lineIds.add(l);
        if (via) this.appendVia(e, via);
        return;
      }
    }
    const pa = this.nodes.get(a)!;
    const pb = this.nodes.get(b)!;
    const points: Pixel[] =
      via && dist(pa, via) > 1e-6 && dist(via, pb) > 1e-6
        ? [pa.slice() as Pixel, via.slice() as Pixel, pb.slice() as Pixel]
        : [pa.slice() as Pixel, pb.slice() as Pixel];
    const id = 'he' + this.eId++;
    const e: HEdge = { id, a, b, points, lineIds: new Set(lines) };
    this.edges.set(id, e);
    this.adj.get(a)!.add(id);
    this.adj.get(b)!.add(id);
  }

  /** Append an interior sample to an edge polyline (for corridor geometry). */
  private appendVia(e: HEdge, via: Pixel): void {
    const end = e.points[e.points.length - 1];
    if (dist(end, via) < 1e-6) return;
    e.points.splice(e.points.length - 1, 0, via.slice() as Pixel);
  }

  edgeList(): HEdge[] {
    return [...this.edges.values()];
  }

  totalLength(): number {
    let total = 0;
    for (const e of this.edges.values()) total += polylineLength(e.points);
    return total;
  }

  /** Collapse every degree-2 node whose two edges carry identical line sets,
   *  joining their polylines through the node. */
  contractDegree2WithMatchingLines(): void {
    const trace =
      typeof process !== 'undefined'
        ? (process as { env?: Record<string, string> }).env?.OCTI_TRACE_LINE
        : undefined;
    let changed = true;
    while (changed) {
      changed = false;
      for (const [nid, eids] of this.adj) {
        if (this.protected_.has(nid)) continue;
        if (eids.size !== 2) continue;
        const [e1, e2] = [...eids].map((id) => this.edges.get(id)!);
        if (trace && (!e1 || !e2)) {
          console.error(`[topo] contract: STALE adj at ${nid}: ${[...eids]} -> ${!!e1},${!!e2}`);
          continue;
        }
        if (!setsEqual(e1.lineIds, e2.lineIds)) continue;
        const other1 = e1.a === nid ? e1.b : e1.a;
        const other2 = e2.a === nid ? e2.b : e2.a;
        if (other1 === other2) continue; // would create a self-loop
        // Build the joined polyline other1 … nid … other2.
        const p1 = e1.a === nid ? [...e1.points].reverse() : e1.points;
        const p2 = e2.a === nid ? e2.points : [...e2.points].reverse();
        const joined = [...p1, ...p2.slice(1)];
        // Remove the two edges and the node.
        this.detach(e1);
        this.detach(e2);
        this.nodes.delete(nid);
        this.adj.delete(nid);
        const id = 'he' + this.eId++;
        const merged: HEdge = {
          id,
          a: other1,
          b: other2,
          points: joined,
          lineIds: new Set(e1.lineIds),
        };
        this.edges.set(id, merged);
        this.adj.get(other1)!.add(id);
        this.adj.get(other2)!.add(id);
        changed = true;
        break; // restart iteration; adj mutated
      }
    }
  }

  private detach(e: HEdge): void {
    this.edges.delete(e.id);
    this.adj.get(e.a)?.delete(e.id);
    this.adj.get(e.b)?.delete(e.id);
  }

  /** LOOM removeEdgeArtifacts: contract edges shorter than `maxLen` even when
   *  an endpoint is a junction fork, folding any parallel edges the rewiring
   *  creates (line-set union, like LOOM's foldEdges). The merge can strand a
   *  micro-mesh of near-coincident nodes around a multi-line junction — each
   *  within dHat of the others, but never collapsed because degree-2
   *  contraction is blocked at forks. Octi then inflates every micro-node to
   *  its own grid cell, turning a 5px mesh into full-cell phantom loops.
   *
   *  Must run AFTER contractDegree2WithMatchingLines has joined the 4px sample
   *  chains into long corridor edges, otherwise it would eat real corridors. */
  contractShortEdges(maxLen: number): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of this.edges.values()) {
        if (polylineLength(e.points) >= maxLen) continue;
        // Terminal stubs survive: stations don't exist at builder stage, so a
        // contracted dead-end deletes a real terminus (the line then ends one
        // station early and anchorGraphStops has no corridor to split).
        if (this.adj.get(e.a)!.size === 1 || this.adj.get(e.b)!.size === 1) continue;
        const aProt = this.protected_.has(e.a);
        const bProt = this.protected_.has(e.b);
        if (aProt && bProt) continue;
        // Keep the protected endpoint, else the busier one (junction stays put).
        let keep = e.a;
        let drop = e.b;
        if (bProt || (!aProt && this.adj.get(e.b)!.size > this.adj.get(e.a)!.size)) {
          keep = e.b;
          drop = e.a;
        }
        this.detach(e);
        const keepPos = this.nodes.get(keep)!;
        for (const fid of [...this.adj.get(drop)!]) {
          const f = this.edges.get(fid)!;
          const other = f.a === drop ? f.b : f.a;
          if (other === keep) {
            this.detach(f); // would become a self-loop
            continue;
          }
          let existing: HEdge | null = null;
          for (const gid of this.adj.get(keep)!) {
            const cand = this.edges.get(gid)!;
            if (cand.a === other || cand.b === other) {
              existing = cand;
              break;
            }
          }
          if (existing) {
            for (const l of f.lineIds) existing.lineIds.add(l);
            this.detach(f);
            continue;
          }
          if (f.a === drop) {
            f.a = keep;
            f.points[0] = keepPos.slice() as Pixel;
          } else {
            f.b = keep;
            f.points[f.points.length - 1] = keepPos.slice() as Pixel;
          }
          this.adj.get(drop)!.delete(fid);
          this.adj.get(keep)!.add(fid);
        }
        this.index.remove(drop);
        this.nodes.delete(drop);
        this.adj.delete(drop);
        changed = true;
        break; // restart iteration; maps mutated
      }
    }
  }

  /** Excise balloon folds baked into edge polylines (see cutPolylineFolds). */
  sanitizeEdgeGeometry(eps: number): void {
    for (const e of this.edges.values()) {
      if (e.points.length < 4) continue;
      e.points = cutPolylineFolds(e.points, eps);
    }
  }

  /** Crop each adjacent edge at distance `dHat` from every node, move the node
   *  to the average of the cropped endpoints, then re-anchor the edge polylines
   *  at the moved node. */
  intersectionSmoothing(dHat: number): void {
    const newPos = new Map<string, Pixel>();
    for (const [nid, eids] of this.adj) {
      if (eids.size === 0) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const eid of eids) {
        const e = this.edges.get(eid)!;
        // Orient the polyline so it starts at this node.
        const pts = e.a === nid ? e.points : [...e.points].reverse();
        const cropped = pointAtDistance(pts, dHat);
        sx += cropped[0];
        sy += cropped[1];
        n++;
      }
      newPos.set(nid, [sx / n, sy / n]);
    }
    for (const [nid, p] of newPos) {
      const old = this.nodes.get(nid)!;
      this.index.move(nid, old, p);
      this.nodes.set(nid, p);
    }
    // Re-anchor edge endpoints to the moved node positions.
    for (const e of this.edges.values()) {
      e.points[0] = this.nodes.get(e.a)!;
      e.points[e.points.length - 1] = this.nodes.get(e.b)!;
    }
  }

  /** Snapshot the current nodes/edges/adjacency (used between rounds and for
   *  intersection smoothing). */
  snapshot(): { nodes: Map<string, Pixel>; edges: HEdge[]; adj: Map<string, Set<string>> } {
    return {
      nodes: new Map([...this.nodes].map(([k, v]) => [k, v.slice() as Pixel])),
      edges: this.edgeList().map((e) => ({ ...e, points: e.points.map((p) => p.slice() as Pixel), lineIds: new Set(e.lineIds) })),
      adj: new Map([...this.adj].map(([k, v]) => [k, new Set(v)])),
    };
  }
}

export interface TopoParams {
  dHat: number;                  // merge distance threshold (px)
  step: number;                  // densification step (px)
  convergenceEpsilon: number;    // edge-length-gap stop (0.002 = 0.2%)
  maxRounds: number;             // hard cap on the outer loop
  stationCandidateRadius: number;// station-insertion search radius (px)
  /** When true, anchor junction/terminus nodes during merge and re-insert
   *  pass-through stop positions afterward. Pass-through stops on a single line
   *  may contract; see anchorGraphStops. */
  preserveStations?: boolean;
  /** When set, corridor `GraphEdge.geo` polylines are projected and used for
   *  merge-round input instead of straight station-to-station chords. */
  projectGeo?: (c: Coordinate) => Pixel;
}

interface MergeInputEdge {
  fromId: string;
  toId: string;
  a: Pixel;
  b: Pixel;
  points: Pixel[];
  lineIds: Set<string>;
}

interface MergeInput {
  edges: MergeInputEdge[];
}

/**
 * Excise balloon folds from a polyline: spans where the path comes back
 * within `eps` of an earlier point after a substantial arc (a lasso loop or
 * an out-and-back retrace baked into one edge's geometry). Degree-2
 * contraction welds chains straight through 180-degree turnaround nodes, so a
 * terminal balloon loop ends up INSIDE a single edge polyline — its length
 * then vastly exceeds its endpoint span, and octi's spring cost manufactures
 * a phantom grid detour ("candy cane") to honor the extra length. LOOM never
 * meets this because its merge re-walks all geometry each iteration, zipping
 * intra-edge folds; our merge rounds re-feed endpoint chords only.
 *
 * Endpoints are always preserved. Genuine V-corners survive: the cut needs
 * the legs to stay within eps after `minArc` of travel, not merely touch.
 */
export function cutPolylineFolds(pts: Pixel[], eps: number, minArcOverride?: number): Pixel[] {
  if (pts.length < 4) return pts;
  const minArc = minArcOverride ?? Math.max(4 * eps, 24);
  let out = pts;
  for (let pass = 0; pass < 8; pass++) {
    const arcs: number[] = [0];
    for (let i = 1; i < out.length; i++) arcs.push(arcs[i - 1] + dist(out[i - 1], out[i]));
    let cutFrom = -1;
    let cutTo = -1;
    outer: for (let j = 3; j < out.length; j++) {
      for (let i = 0; i < j - 2; i++) {
        if (arcs[j] - arcs[i] <= minArc) break; // arc gap only shrinks as i→j
        if (dist(out[i], out[j]) < eps) {
          cutFrom = i;
          cutTo = j;
          break outer;
        }
      }
    }
    if (cutFrom < 0) return out;
    // Remove the loop interior; entry point stands in for the whole fold.
    out = [...out.slice(0, cutFrom + 1), ...out.slice(cutTo + (cutTo === out.length - 1 ? 0 : 1))];
    if (out.length < 4) return out;
  }
  return out;
}

/** Douglas–Peucker simplification (LOOM pre-densify step). */
function simplifyRdp(pts: Pixel[], eps: number): Pixel[] {
  if (pts.length <= 2) return pts.map((p) => p.slice() as Pixel);
  const rdp = (slice: Pixel[]): Pixel[] => {
    if (slice.length <= 2) return slice.map((p) => p.slice() as Pixel);
    const a = slice[0];
    const b = slice[slice.length - 1];
    let maxD = 0;
    let idx = 0;
    for (let i = 1; i < slice.length - 1; i++) {
      const p = slice[i];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const c2 = vx * vx + vy * vy;
      const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
      const q: Pixel = [a[0] + t * vx, a[1] + t * vy];
      const d = dist(p, q);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps) {
      const left = rdp(slice.slice(0, idx + 1));
      const right = rdp(slice.slice(idx));
      return [...left.slice(0, -1), ...right];
    }
    return [a.slice() as Pixel, b.slice() as Pixel];
  };
  return rdp(pts);
}

/** LOOM-style corridor prep: simplify then equispaced samples. */
function prepCorridorPolyline(pts: Pixel[], step: number, simplifyEps: number): Pixel[] {
  if (pts.length < 2) return pts.map((p) => p.slice() as Pixel);
  const simplified = simplifyRdp(pts, simplifyEps);
  return densify(simplified, step);
}

function simplifyForTopo(pts: Pixel[], maxPts = 32): Pixel[] {
  if (pts.length <= maxPts) return pts.map((p) => p.slice() as Pixel);
  const out: Pixel[] = [pts[0]];
  const st = (pts.length - 1) / (maxPts - 1);
  for (let i = 1; i < maxPts - 1; i++) out.push(pts[Math.round(i * st)]);
  out.push(pts[pts.length - 1]);
  return out;
}

export function inputFromGraph(g: TransitGraph, projectGeo?: (c: Coordinate) => Pixel): MergeInput {
  const edges = g.edges.map((e: GraphEdge) => {
    const a = g.nodes.get(e.from)!.pos;
    const b = g.nodes.get(e.to)!.pos;
    let points: Pixel[];
    if (e.geo && e.geo.length >= 2 && projectGeo) {
      points = simplifyForTopo(e.geo.map((c) => projectGeo(c).slice() as Pixel), 32);
      points[0] = a.slice() as Pixel;
      points[points.length - 1] = b.slice() as Pixel;
    } else {
      points = [a.slice() as Pixel, b.slice() as Pixel];
    }
    return {
      fromId: e.from,
      toId: e.to,
      a,
      b,
      points,
      lineIds: new Set(e.lines.map((l) => l.id)),
    };
  });
  return { edges };
}

/** Re-feed merged corridors into another collapse round. Feed RDP-simplified
 *  REAL geometry, not endpoint chords: two bowed corridors between the same
 *  junction pair otherwise become near-identical straight chords and weld
 *  regardless of dHat (the blue/pink center conjoining). RDP at eps keeps the
 *  vertex count low enough that re-walking does not re-densify or fragment
 *  the graph (measured: 237 -> 231 corridor edges on the live Seattle dump). */
export function inputFromBuilder(h: HBuilder, eps: number): MergeInput {
  return {
    edges: h.edgeList().map((e) => {
      const a = h.nodePos(e.a);
      const b = h.nodePos(e.b);
      const points = simplifyRdp(e.points, eps);
      points[0] = a.slice() as Pixel;
      points[points.length - 1] = b.slice() as Pixel;
      return {
        fromId: e.a,
        toId: e.b,
        a,
        b,
        points,
        lineIds: e.lineIds,
      };
    }),
  };
}

/** True when the candidate sits beside (not along) the local travel direction. */
function lateralToTravel(prev: Pixel | null, pk: Pixel, next: Pixel | null, vPos: Pixel): boolean {
  const ax = next ? next[0] - pk[0] : 0;
  const ay = next ? next[1] - pk[1] : 0;
  const bx = prev ? pk[0] - prev[0] : 0;
  const by = prev ? pk[1] - prev[1] : 0;
  let tx = ax + bx;
  let ty = ay + by;
  const tl = Math.hypot(tx, ty);
  if (tl < 1e-9) return true;
  tx /= tl;
  ty /= tl;
  const ox = vPos[0] - pk[0];
  const oy = vPos[1] - pk[1];
  const along = Math.abs(ox * tx + oy * ty);
  const perp = Math.abs(ox * ty - oy * tx);
  return perp > along;
}

/** LOOM MapConstructor::ndCollapseCand — nearest node within dCut, or create. */
function ndCollapseCand(
  h: HBuilder,
  myNds: Set<string>,
  pk: Pixel,
  dCut: number,
  samples: Pixel[],
  sampleIndex: number,
): string {
  const prev = sampleIndex > 0 ? samples[sampleIndex - 1] : null;
  const next = sampleIndex + 1 < samples.length ? samples[sampleIndex + 1] : null;
  const near = h.nearestNode(pk, dCut, myNds);
  if (near !== null) {
    const pos = h.nodePos(near);
    const coincident = dist(pos, pk) < 1e-6;
    if (coincident || (!creepBlocked(pos, pk, samples) && lateralToTravel(prev, pk, next, pos))) {
      h.snap(near, pk);
      return near;
    }
  }
  return h.addNode(pk);
}

/** LOOM collapseShrdSegs core: longest edges first, walk densified geometry,
 *  snap/create shared support nodes so parallel corridors collapse together. */
export function collapseSharedSegments(
  input: MergeInput,
  params: TopoParams,
  protectedPositions?: Pixel[],
): HBuilder {
  const { dHat, step } = params;
  const simplifyEps = Math.max(0.5, dHat * 0.05);
  const h = new HBuilder(dHat);
  if (protectedPositions) {
    for (const p of protectedPositions) {
      const id = h.addNode(p);
      h.markProtected(id);
    }
  }

  const sorted = [...input.edges].sort(
    (x, y) => polylineLength(y.points) - polylineLength(x.points),
  );

  const trace2 =
    typeof process !== 'undefined'
      ? (process as { env?: Record<string, string> }).env?.OCTI_TRACE_LINE
      : undefined;

  const imgNds = new Map<string, string>();

  for (const e of sorted) {
    const samples = prepCorridorPolyline(e.points, step, simplifyEps);
    let last: string | null = null;
    let front: string | null = null;
    const myNds = new Set<string>();
    let imgFromCovered = false;
    let imgToCovered = false;
    let unions = 0;
    let broke = false;

    for (let i = 0; i < samples.length; i++) {
      const pk = samples[i];
      const cur = ndCollapseCand(h, myNds, pk, dHat, samples, i);
      myNds.add(cur);

      if (i === 0 && !imgNds.has(e.fromId)) {
        imgNds.set(e.fromId, cur);
        imgFromCovered = true;
      }
      if (i === samples.length - 1 && !imgNds.has(e.toId)) {
        imgNds.set(e.toId, cur);
        imgToCovered = true;
      }

      if (last === cur) continue;

      if (cur === imgNds.get(e.fromId)) imgFromCovered = true;
      const mappedTo = imgNds.get(e.toId);
      if (mappedTo && cur === mappedTo) {
        if (last) { h.addOrUnionEdge(last, cur, e.lineIds, pk); unions++; }
        imgToCovered = true;
        broke = true;
        break;
      }

      if (last) { h.addOrUnionEdge(last, cur, e.lineIds, pk); unions++; }
      if (!front) front = cur;
      last = cur;
    }

    if (trace2 && e.lineIds.has(trace2)) {
      console.error(
        `[walk] edge ${e.fromId.slice(0, 6)}->${e.toId.slice(0, 6)} ` +
        `len=${polylineLength(e.points).toFixed(0)} samples=${samples.length} ` +
        `unions=${unions} earlyBreak=${broke}`,
      );
    }

    const fromNd = imgNds.get(e.fromId);
    const toNd = imgNds.get(e.toId);
    if (fromNd && front && !imgFromCovered && fromNd !== front) {
      h.addOrUnionEdge(fromNd, front, e.lineIds);
    }
    if (last && toNd && !imgToCovered && last !== toNd) {
      h.addOrUnionEdge(last, toNd, e.lineIds);
    }
  }

  const trace =
    typeof process !== 'undefined'
      ? (process as { env?: Record<string, string> }).env?.OCTI_TRACE_LINE
      : undefined;
  if (trace) {
    const n = h.edgeList().filter((e) => e.lineIds.has(trace)).length;
    console.error(`[topo] pre-contract: trace line on ${n}/${h.edgeList().length} edges`);
  }
  h.contractDegree2WithMatchingLines();
  if (trace) {
    const n = h.edgeList().filter((e) => e.lineIds.has(trace)).length;
    console.error(`[topo] post-contract: trace line on ${n}/${h.edgeList().length} edges`);
  }
  return h;
}

/** @deprecated Use collapseSharedSegments; kept as alias for tests. */
function onePass(input: MergeInput, params: TopoParams, protectedPositions?: Pixel[]): HBuilder {
  return collapseSharedSegments(input, params, protectedPositions);
}

export function runMergeRounds(g: TransitGraph, params: TopoParams): HBuilder {
  let h: HBuilder | null = null;
  let prevLen = Infinity;
  let prevEdges = Infinity;
  // Junction/terminus anchors are protected UNCONDITIONALLY (was gated on
  // preserveStations, which the smoothed path never sets): rounds >= 2 re-feed
  // averaged geometry, so node drift COMPOUNDS dHat per round — round-1
  // averaging crept two genuinely ~24px-apart legs within dHat of each other
  // and round 2 zipped them into a phantom shared trunk, demoting a real
  // degree-4 junction and manufacturing a fake one a corridor away.
  const protectedPositions = [...g.nodes.values()]
    .filter((n) => isMergeAnchor(g, n.id))
    .map((n) => n.pos.slice() as Pixel);
  for (let round = 1; round <= params.maxRounds; round++) {
    const input = h === null ? inputFromGraph(g, params.projectGeo) : inputFromBuilder(h, params.dHat);
    const next = collapseSharedSegments(input, params, protectedPositions);
    const len = next.totalLength();
    const edgeCount = next.edgeList().length;
    if (h !== null && prevEdges !== Infinity && edgeCount >= prevEdges) {
      break;
    }
    h = next;
    if (prevLen !== Infinity && Math.abs(1 - len / prevLen) < params.convergenceEpsilon) {
      break;
    }
    prevLen = len;
    prevEdges = edgeCount;
  }
  return h!;
}

/** Project a station group's [lng,lat] centre into the same pixel space the
 *  graph nodes use. We reuse the graph's own node positions: the projection is
 *  already baked into GraphNode.pos, so we re-derive each group's pixel from the
 *  matching graph node when present, else fall back to a scaled lng/lat. */
function groupPixel(group: StationGroup, g: TransitGraph): Pixel {
  const n = g.nodes.get(group.id);
  if (n) return n.pos;
  return [group.center[0] * 1e5, group.center[1] * 1e5];
}

function freezeBuilder(h: HBuilder, g: TransitGraph): {
  nodes: Map<string, SupportNode>;
  edges: Map<string, SupportEdge>;
  adj: Map<string, string[]>;
  index: NodeIndex;
} {
  const snap = h.snapshot();
  const nodes = new Map<string, SupportNode>();
  const index = new NodeIndex(50);
  for (const [id, pos] of snap.nodes) {
    nodes.set(id, { id, pos });
    index.insert(id, pos);
  }
  const edges = new Map<string, SupportEdge>();
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of snap.edges) {
    edges.set(e.id, { id: e.id, from: e.a, to: e.b, points: e.points, lineIds: e.lineIds });
    adj.get(e.a)!.push(e.id);
    adj.get(e.b)!.push(e.id);
  }
  return { nodes, edges, adj, index };
}

/** BFS through support edges whose lineIds include `lineId`, from `src` to
 *  `dst`. Returns the ordered support-edge steps, or null if unreachable. */
function bfsLinePath(
  src: string,
  dst: string,
  lineId: string,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
): TraversalStep[] | null {
  if (src === dst) return [];
  const prev = new Map<string, { node: string; edgeId: string }>();
  const seen = new Set<string>([src]);
  const queue = [src];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const eid of adj.get(cur) ?? []) {
      const e = edges.get(eid);
      if (!e || !e.lineIds.has(lineId)) continue;
      const nxt = e.from === cur ? e.to : e.from;
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, { node: cur, edgeId: eid });
      if (nxt === dst) {
        const steps: TraversalStep[] = [];
        let at = dst;
        while (at !== src) {
          const back = prev.get(at)!;
          const e = edges.get(back.edgeId)!;
          steps.push({ edgeId: back.edgeId, reversed: e.from !== back.node });
          at = back.node;
        }
        steps.reverse();
        return steps;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/** Single-hop step when BFS is unnecessary. */
function directStep(
  src: string,
  dst: string,
  lineId: string,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
): TraversalStep | null {
  for (const eid of adj.get(src) ?? []) {
    const e = edges.get(eid);
    if (!e || !e.lineIds.has(lineId)) continue;
    const nxt = e.from === src ? e.to : e.from;
    if (nxt === dst) return { edgeId: eid, reversed: e.from !== src };
  }
  return null;
}

/** Shortest path over ALL support edges (Dijkstra by polyline length), with a
 *  total-length cap. Used as the self-healing fallback when a line-constrained
 *  search fails because the merge under-painted the line's corridors. */
function shortestAnyPath(
  src: string,
  dst: string,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
  maxLen: number,
): TraversalStep[] | null {
  if (src === dst) return [];
  const distTo = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, { node: string; edgeId: string }>();
  const done = new Set<string>();
  for (;;) {
    let cur: string | null = null;
    let curD = Infinity;
    for (const [n, d] of distTo) {
      if (!done.has(n) && d < curD) { cur = n; curD = d; }
    }
    if (cur === null || curD > maxLen) return null;
    if (cur === dst) break;
    done.add(cur);
    for (const eid of adj.get(cur) ?? []) {
      const e = edges.get(eid);
      if (!e) continue;
      const nxt = e.from === cur ? e.to : e.from;
      const nd = curD + polylineLength(e.points);
      if (nd < (distTo.get(nxt) ?? Infinity)) {
        distTo.set(nxt, nd);
        prev.set(nxt, { node: cur, edgeId: eid });
      }
    }
  }
  const steps: TraversalStep[] = [];
  let at = dst;
  while (at !== src) {
    const back = prev.get(at)!;
    const e = edges.get(back.edgeId)!;
    steps.push({ edgeId: back.edgeId, reversed: e.from !== back.node });
    at = back.node;
  }
  steps.reverse();
  return steps;
}

/** Brute-force nearest support node (NodeIndex only searches a 3×3 cell hood). */
function nearestSupportNode(
  p: Pixel,
  nodes: Map<string, SupportNode>,
  maxDist: number,
): string | null {
  let best: string | null = null;
  let bestD = maxDist;
  for (const [id, n] of nodes) {
    const d = dist(n.pos, p);
    if (d <= bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** True when an input-graph node must stay anchored during merge. */
function isMergeAnchor(g: TransitGraph, nodeId: string): boolean {
  const eids = g.adj.get(nodeId) ?? [];
  if (eids.length !== 2) return true;
  const es = eids.map((id) => g.edges.find((e) => e.id === id)!);
  const lineKey = (e: GraphEdge) => [...e.lines.map((l) => l.id)].sort().join(',');
  return lineKey(es[0]) !== lineKey(es[1]);
}

function projectOntoPolyline(pts: Pixel[], p: Pixel): Pixel {
  let bestD = Infinity;
  let bestPoint: Pixel = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
    const q: Pixel = [a[0] + t * vx, a[1] + t * vy];
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      bestPoint = q;
    }
  }
  return bestPoint;
}

/** Split support edges so contracted pass-through stops regain a node. */
function anchorGraphStops(
  g: TransitGraph,
  nodes: Map<string, SupportNode>,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
  snapRadius: number,
  nextNodeId: () => string,
  nextEdgeId: () => string,
): void {
  const hasNodeNear = (p: Pixel): boolean => {
    for (const n of nodes.values()) if (dist(n.pos, p) <= snapRadius) return true;
    return false;
  };

  const stopsToAnchor: Array<{ pos: Pixel; lineId: string }> = [];
  for (const ge of g.edges) {
    for (const [lineId, flags] of ge.stops) {
      if (flags.atFrom) {
        const gp = g.nodes.get(ge.from);
        if (gp) stopsToAnchor.push({ pos: gp.pos, lineId });
      }
      if (flags.atTo) {
        const gp = g.nodes.get(ge.to);
        if (gp) stopsToAnchor.push({ pos: gp.pos, lineId });
      }
    }
  }

  for (const { pos, lineId } of stopsToAnchor) {
    if (hasNodeNear(pos)) continue;

    let bestEid: string | null = null;
    let bestD = Infinity;
    let bestPoint: Pixel = pos;
    for (const [eid, e] of edges) {
      if (!e.lineIds.has(lineId)) continue;
      const point = projectOntoPolyline(e.points, pos);
      const d = dist(point, pos);
      if (d < bestD) {
        bestD = d;
        bestEid = eid;
        bestPoint = point;
      }
    }
    // Force-place: a far anchor is still better than a silently missing
    // station (the user-facing symptom is a line ending one stop early).
    if (!bestEid) continue; // no corridor carries this line at all
    if (
      bestD > snapRadius * 4 &&
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
    ) {
      console.error(`[topo] anchor FAR: stop for ${lineId.slice(0, 8)} at ${bestD.toFixed(0)}px`);
    }
    const e = edges.get(bestEid);
    if (!e) continue;
    if (dist(bestPoint, e.points[0]) < 1 || dist(bestPoint, e.points[e.points.length - 1]) < 1) continue;

    let splitAt = 0;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1];
      const b = e.points[i];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const c2 = vx * vx + vy * vy;
      const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((bestPoint[0] - a[0]) * vx + (bestPoint[1] - a[1]) * vy) / c2));
      const q: Pixel = [a[0] + t * vx, a[1] + t * vy];
      if (dist(q, bestPoint) < 1) {
        splitAt = i - 1;
        bestPoint = q;
        break;
      }
    }

    const nid = nextNodeId();
    nodes.set(nid, { id: nid, pos: bestPoint.slice() as Pixel });
    adj.set(nid, []);

    const leftPts = [...e.points.slice(0, splitAt + 1), bestPoint];
    const rightPts = [bestPoint, ...e.points.slice(splitAt + 1)];

    adj.get(e.from)!.splice(adj.get(e.from)!.indexOf(bestEid), 1);
    adj.get(e.to)!.splice(adj.get(e.to)!.indexOf(bestEid), 1);
    edges.delete(bestEid);

    const leftId = nextEdgeId();
    const rightId = nextEdgeId();
    edges.set(leftId, { id: leftId, from: e.from, to: nid, points: leftPts, lineIds: new Set(e.lineIds) });
    edges.set(rightId, { id: rightId, from: nid, to: e.to, points: rightPts, lineIds: new Set(e.lineIds) });
    adj.get(e.from)!.push(leftId);
    adj.get(nid)!.push(leftId);
    adj.get(nid)!.push(rightId);
    adj.get(e.to)!.push(rightId);
  }
}

/** Nearest point on a polyline with arc/segment info (the older
 *  projectOntoPolyline above returns only the point). */
function projectArcOnPolyline(
  pts: Pixel[],
  q: Pixel,
): { d: number; arc: number; segIdx: number; total: number } {
  let acc = 0;
  let best = { d: Infinity, arc: 0, segIdx: 0, total: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / c2));
    const d = Math.hypot(q[0] - (a[0] + vx * t), q[1] - (a[1] + vy * t));
    const seg = Math.sqrt(c2);
    if (d < best.d) best = { d, arc: acc + seg * t, segIdx: i - 1, total: 0 };
    acc += seg;
  }
  best.total = acc;
  return best;
}

/** Weld redundant retrace stubs onto their corridor. A terminus 10-15px
 *  behind the previous stop yields: corridor edge `f` passing exactly THROUGH
 *  the terminus position (no node there) plus a short stub edge `e` doubling
 *  back over `f`'s own geometry. Left alone, octi's planarize treats the
 *  coincident overlap as a CROSSING and inserts an intersection node — the
 *  fold becomes graph structure and draws as a phantom hub with spokes (the
 *  1 Pl / 12 Av terminus "branch" artifact). Fix the structure: split `f` at
 *  the stub's far node and fold the stub's lines into the now exactly-parallel
 *  half. The line then renders as an inline collapsed out-and-back and the
 *  stations sit in geographic order on one straight corridor. */
function weldRedundantStubs(
  nodes: Map<string, SupportNode>,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
  dHat: number,
  nextEdgeId: () => string,
): void {
  const eps = dHat / 2;
  const cp = (p: Pixel): Pixel => p.slice() as Pixel;
  const hugs = (pts: Pixel[], ref: Pixel[]): boolean =>
    pts.every((p) => projectArcOnPolyline(ref, p).d <= eps);
  const swapAdj = (nid: string, drop: string[], add: string[]) => {
    const arr = (adj.get(nid) ?? []).filter((x) => !drop.includes(x));
    arr.push(...add);
    adj.set(nid, arr);
  };

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const eid of [...edges.keys()].sort()) {
      const e = edges.get(eid);
      if (!e || polylineLength(e.points) >= dHat) continue;
      let welded = false;
      for (const A of [e.from, e.to]) {
        const B = e.from === A ? e.to : e.from;
        const aNode = nodes.get(A);
        if (!aNode) continue;
        for (const fid of [...(adj.get(B) ?? [])].sort()) {
          if (fid === eid) continue;
          const f = edges.get(fid);
          if (!f || f.from === A || f.to === A) continue;
          if (!hugs(e.points, f.points)) continue;
          const proj = projectArcOnPolyline(f.points, aNode.pos);
          if (proj.d > eps) continue;
          // A must project interior to f, else there is nothing to split
          if (proj.arc < 2 || proj.total - proj.arc < 2) continue;

          const head = f.points.slice(0, proj.segIdx + 1).map(cp);
          const tail = f.points.slice(proj.segIdx + 1).map(cp);
          head.push(cp(aNode.pos));
          tail.unshift(cp(aNode.pos));
          const id1 = nextEdgeId();
          const id2 = nextEdgeId();
          const f1: SupportEdge = { id: id1, from: f.from, to: A, points: head, lineIds: new Set(f.lineIds) };
          const f2: SupportEdge = { id: id2, from: A, to: f.to, points: tail, lineIds: new Set(f.lineIds) };
          const half = f.from === B ? f1 : f2; // the exactly-parallel A↔B half
          for (const l of e.lineIds) half.lineIds.add(l);

          edges.delete(fid);
          edges.delete(eid);
          edges.set(id1, f1);
          edges.set(id2, f2);
          swapAdj(f.from, [fid, eid], [id1]);
          swapAdj(f.to, [fid, eid], [id2]);
          swapAdj(A, [eid, fid], [id1, id2]);
          swapAdj(B, [eid], []);
          changed = true;
          welded = true;
          break;
        }
        if (welded) break;
      }
    }
    if (!changed) break;
  }
}

/** Absorb sub-dHat degree-1 stubs hanging off junctions (degree >= 3 with
 *  the stub). A station 10-15px from a junction it detours from draws as a
 *  boxy in-and-out knot: the lane bundle is WIDER than the stub is long, and
 *  every serving line hooks 90° in and out (Harvey Rd). The station re-maps
 *  to the junction node — within the agreed <= dHat fusion tolerance, and
 *  separateFusedStations re-splits if it ever lands on another station with
 *  true separation > dHat. Real termini keep their stubs: their neighbor is
 *  the degree-2 corridor through the previous station (320 Pl class), not a
 *  junction. */
function absorbJunctionStubs(
  nodes: Map<string, SupportNode>,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
  dHat: number,
): void {
  const DBG =
    typeof process !== 'undefined' &&
    !!(process as { env?: Record<string, string> }).env?.OCTI_DEBUG;
  for (const eid of [...edges.keys()].sort()) {
    const e = edges.get(eid);
    if (!e) continue;
    // Short stubs absorb outright. Additionally, near-zero-span stubs whose
    // polyline is a merge-noise zigzag (nodes 2px apart under a 20px fold —
    // Harvey Rd) absorb despite the inflated length: that footprint is what
    // octi blows up to a full drawn cell. Wider-span stubs with long
    // geometry are genuinely extended structures — absorbing them measurably
    // degraded NYC's interchange layout, so they keep their nodes.
    const span = dist(e.points[0], e.points[e.points.length - 1]);
    const len = polylineLength(e.points);
    if (len >= dHat && !(span < dHat / 2 && len < 2 * dHat)) continue;
    for (const [A, B] of [[e.from, e.to], [e.to, e.from]] as const) {
      if ((adj.get(A)?.length ?? 0) !== 1) continue;
      if ((adj.get(B)?.length ?? 0) < 3) continue;
      // Only absorb DETOUR stops: every line on the stub must continue
      // through the junction (arrive + depart on other edges at B). A line
      // that ends in the stub marks a real terminus — keep its node.
      let allContinue = true;
      for (const l of e.lineIds) {
        let cnt = 0;
        for (const fid of adj.get(B) ?? []) {
          if (fid === eid) continue;
          if (edges.get(fid)?.lineIds.has(l)) cnt++;
        }
        if (cnt < 2) {
          allContinue = false;
          break;
        }
      }
      if (!allContinue) continue;
      edges.delete(eid);
      adj.delete(A);
      nodes.delete(A);
      const arrB = adj.get(B)!;
      const i = arrB.indexOf(eid);
      if (i >= 0) arrB.splice(i, 1);
      if (DBG) console.error(`[topo] absorb ${eid} ${A} -> ${B} (span ${span.toFixed(1)})`);
      break;
    }
  }
}

export function buildSupportGraph(
  g: TransitGraph,
  groups: StationGroup[],
  params: TopoParams,
): SupportGraph {
  const builder = runMergeRounds(g, params);
  // Honest lengths before contraction: a balloon fold inflates polyline
  // length past the short-edge threshold and shields the edge from cleanup.
  builder.sanitizeEdgeGeometry(params.dHat);
  // Junction micro-mesh cleanup (LOOM removeEdgeArtifacts). Folding parallel
  // edges can re-open degree-2 chains, so re-contract afterwards.
  builder.contractShortEdges(params.dHat);
  builder.contractDegree2WithMatchingLines();
  // Degree-2 joins weld chains through 180-degree turnarounds, baking new
  // folds into the joined polylines — sanitize again so octi's spring cost
  // never sees phantom length (it pays it back as candy-cane grid detours).
  builder.sanitizeEdgeGeometry(params.dHat);
  if (!params.preserveStations) builder.intersectionSmoothing(params.dHat);
  const { nodes, edges, adj } = freezeBuilder(builder, g);

  let nodeSeq = nodes.size;
  let edgeSeq = edges.size;
  {
    // ALWAYS re-anchor stops: the merge contracts away mid-corridor nodes, so
    // without splitting the corridors back open at stop positions, every
    // intermediate station snaps to the nearest surviving node (usually an
    // interchange at the corridor END) — stations visually vanish and long
    // corridors render as misleading express-like straights.
    anchorGraphStops(
      g,
      nodes,
      edges,
      adj,
      Math.max(2, params.dHat / 2),
      () => 'ha' + nodeSeq++,
      () => 'he' + edgeSeq++,
    );
    for (const ids of adj.values()) ids.length = 0;
    for (const id of nodes.keys()) if (!adj.has(id)) adj.set(id, []);
    for (const e of edges.values()) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.has(e.to)) adj.set(e.to, []);
      adj.get(e.from)!.push(e.id);
      adj.get(e.to)!.push(e.id);
    }
    // Terminus retrace stubs duplicate corridor geometry the anchors just
    // split — weld them in before traversal reconstruction sees the fold.
    weldRedundantStubs(nodes, edges, adj, params.dHat, () => 'he' + edgeSeq++);
    // Sub-dHat stubs at junctions fold into the junction node entirely.
    absorbJunctionStubs(nodes, edges, adj, params.dHat);
  }

  const lineRefs = new Map<string, LineRef>();
  for (const e of g.edges) for (const l of e.lines) if (!lineRefs.has(l.id)) lineRefs.set(l.id, l);

  const mapRadius = params.dHat * 2;
  const mapToSupport = (nid: string): string | null => {
    const gp = g.nodes.get(nid);
    if (!gp) return null;
    for (const [id, n] of nodes) {
      if (dist(n.pos, gp.pos) < 1) return id;
    }
    return (
      nearestSupportNode(gp.pos, nodes, mapRadius) ??
      nearestSupportNode(gp.pos, nodes, Infinity)
    );
  };

  let healCounter = 0;

  const appendTraversalSteps = (steps: TraversalStep[], seg: TraversalStep[]): void => {
    for (const s of seg) {
      const last = steps[steps.length - 1];
      if (last && last.edgeId === s.edgeId && last.reversed === s.reversed) continue;
      steps.push(s);
    }
  };

  const pathForLineSegment = (
    fromS: string,
    toS: string,
    lineId: string,
  ): TraversalStep[] | null => {
    if (fromS === toS) return [];
    const path = bfsLinePath(fromS, toS, lineId, edges, adj);
    if (path) return path;
    const direct = directStep(fromS, toS, lineId, edges, adj);
    if (direct) return [direct];
    // Self-heal an under-painted merge: the walk can miss unioning a line
    // onto corridors its geometry rides (then the line-constrained BFS finds
    // nothing and the line would silently vanish from the map). Route over
    // ANY support edges instead — shortest by length, capped so a mis-mapped
    // node can't commit a wild detour — and paint the line onto the edges
    // used so offsets, stops, and later segments see it.
    const fa = nodes.get(fromS);
    const fb = nodes.get(toS);
    if (!fa || !fb) return null;
    const cap = dist(fa.pos, fb.pos) * 3 + params.dHat * 10;
    const any = shortestAnyPath(fromS, toS, edges, adj, cap);
    if (any) {
      for (const s of any) edges.get(s.edgeId)!.lineIds.add(lineId);
      return any;
    }
    // No path at all — the merge fragmented this part of the network into
    // disconnected pieces (its stitching is heuristic). The input graph
    // guarantees the line IS connected here, so restore the link with a
    // bridge edge carrying the line.
    const id = '__heal' + healCounter++;
    edges.set(id, {
      id,
      from: fromS,
      to: toS,
      points: [fa.pos.slice() as Pixel, fb.pos.slice() as Pixel],
      lineIds: new Set([lineId]),
    });
    adj.get(fromS)?.push(id);
    adj.get(toS)?.push(id);
    return [{ edgeId: id, reversed: false }];
  };

  // Line-aware node mapping: snap a graph node to the nearest support node
  // whose incident edges actually CARRY the line. Pure nearest-by-position
  // snapping (mapToSupport) can land on a parallel corridor a few pixels
  // away that the line never touches — then every line-constrained BFS
  // segment fails and the whole line silently vanishes from the map.
  const mapToSupportForLine = (nid: string, lineId: string): string | null => {
    const gp = g.nodes.get(nid);
    if (!gp) return null;
    let bestLine: string | null = null;
    let bestLineD = Infinity;
    for (const [id, n] of nodes) {
      const d = dist(n.pos, gp.pos);
      if (d >= bestLineD) continue;
      let carries = false;
      for (const eid of adj.get(id) ?? []) {
        if (edges.get(eid)?.lineIds.has(lineId)) { carries = true; break; }
      }
      if (carries) {
        bestLineD = d;
        bestLine = id;
      }
    }
    if (bestLine && bestLineD <= mapRadius * 3) return bestLine;
    return mapToSupport(nid);
  };

  const lineTraversals = new Map<string, TraversalStep[]>();
  for (const [lineId, origSteps] of g.lineTraversals) {
    const graphNodes: string[] = [];
    for (const step of origSteps) {
      const e = g.edges.find((x) => x.id === step.edgeId);
      if (!e) continue;
      const fromId = step.reversed ? e.to : e.from;
      const toId = step.reversed ? e.from : e.to;
      if (graphNodes.length === 0) graphNodes.push(fromId);
      graphNodes.push(toId);
    }

    const supportNodes: string[] = [];
    for (const gn of graphNodes) {
      const sn = mapToSupportForLine(gn, lineId);
      if (!sn) continue;
      if (supportNodes.length === 0 || supportNodes[supportNodes.length - 1] !== sn) {
        supportNodes.push(sn);
      }
    }

    const steps: TraversalStep[] = [];
    let curNode: string | null = supportNodes[0] ?? null;
    let stalled = false;
    for (let i = 0; curNode && i < supportNodes.length - 1; i++) {
      const target = supportNodes[i + 1];
      if (curNode === target) {
        stalled = false;
        continue;
      }
      const seg = pathForLineSegment(curNode, target, lineId);
      if (!seg) {
        // First failure: keep curNode so the next iteration can bridge OVER a
        // single mis-mapped node. Second consecutive failure: jump to the
        // target with a discontinuity (the renderer flushes runs across gaps)
        // instead of stalling forever and dropping the entire line.
        if (stalled) curNode = target;
        stalled = !stalled;
        continue;
      }
      stalled = false;
      appendTraversalSteps(steps, seg);
      curNode = target;
    }
    if (
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_TRACE_LINE === lineId
    ) {
      console.error(
        `[trav] line ${lineId.slice(0, 8)}: graphNodes=${graphNodes.length} ` +
        `supportNodes=[${supportNodes.map((s) => s.slice(0, 6)).join(',')}] steps=${steps.length}`,
      );
    }
    if (steps.length > 0) lineTraversals.set(lineId, steps);
  }

  const stopAt = new Set<string>();

  // One schematic station marker per station group (single support node).
  const stations = new Map<string, SupportStation>();
  const groupSupportNode = new Map<string, string>();
  const origIncident = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    for (const nid of [e.from, e.to]) {
      const arr = origIncident.get(nid) ?? [];
      arr.push(e);
      origIncident.set(nid, arr);
    }
  }

  for (const group of groups) {
    const incident = origIncident.get(group.id);
    if (!incident || incident.length === 0) continue;
    const wantLines = new Set<string>();
    for (const e of incident) for (const l of e.lines) wantLines.add(l.id);

    const centroid = groupPixel(group, g);
    // Nearest line-serving node wins (tie-break: more served). The previous
    // most-served-wins rule let a busy junction steal a group from its own
    // terminus stub / anchor node (two groups one marker — "320 Pl missing"),
    // erasing the line's last hop visually. anchorGraphStops creates a node
    // at every stop position, so nearest-with-service maps each group to its
    // own node.
    let best: { id: string; served: number; d: number } | null = null;
    const consider = (nid: string, node: SupportNode, radius: number) => {
      const d = dist(node.pos, centroid);
      if (d > radius) return;
      let served = 0;
      for (const eid of adj.get(nid) ?? []) {
        for (const l of edges.get(eid)!.lineIds) if (wantLines.has(l)) served++;
      }
      if (served === 0) return;
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && served > best.served)) {
        best = { id: nid, served, d };
      }
    };
    for (const [nid, node] of nodes) consider(nid, node, params.stationCandidateRadius);
    if (!best) {
      for (const [nid, node] of nodes) consider(nid, node, mapRadius);
    }
    if (!best) {
      const sn = mapToSupport(group.id);
      if (sn) {
        let served = 0;
        for (const eid of adj.get(sn) ?? []) {
          for (const l of edges.get(eid)!.lineIds) if (wantLines.has(l)) served++;
        }
        if (served > 0) best = { id: sn, served, d: dist(nodes.get(sn)!.pos, centroid) };
      }
    }
    if (!best) continue;
    groupSupportNode.set(group.id, best.id);
    stations.set(group.id, {
      id: group.id,
      label: group.name,
      lngLat: group.center,
      nodeId: best.id,
      truePos: centroid.slice() as Pixel,
      members: Math.max(1, group.stationIds?.length ?? 1),
      stopNodes: new Map(),
    });
  }

  const stopLinesByGroup = new Map<string, Set<string>>();
  const nodeServesLine = (nid: string, lineId: string): boolean =>
    (adj.get(nid) ?? []).some((eid) => edges.get(eid)?.lineIds.has(lineId));
  for (const e of g.edges) {
    for (const [lineId, flags] of e.stops) {
      const place = (groupId: string, isStop: boolean) => {
        if (!isStop) return;
        let sn = groupSupportNode.get(groupId) ?? mapToSupport(groupId);
        if (!sn) return;
        // Lines through one station can ride DIVERGED corridors: the group's
        // node may sit on a segment this line never reaches (307 Pl: the
        // anchor is on the green-only corridor; the cyan terminates at the
        // junction next to it). A flag on a line-less node can never render —
        // re-home it to the nearest node the line actually serves.
        if (!nodeServesLine(sn, lineId)) {
          const gp = g.nodes.get(groupId)?.pos ?? nodes.get(sn)?.pos;
          if (gp) {
            let bestN: string | null = null;
            let bestD = params.stationCandidateRadius * 2;
            for (const [nid, n] of nodes) {
              if (!nodeServesLine(nid, lineId)) continue;
              const d = dist(n.pos, gp);
              if (d < bestD) {
                bestD = d;
                bestN = nid;
              }
            }
            if (bestN) sn = bestN;
          }
        }
        stopAt.add(lineId + '|' + sn);
        let s = stopLinesByGroup.get(groupId);
        if (!s) stopLinesByGroup.set(groupId, (s = new Set()));
        s.add(lineId);
        stations.get(groupId)?.stopNodes?.set(lineId, sn);
      };
      place(e.from, flags.atFrom);
      place(e.to, flags.atTo);
    }
  }
  for (const [gid, lines] of stopLinesByGroup) {
    const st = stations.get(gid);
    if (st) st.stopLines = lines;
  }

  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
  ) {
    let anchors = 0;
    let heals = 0;
    for (const id of nodes.keys()) if (id.startsWith('ha')) anchors++;
    for (const id of edges.keys()) if (id.startsWith('__heal')) heals++;
    console.error(
      `[topo] support: ${nodes.size} nodes (${anchors} anchor splits), ` +
      `${edges.size} edges (${heals} heal bridges)`,
    );
  }
  return { nodes, edges, adj, lineRefs, lineTraversals, stations, stopAt };
}

export interface TopoOptions {
  /** theme.lineWidth in SVG units. */
  lineWidth: number;
}

export function topo(
  g: TransitGraph,
  groups: StationGroup[],
  opts: TopoOptions,
): SupportGraph {
  let maxLines = 2;
  for (const e of g.edges) maxLines = Math.max(maxLines, e.lines.length);
  const dHat = 2.5 * opts.lineWidth * maxLines;
  const params: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
  };
  return buildSupportGraph(g, groups, params);
}
