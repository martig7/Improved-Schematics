// LOOM topo: build the support graph H by merging geographically-parallel
// transit edges into single corridor edges carrying the union of their line
// ids, then re-insert stations at the best-scoring support nodes.
// Reference: Brosi & Bast 2024, "Network Topology Extraction".

import type { Pixel, TransitGraph, GraphEdge } from './types';

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

  nodePos(id: string): Pixel {
    return this.nodes.get(id)!;
  }

  nearestNode(p: Pixel, radius: number, exclude?: ReadonlySet<string>): string | null {
    return this.index.nearest(p, radius, exclude);
  }

  /** Move a node toward `sample`, averaging 50/50 (paper's running average). */
  snap(id: string, sample: Pixel): void {
    const cur = this.nodes.get(id)!;
    const next: Pixel = [(cur[0] + sample[0]) / 2, (cur[1] + sample[1]) / 2];
    this.index.move(id, cur, next);
    this.nodes.set(id, next);
  }

  private edgeKey(a: string, b: string): string {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  addOrUnionEdge(a: string, b: string, lines: Set<string>): void {
    if (a === b) return;
    for (const eid of this.adj.get(a)!) {
      const e = this.edges.get(eid)!;
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) {
        for (const l of lines) e.lineIds.add(l);
        return;
      }
    }
    const id = 'he' + this.eId++;
    const e: HEdge = {
      id,
      a,
      b,
      points: [this.nodes.get(a)!, this.nodes.get(b)!],
      lineIds: new Set(lines),
    };
    this.edges.set(id, e);
    this.adj.get(a)!.add(id);
    this.adj.get(b)!.add(id);
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
    let changed = true;
    while (changed) {
      changed = false;
      for (const [nid, eids] of this.adj) {
        if (eids.size !== 2) continue;
        const [e1, e2] = [...eids].map((id) => this.edges.get(id)!);
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
}

interface MergeInput {
  edges: Array<{ a: Pixel; b: Pixel; points: Pixel[]; lineIds: Set<string> }>;
}

function inputFromGraph(g: TransitGraph): MergeInput {
  const edges = g.edges.map((e: GraphEdge) => {
    const a = g.nodes.get(e.from)!.pos;
    const b = g.nodes.get(e.to)!.pos;
    return { a, b, points: [a, b] as Pixel[], lineIds: new Set(e.lines.map((l) => l.id)) };
  });
  return { edges };
}

function inputFromBuilder(h: HBuilder): MergeInput {
  return {
    edges: h.edgeList().map((e) => ({
      a: e.points[0],
      b: e.points[e.points.length - 1],
      points: e.points,
      lineIds: e.lineIds,
    })),
  };
}

/** True when the candidate node `vPos` sits predominantly *beside* the edge's
 *  local travel direction at sample `pk` (lateral offset >= along-track
 *  offset). Parallel corridors are offset sideways and pass; a transversal
 *  crossing's nodes sit ahead/behind along the travel direction and fail, so
 *  they can only ever share a single node — never interlace into a shared run.
 */
function lateralToTravel(prev: Pixel | null, pk: Pixel, next: Pixel | null, vPos: Pixel): boolean {
  const ax = next ? next[0] - pk[0] : 0;
  const ay = next ? next[1] - pk[1] : 0;
  const bx = prev ? pk[0] - prev[0] : 0;
  const by = prev ? pk[1] - prev[1] : 0;
  let tx = ax + bx;
  let ty = ay + by;
  const tl = Math.hypot(tx, ty);
  if (tl < 1e-9) return true; // no travel direction → no creep to fear
  tx /= tl;
  ty /= tl;
  const ox = vPos[0] - pk[0];
  const oy = vPos[1] - pk[1];
  const along = Math.abs(ox * tx + oy * ty);
  const perp = Math.abs(ox * ty - oy * tx); // 2D cross magnitude
  return perp > along;
}

/** One merge pass: walk every input edge's densified samples, snapping each to
 *  a nearby existing H node or creating a new one, honouring the creep blocker
 *  and a ring buffer that prevents an edge from snapping back onto a node it
 *  just used. */
function onePass(input: MergeInput, params: TopoParams): HBuilder {
  const { dHat, step } = params;
  const h = new HBuilder(dHat);
  // Shortest edges first → most stable merges (paper).
  const sorted = [...input.edges].sort(
    (x, y) => polylineLength(x.points) - polylineLength(y.points),
  );
  const ringSize = Math.max(1, Math.ceil(dHat / step));
  for (const e of sorted) {
    const samples = densify(e.points, step);
    const ring: string[] = [];        // recently-used node ids (FIFO)
    const blocking = new Set<string>(); // same contents, for O(1) exclusion
    let vPrev: string | null = null;
    for (let k = 0; k < samples.length; k++) {
      const pk = samples[k];
      // Nearest existing node that this edge has NOT just used (ring buffer).
      let v = h.nearestNode(pk, dHat, blocking);
      const prev = k > 0 ? samples[k - 1] : null;
      const next = k + 1 < samples.length ? samples[k + 1] : null;
      if (
        v !== null &&
        !creepBlocked(h.nodePos(v), pk, samples) &&
        lateralToTravel(prev, pk, next, h.nodePos(v))
      ) {
        h.snap(v, pk);
      } else {
        v = h.addNode(pk);
      }
      if (vPrev !== null) h.addOrUnionEdge(vPrev, v, e.lineIds);
      ring.push(v);
      blocking.add(v);
      if (ring.length > ringSize) {
        const old = ring.shift()!;
        if (!ring.includes(old)) blocking.delete(old);
      }
      vPrev = v;
    }
  }
  h.contractDegree2WithMatchingLines();
  return h;
}

export function runMergeRounds(g: TransitGraph, params: TopoParams): HBuilder {
  let h: HBuilder | null = null;
  let prevLen = Infinity;
  for (let round = 1; round <= params.maxRounds; round++) {
    const input = h === null ? inputFromGraph(g) : inputFromBuilder(h);
    h = onePass(input, params);
    const len = h.totalLength();
    if (prevLen !== Infinity && Math.abs(1 - len / prevLen) < params.convergenceEpsilon) {
      break;
    }
    prevLen = len;
  }
  return h!;
}
