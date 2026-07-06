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
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy); // sqrt is correctly-rounded cross-V8 (hypot is not)
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
 *  the current sample relative to that sample's distance to either endpoint.
 *  This prevents two edges meeting at an obtuse angle from interlacing. */
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

  nearest(
    p: Pixel,
    radius: number,
    exclude?: ReadonlySet<string>,
  ): string | null {
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
          const d = Math.sqrt((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]));
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
  private protIndex: NodeIndex; // protected nodes only (endpoint binding)
  private nId = 0;
  private eId = 0;
  private protected_ = new Set<string>();

  constructor(indexCell: number) {
    this.index = new NodeIndex(indexCell);
    this.protIndex = new NodeIndex(indexCell);
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
    const p = this.nodes.get(id);
    if (p) this.protIndex.insert(id, p);
  }

  /** Nearest PROTECTED node within `radius`. Protected nodes never move, so
   *  the protIndex needs no move-tracking; a stale id (protected node deleted
   *  by a later pass) is filtered against the live node map. */
  nearestProtectedNode(p: Pixel, radius: number): string | null {
    const id = this.protIndex.nearest(p, radius);
    return id !== null && this.nodes.has(id) ? id : null;
  }

  nodePos(id: string): Pixel {
    return this.nodes.get(id)!;
  }

  nearestNode(
    p: Pixel,
    radius: number,
    exclude?: ReadonlySet<string>,
  ): string | null {
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
   *  micro-mesh of near-coincident nodes around a multi-line junction, each
   *  within dHat of the others, but never collapsed because degree-2
   *  contraction is blocked at forks. Octi then inflates every micro-node to
   *  its own grid cell, turning a small mesh into full-cell phantom loops.
   *
   *  Must run AFTER contractDegree2WithMatchingLines has joined the short sample
   *  chains into long corridor edges, otherwise it would eat real corridors. */
  contractShortEdges(maxLen: number): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of this.edges.values()) {
        // Degeneracy metric is NODE distance, not polyline length: a wiggly
        // sub-maxLen-span connector can carry >= maxLen of sampled geometry
        // and shield itself from contraction. These are sub-cell node pairs
        // the router cannot route cleanly. Geometry that genuinely LEAVES the
        // neighbourhood (a balloon spur) is a real course, not a degenerate
        // connector, so the extent test keeps it.
        const na = this.nodes.get(e.a)!;
        if (dist(na, this.nodes.get(e.b)!) >= maxLen) continue;
        if (polylineLength(e.points) >= maxLen) {
          let extent = 0;
          for (const p of e.points) {
            const d = dist(na, p);
            if (d > extent) extent = d;
          }
          if (extent >= maxLen) continue; // real geometry (balloon), keep
        }
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
 * terminal balloon loop ends up INSIDE a single edge polyline. Its length
 * then vastly exceeds its endpoint span, and octi's spring cost manufactures
 * a phantom grid detour to honor the extra length. LOOM never
 * meets this because its merge re-walks all geometry each iteration, zipping
 * intra-edge folds; our merge rounds re-feed endpoint chords only.
 *
 * Endpoints are always preserved. Genuine V-corners survive: the cut needs
 * the legs to stay within eps after `minArc` of travel, not merely touch. */
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
  const tl = Math.sqrt(tx * tx + ty * ty); // correctly-rounded cross-V8 (hypot is not)
  if (tl < 1e-9) return true;
  tx /= tl;
  ty /= tl;
  const ox = vPos[0] - pk[0];
  const oy = vPos[1] - pk[1];
  const along = Math.abs(ox * tx + oy * ty);
  const perp = Math.abs(ox * ty - oy * tx);
  return perp > along;
}

/** LOOM MapConstructor::ndCollapseCand. Returns the nearest node within dCut,
 *  or creates one. Reusing the nearest protected anchor instead of minting is
 *  not done here: a reused anchor lands in myNds and the very next sample mints
 *  a twin anyway. Walk-time twins are fine; the spacing invariant is enforced
 *  by contraction, which must simply not be undone afterwards. */
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

  // TOTAL tie-break (fromId|toId|lineSig is unique per merge edge): mirrored
  // corridors have equal length, so without this the seed order, and thus the
  // merged topology, depends on the engine's sort tie behavior (cross-V8).
  const ekey = (e: { fromId: string; toId: string; lineSig: string }) =>
    e.fromId + '|' + e.toId + '|' + e.lineSig;
  const sorted = [...input.edges].sort(
    (x, y) => (polylineLength(y.points) - polylineLength(x.points)) ||
      (ekey(x) < ekey(y) ? -1 : ekey(x) > ekey(y) ? 1 : 0),
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
      // ENDPOINT samples bind the edge's identity (imgNds below) and sit
      // exactly ON a graph-node position. They must reuse the nearest
      // PROTECTED node within dHat (the seed-dedupe policy applied at bind
      // time), even when this walk already consumed it mid-course (myNds)
      // or a snap guard would refuse. Otherwise the walk mints a twin a
      // couple of px from the seed, the endpoint binds to the TWIN, and
      // contraction later dissolves it and slides the corridor's attachment
      // to a neighbouring protected node, drawing the branch as an
      // out-and-back hook.
      const isEnd = i === 0 || i === samples.length - 1;
      const seed = isEnd ? h.nearestProtectedNode(pk, dHat) : null;
      const cur = seed ?? ndCollapseCand(h, myNds, pk, dHat, samples, i);
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
      const at = (nid: string | undefined | null): string => {
        if (!nid) return '?';
        const p = h.nodePos(nid);
        return `${nid}(${p[0].toFixed(0)},${p[1].toFixed(0)})`;
      };
      console.error(
        `[walk] edge ${e.fromId.slice(0, 6)}->${e.toId.slice(0, 6)} ` +
        `len=${polylineLength(e.points).toFixed(0)} samples=${samples.length} ` +
        `unions=${unions} earlyBreak=${broke} ` +
        `ends: ${at(imgNds.get(e.fromId))} -> ${at(imgNds.get(e.toId))} first=${at(front)} last=${at(last)}`,
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

export function runMergeRounds(g: TransitGraph, params: TopoParams): HBuilder {
  let h: HBuilder | null = null;
  let prevLen = Infinity;
  let prevEdges = Infinity;
  // Junction/terminus anchors are protected UNCONDITIONALLY. Rounds >= 2
  // re-feed averaged geometry, so node drift COMPOUNDS dHat per round. Without
  // protection, round-1 averaging can creep two genuinely distinct legs within
  // dHat of each other and round 2 zips them into a phantom shared trunk,
  // demoting a real junction and manufacturing a fake one a corridor away.
  // STOP nodes are protected too. Otherwise the merge contracts every degree-2
  // same-lines stop away and a later pass re-splits corridors, a re-derivation
  // that loses which corridor the stop was ON (stranding twin platforms).
  // Protecting stops keeps them at their exact positions with correct per-side
  // paint, so downstream seating/snapping is identity, not proximity search.
  const stopNodeIds = new Set<string>();
  for (const e of g.edges) {
    for (const flags of e.stops.values()) {
      if (flags.atFrom) stopNodeIds.add(e.from);
      if (flags.atTo) stopNodeIds.add(e.to);
    }
  }
  // Spacing floor at the SOURCE: a stop within dHat of an already-protected
  // position gets NO seed of its own. Its walk samples snap onto the neighbour
  // and the stops share a node. Without this, dense maps grow sub-cell station
  // twins the router must ping-pong around. Anchors seed first (junctions stay
  // put); stop seeding order is sorted by node id, so it is deterministic.
  const protectedPositions = [...g.nodes.values()]
    .filter((n) => isMergeAnchor(g, n.id))
    .map((n) => n.pos.slice() as Pixel);
  const stopOnly = [...g.nodes.values()]
    .filter((n) => !isMergeAnchor(g, n.id) && stopNodeIds.has(n.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of stopOnly) {
    let clear = true;
    for (const p of protectedPositions) {
      if (dist(p, n.pos) < params.dHat) { clear = false; break; }
    }
    if (clear) protectedPositions.push(n.pos.slice() as Pixel);
  }
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
  // Per-station-node mode: the group has no node of its own, so average its
  // member platform nodes (already projected/warped like every graph node).
  let sx = 0;
  let sy = 0;
  let c = 0;
  for (const sid of group.stationIds ?? []) {
    const m = g.nodes.get(sid);
    if (m) {
      sx += m.pos[0];
      sy += m.pos[1];
      c++;
    }
  }
  if (c > 0) return [sx / c, sy / c];
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

/** Shortest path BY LENGTH over support edges carrying `lineId` (Dijkstra,
 *  same structure as shortestAnyPath). Returns ordered steps or null.
 *
 *  Length rather than hop-count is deliberate: fewest merged edges is NOT the
 *  schematic course. The direct corridor between two consecutive stops is
 *  chopped into many small anchor-split edges, while a V-shaped detour through
 *  a stop column the line never serves can be fewer (longer) hops, so hop-count
 *  routing manufactures zigzags. Length restores the obvious choice; the input
 *  tracks are near-straight (max perp 0.2x chord), so the shortest painted
 *  course is the faithful one. */
export function linePathByLength(
  src: string,
  dst: string,
  lineId: string,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
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
    if (cur === null) return null;
    if (cur === dst) break;
    done.add(cur);
    for (const eid of adj.get(cur) ?? []) {
      const e = edges.get(eid);
      if (!e || !e.lineIds.has(lineId)) continue;
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
    const d = Math.sqrt((q[0] - (a[0] + vx * t)) ** 2 + (q[1] - (a[1] + vy * t)) ** 2);
    const seg = Math.sqrt(c2);
    if (d < best.d) best = { d, arc: acc + seg * t, segIdx: i - 1, total: 0 };
    acc += seg;
  }
  best.total = acc;
  return best;
}

/** Weld redundant retrace stubs onto their corridor. A terminus a short
 *  distance behind the previous stop yields: corridor edge `f` passing exactly
 *  THROUGH the terminus position (no node there) plus a short stub edge `e`
 *  doubling back over `f`'s own geometry. Left alone, octi's planarize treats
 *  the coincident overlap as a CROSSING and inserts an intersection node, so
 *  the fold becomes graph structure and draws as a phantom hub with spokes.
 *  Fix the structure: split `f` at the stub's far node and fold the stub's
 *  lines into the now exactly-parallel half. The line then renders as an
 *  inline collapsed out-and-back and the stations sit in geographic order on
 *  one straight corridor. */
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

  let stubWelds = 0;
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
          stubWelds++;

          const head = f.points.slice(0, proj.segIdx + 1).map(cp);
          const tail = f.points.slice(proj.segIdx + 1).map(cp);
          head.push(cp(aNode.pos));
          tail.unshift(cp(aNode.pos));
          const id1 = nextEdgeId();
          const id2 = nextEdgeId();
          const f1: SupportEdge = { id: id1, from: f.from, to: A, points: head, lineIds: new Set(f.lineIds) };
          const f2: SupportEdge = { id: id2, from: A, to: f.to, points: tail, lineIds: new Set(f.lineIds) };
          const half = f.from === B ? f1 : f2; // the exactly-parallel A to B half
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
  if (
    stubWelds > 0 &&
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_AUDIT
  ) {
    console.error(`[audit:fire] weldRedundantStubs=${stubWelds}`);
  }
}

/** Absorb sub-dHat degree-1 stubs hanging off junctions (degree >= 3 with
 *  the stub). A station a short distance from a junction it detours from draws
 *  as a boxy in-and-out knot: the lane bundle is WIDER than the stub is long,
 *  and every serving line hooks 90° in and out. The station re-maps to the
 *  junction node, within the <= dHat fusion tolerance, and
 *  separateFusedStations re-splits if it ever lands on another station with
 *  true separation > dHat. Real termini keep their stubs: their neighbor is
 *  the degree-2 corridor through the previous station, not a junction. */
function absorbJunctionStubs(
  nodes: Map<string, SupportNode>,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
  dHat: number,
): void {
  const DBG =
    typeof process !== 'undefined' &&
    !!(process as { env?: Record<string, string> }).env?.OCTI_DEBUG;
  let absorbed = 0;
  for (const eid of [...edges.keys()].sort()) {
    const e = edges.get(eid);
    if (!e) continue;
    // Short stubs absorb outright. Additionally, near-zero-span stubs whose
    // polyline is a merge-noise zigzag (endpoints close together under a much
    // longer fold) absorb despite the inflated length: that footprint is what
    // octi blows up to a full drawn cell. Wider-span stubs with long geometry
    // are genuinely extended structures, so they keep their nodes; absorbing
    // them degrades dense interchange layouts.
    const span = dist(e.points[0], e.points[e.points.length - 1]);
    const len = polylineLength(e.points);
    if (len >= dHat && !(span < dHat / 2 && len < 2 * dHat)) continue;
    for (const [A, B] of [[e.from, e.to], [e.to, e.from]] as const) {
      if ((adj.get(A)?.length ?? 0) !== 1) continue;
      if ((adj.get(B)?.length ?? 0) < 3) continue;
      // Only absorb DETOUR stops: every line on the stub must continue
      // through the junction (arrive + depart on other edges at B). A line
      // that ends in the stub marks a real terminus, so keep its node.
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
      absorbed++;
      if (DBG) console.error(`[topo] absorb ${eid} ${A} -> ${B} (span ${span.toFixed(1)})`);
      break;
    }
  }
  if (
    absorbed > 0 &&
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_AUDIT
  ) {
    console.error(`[audit:fire] absorbJunctionStubs=${absorbed}`);
  }
}

/**
 * Weld support nodes that would fight for the SAME octi grid cell into one
 * node. Merge guards can still mint a synthetic twin inside a protected stop's
 * cell, leaving a tiny edge whose endpoints need distinct cells, which forces
 * the router into a long detour drawn as a closed loop. Collapsing sub-cell
 * clusters removes the degenerate inputs instead of teaching the
 * router/merge/draw new edge cases.
 *
 * Components are transitive closures of pairs closer than `minDist`.
 * Survivor priority: station node > higher degree > smaller id (deterministic).
 * Weld edges (zero-span after remap) are deleted; their traversal steps drop
 * out without breaking the chain (both endpoints became the survivor).
 * Distinct station groups welded onto one node stay separate SupportStations;
 * the existing separateFusedStations pass re-splits or capsules them.
 */
export function weldSubCellNodes(h: SupportGraph, minDist: number): number {
  if (minDist <= 0) return 0;
  const ids = [...h.nodes.keys()].sort();
  if (ids.length < 2) return 0;

  // spatial hash so the pair scan is O(n · bucket) not O(n²)
  const bucket = new Map<string, string[]>();
  const bKey = (x: number, y: number): string =>
    Math.floor(x / minDist) + ',' + Math.floor(y / minDist);
  for (const id of ids) {
    const p = h.nodes.get(id)!.pos;
    const k = bKey(p[0], p[1]);
    (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(id);
  }

  const stationNodes = new Set<string>();
  const primaryNodes = new Set<string>();
  const nodeGroups = new Map<string, Set<string>>();
  const addNg = (nid: string, gid: string): void => {
    let s = nodeGroups.get(nid);
    if (!s) nodeGroups.set(nid, (s = new Set()));
    s.add(gid);
  };
  for (const [gid, sp] of h.stations) {
    stationNodes.add(sp.nodeId);
    primaryNodes.add(sp.nodeId);
    addNg(sp.nodeId, gid);
    for (const nid of sp.stopNodes?.values() ?? []) {
      stationNodes.add(nid);
      addNg(nid, gid);
    }
  }
  // Same-GROUP platform twins may fuse. The group draws ONE capsule either
  // way, so welding them changes nothing the map says. It removes the
  // sub-cell ping-pong between sibling platforms. DISTINCT groups never fuse.
  const sameGroup = (a: string, b: string): boolean => {
    const sa = nodeGroups.get(a);
    const sb = nodeGroups.get(b);
    if (!sa || !sb) return false;
    for (const g of sa) if (sb.has(g)) return true;
    return false;
  };

  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(a) !== a) { const nxt = parent.get(a)!; parent.set(a, r); a = nxt; }
    return r;
  };
  const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };

  for (const id of ids) {
    const p = h.nodes.get(id)!.pos;
    const cx = Math.floor(p[0] / minDist);
    const cy = Math.floor(p[1] / minDist);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const other of bucket.get(cx + ox + ',' + (cy + oy)) ?? []) {
          if (other <= id) continue;
          // Two distinct-GROUP station nodes never weld, because that would
          // change what the map says (two stops become one). Same-group twins
          // and synthetics are fair game.
          if (stationNodes.has(id) && stationNodes.has(other) && !sameGroup(id, other)) continue;
          if (dist(p, h.nodes.get(other)!.pos) < minDist) union(id, other);
        }
      }
    }
  }

  // survivor per component: station > degree > smaller id
  const comps = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    (comps.get(r) ?? comps.set(r, []).get(r)!).push(id);
  }
  const survivorOf = new Map<string, string>();
  let welds = 0;
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    members.sort();
    const stationsIn = members.filter((m) => stationNodes.has(m));
    if (stationsIn.length > 1) {
      // A synthetic can chain stations of DIFFERENT groups into one component.
      // Cluster the stations by shared group. Same-group twins weld to one
      // survivor per cluster (a group's primary marker node wins, then
      // degree, then id). Distinct-group clusters stay separate. Synthetics
      // weld into their NEAREST surviving station (deterministic ties by id).
      const sPar = new Map(stationsIn.map((s) => [s, s]));
      const sFind = (a: string): string => { while (sPar.get(a) !== a) a = sPar.get(a)!; return a; };
      for (let i = 0; i < stationsIn.length; i++) {
        for (let j = i + 1; j < stationsIn.length; j++) {
          if (sameGroup(stationsIn[i], stationsIn[j])) sPar.set(sFind(stationsIn[i]), sFind(stationsIn[j]));
        }
      }
      const clusters = new Map<string, string[]>();
      for (const s of stationsIn) {
        const r = sFind(s);
        (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(s);
      }
      const survivors: string[] = [];
      for (const cl of clusters.values()) {
        cl.sort();
        let best = cl[0];
        for (const m of cl) {
          const bPrim = primaryNodes.has(best) ? 1 : 0;
          const mPrim = primaryNodes.has(m) ? 1 : 0;
          const bDeg = (h.adj.get(best) ?? []).length;
          const mDeg = (h.adj.get(m) ?? []).length;
          if (mPrim > bPrim || (mPrim === bPrim && (mDeg > bDeg || (mDeg === bDeg && m < best)))) best = m;
        }
        survivors.push(best);
        for (const m of cl) {
          if (m === best) continue;
          survivorOf.set(m, best);
          welds++;
        }
      }
      for (const m of members) {
        if (stationNodes.has(m)) continue;
        const mp = h.nodes.get(m)!.pos;
        let best = survivors[0];
        let bd = Infinity;
        for (const s of survivors) {
          const d = dist(mp, h.nodes.get(s)!.pos);
          if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && s < best)) { bd = d; best = s; }
        }
        survivorOf.set(m, best);
        welds++;
      }
      continue;
    }
    let best = members[0];
    for (const m of members) {
      const bStation = stationNodes.has(best) ? 1 : 0;
      const mStation = stationNodes.has(m) ? 1 : 0;
      const bDeg = (h.adj.get(best) ?? []).length;
      const mDeg = (h.adj.get(m) ?? []).length;
      if (
        mStation > bStation ||
        (mStation === bStation && (mDeg > bDeg || (mDeg === bDeg && m < best)))
      ) best = m;
    }
    for (const m of members) {
      if (m === best) continue;
      survivorOf.set(m, best);
      welds++;
    }
  }
  if (welds === 0) return 0;

  const remap = (nid: string): string => survivorOf.get(nid) ?? nid;

  // nodes
  for (const dead of survivorOf.keys()) h.nodes.delete(dead);

  // edges: re-endpoint, pin polyline ends to survivor positions, drop
  // degenerate weld edges (self-loop after remap with sub-weld geometry)
  const removedEdges = new Set<string>();
  for (const [eid, e] of h.edges) {
    const nf = remap(e.from);
    const nt = remap(e.to);
    if (nf === e.from && nt === e.to) continue;
    e.from = nf;
    e.to = nt;
    if (nf === nt) {
      // Self-loop after weld: keep only a REAL balloon (terminal loop with
      // extent beyond a cell). A curly sub-cell connector can carry lots of
      // polyline length while never leaving the node's neighbourhood. Drawn,
      // it's a curl blob at the station.
      const pos = h.nodes.get(nf)!.pos;
      let extent = 0;
      for (const p of e.points) {
        const d = dist(pos, p);
        if (d > extent) extent = d;
      }
      if (extent < minDist * 2) {
        h.edges.delete(eid);
        removedEdges.add(eid);
        continue;
      }
    }
    const fp = h.nodes.get(nf)!.pos;
    const tp = h.nodes.get(nt)!.pos;
    e.points[0] = [fp[0], fp[1]];
    e.points[e.points.length - 1] = [tp[0], tp[1]];
  }

  // adjacency: rebuild from surviving edges
  h.adj.clear();
  for (const id of h.nodes.keys()) h.adj.set(id, []);
  for (const e of h.edges.values()) {
    h.adj.get(e.from)!.push(e.id);
    h.adj.get(e.to)!.push(e.id);
  }

  // traversals: drop steps over removed weld edges. The chain stays intact
  // because a removed edge's endpoints are the same survivor node.
  if (removedEdges.size > 0) {
    for (const [lineId, steps] of h.lineTraversals) {
      const kept = steps.filter((s) => !removedEdges.has(s.edgeId));
      if (kept.length !== steps.length) h.lineTraversals.set(lineId, kept);
    }
  }

  // stations + stop flags follow their nodes
  for (const sp of h.stations.values()) {
    sp.nodeId = remap(sp.nodeId);
    if (sp.stopNodes) {
      for (const [lid, nid] of sp.stopNodes) sp.stopNodes.set(lid, remap(nid));
    }
  }
  const stopAt = [...h.stopAt];
  h.stopAt.clear();
  for (const key of stopAt) {
    const i = key.indexOf('|');
    h.stopAt.add(key.slice(0, i + 1) + remap(key.slice(i + 1)));
  }

  return welds;
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
  // folds into the joined polylines. Sanitize again so octi's spring cost
  // never sees phantom length (it pays it back as candy-cane grid detours).
  builder.sanitizeEdgeGeometry(params.dHat);
  if (!params.preserveStations) builder.intersectionSmoothing(params.dHat);
  // Smoothing MOVES nodes (each to the average of its cropped edge endpoints)
  // and can pull a pair inside the spacing floor with no contraction pass left
  // to repair it. The last writer of node positions must re-enforce the
  // invariant, or octi receives sub-cell pairs it cannot route.
  builder.contractShortEdges(params.dHat);
  const { nodes, edges, adj } = freezeBuilder(builder, g);

  let edgeSeq = edges.size;
  {
    // Stops survive the merge as protected nodes (runMergeRounds), so no
    // re-anchoring pass runs here.
    // adj normalization: deterministic edge-id insertion order for every
    // node, because downstream tie-breaks iterate adj arrays.
    for (const ids of adj.values()) ids.length = 0;
    for (const id of nodes.keys()) if (!adj.has(id)) adj.set(id, []);
    for (const e of edges.values()) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.has(e.to)) adj.set(e.to, []);
      adj.get(e.from)!.push(e.id);
      adj.get(e.to)!.push(e.id);
    }
    // Terminus retrace stubs duplicate corridor geometry the protected stops
    // keep split. Weld them in before traversal reconstruction sees the fold.
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

  // Heal-ladder census (dev, OCTI_AUDIT=1): how often traversal reconstruction
  // falls past the line-constrained BFS. Sizes the prize of carrying line
  // paths THROUGH the merge instead of re-deriving them.
  const healStats = { bfs: 0, anyPath: 0, miss: 0, stallJump: 0 };

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
    const path = linePathByLength(fromS, toS, lineId, edges, adj);
    if (path) { healStats.bfs++; return path; }
    // Self-heal an under-painted merge: the walk can miss unioning a line
    // onto corridors its geometry rides (then the line-constrained BFS finds
    // nothing and the line would silently vanish from the map). Route over
    // ANY support edges instead, shortest by length, capped so a mis-mapped
    // node can't commit a wild detour, and paint the line onto the edges
    // used so offsets, stops, and later segments see it.
    const fa = nodes.get(fromS);
    const fb = nodes.get(toS);
    if (!fa || !fb) return null;
    const cap = dist(fa.pos, fb.pos) * 3 + params.dHat * 10;
    const any = shortestAnyPath(fromS, toS, edges, adj, cap);
    if (any) {
      healStats.anyPath++;
      for (const s of any) edges.get(s.edgeId)!.lineIds.add(lineId);
      return any;
    }
    // No path at all. No synthetic bridge edge is minted here. Minting one
    // would draw a fabricated straight track across the map. The caller's
    // stall/service-break handling below is the honest failure mode.
    healStats.miss++;
    return null;
  };

  // Line-aware node mapping: snap a graph node to the nearest support node
  // whose incident edges actually CARRY the line. Pure nearest-by-position
  // snapping (mapToSupport) can land on a parallel corridor a few pixels
  // away that the line never touches, and then every line-constrained BFS
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
    // null = deliberate service break (a suppressed loop-closure leg left a
    // discontinuity in the graph traversal). Each run reconstructs on its
    // own. Pathing or heal-bridging ACROSS a break would resurrect the
    // suppressed deadhead ink.
    const graphNodes: (string | null)[] = [];
    for (const step of origSteps) {
      const e = g.edges.find((x) => x.id === step.edgeId);
      if (!e) continue;
      const fromId = step.reversed ? e.to : e.from;
      const toId = step.reversed ? e.from : e.to;
      if (graphNodes.length === 0) graphNodes.push(fromId);
      else if (graphNodes[graphNodes.length - 1] !== fromId) {
        graphNodes.push(null);
        graphNodes.push(fromId);
      }
      graphNodes.push(toId);
    }

    const supportNodes: (string | null)[] = [];
    for (const gn of graphNodes) {
      if (gn === null) {
        if (supportNodes.length > 0 && supportNodes[supportNodes.length - 1] !== null) {
          supportNodes.push(null);
        }
        continue;
      }
      const sn = mapToSupportForLine(gn, lineId);
      if (!sn) continue;
      if (supportNodes.length === 0 || supportNodes[supportNodes.length - 1] !== sn) {
        supportNodes.push(sn);
      }
    }

    const steps: TraversalStep[] = [];
    let curNode: string | null = null;
    let stalled = false;
    for (let i = 0; i < supportNodes.length; i++) {
      const target = supportNodes[i];
      if (target === null) {
        // service break: the next run starts fresh
        curNode = null;
        stalled = false;
        continue;
      }
      if (curNode === null) {
        curNode = target;
        continue;
      }
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
        if (stalled) { curNode = target; healStats.stallJump++; }
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
  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_AUDIT
  ) {
    console.error(
      `[audit:heal-ladder] path=${healStats.bfs} ` +
      `anyPath(paint)=${healStats.anyPath} miss=${healStats.miss} stallJump=${healStats.stallJump}`,
    );
  }

  const stopAt = new Set<string>();

  // One schematic station marker per station group. In per-station-node mode
  // a group spans several platform nodes; the SupportStation stays singular
  // (one label, one capsule) and its per-line stopNodes land on the platform
  // nodes. The capsule placer joins them via stopNodes.
  const stations = new Map<string, SupportStation>();
  const groupSupportNode = new Map<string, string>();
  const nodeToGroup = new Map<string, string>();
  const groupMemberNodes = new Map<string, string[]>();
  for (const group of groups) {
    const members: string[] = [];
    if (g.nodes.has(group.id)) members.push(group.id);
    for (const sid of group.stationIds ?? []) {
      if (g.nodes.has(sid)) members.push(sid);
    }
    groupMemberNodes.set(group.id, members);
    for (const m of members) nodeToGroup.set(m, group.id);
  }
  const origIncident = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    for (const nid of [e.from, e.to]) {
      const arr = origIncident.get(nid) ?? [];
      arr.push(e);
      origIncident.set(nid, arr);
    }
  }

  for (const group of groups) {
    const incident: GraphEdge[] = [];
    for (const m of groupMemberNodes.get(group.id) ?? []) {
      incident.push(...(origIncident.get(m) ?? []));
    }
    if (incident.length === 0) continue;
    const wantLines = new Set<string>();
    for (const e of incident) for (const l of e.lines) wantLines.add(l.id);

    const centroid = groupPixel(group, g);
    // Nearest line-serving node wins (tie-break: more served). A
    // most-served-wins rule would let a busy junction steal a group from its
    // own terminus stub / anchor node, collapsing two groups onto one marker
    // and erasing the line's last hop visually. A node exists at every stop
    // position, so nearest-with-service maps each group to its own node.
    let best: { id: string; served: number; d: number } | null = null;
    const consider = (nid: string, node: SupportNode, radius: number) => {
      const d = dist(node.pos, centroid);
      if (d > radius) return;
      let served = 0;
      for (const eid of adj.get(nid) ?? []) {
        // adj can hold a stale edge id that edges no longer has (a merge/collapse
        // that didn't prune adj). A non-existent edge serves nothing, so skip it
        // rather than crash on `.lineIds` of undefined.
        const e = edges.get(eid);
        if (!e) continue;
        for (const l of e.lineIds) if (wantLines.has(l)) served++;
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
      for (const m of groupMemberNodes.get(group.id) ?? []) {
        const sn = mapToSupport(m);
        if (!sn) continue;
        let served = 0;
        for (const eid of adj.get(sn) ?? []) {
          for (const l of edges.get(eid)!.lineIds) if (wantLines.has(l)) served++;
        }
        if (served > 0) {
          best = { id: sn, served, d: dist(nodes.get(sn)!.pos, centroid) };
          break;
        }
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
      const place = (nodeId: string, isStop: boolean) => {
        if (!isStop) return;
        const groupId = nodeToGroup.get(nodeId) ?? nodeId;
        // Per-station-node mode: a platform node anchors its own stop, so
        // the flag lands on the platform's support node, not the group's.
        // The SupportStation still gathers all platforms via stopNodes.
        let sn =
          nodeId !== groupId
            ? mapToSupport(nodeId) ?? groupSupportNode.get(groupId)
            : groupSupportNode.get(groupId) ?? mapToSupport(groupId);
        if (!sn) return;
        // Lines through one station can ride DIVERGED corridors: the group's
        // node may sit on a segment this line never reaches (its anchor lands
        // on one line's corridor while another line terminates at the junction
        // next to it). A flag on a line-less node can never render, so
        // re-home it to the nearest node the line actually serves.
        if (!nodeServesLine(sn, lineId)) {
          const gp = g.nodes.get(nodeId)?.pos ?? nodes.get(sn)?.pos;
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
    for (const id of nodes.keys()) if (id.startsWith('ha')) anchors++;
    console.error(
      `[topo] support: ${nodes.size} nodes (${anchors} anchor splits), ${edges.size} edges`,
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
