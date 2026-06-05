// LOOM topo: build the support graph H by merging geographically-parallel
// transit edges into single corridor edges carrying the union of their line
// ids, then re-insert stations at the best-scoring support nodes.
// Reference: Brosi & Bast 2024, "Network Topology Extraction".

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
      // A sample coincident with an existing node is the identity merge that
      // preserves connectivity at shared/junction nodes (lines chain through
      // common stops). The creep/lateral guards below only reject *spurious*
      // merges; they must never reject a node sitting exactly on the sample
      // (both degenerate to a false-negative at zero offset).
      const coincident = v !== null && dist(h.nodePos(v), pk) < 1e-6;
      if (
        v !== null &&
        (coincident ||
          (!creepBlocked(h.nodePos(v), pk, samples) &&
            lateralToTravel(prev, pk, next, h.nodePos(v))))
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
      const e = edges.get(eid)!;
      if (!e.lineIds.has(lineId)) continue;
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

export function buildSupportGraph(
  g: TransitGraph,
  groups: StationGroup[],
  params: TopoParams,
): SupportGraph {
  const builder = runMergeRounds(g, params);
  builder.intersectionSmoothing(params.dHat);
  const { nodes, edges, adj, index } = freezeBuilder(builder, g);

  const lineRefs = new Map<string, LineRef>();
  for (const e of g.edges) for (const l of e.lines) if (!lineRefs.has(l.id)) lineRefs.set(l.id, l);

  // Reconstruct line traversals over the merged edges.
  const lineTraversals = new Map<string, TraversalStep[]>();
  for (const [lineId, origSteps] of g.lineTraversals) {
    // Ordered original node ids along the line.
    const seq: string[] = [];
    for (const step of origSteps) {
      const e = g.edges.find((x) => x.id === step.edgeId);
      if (!e) continue;
      const from = step.reversed ? e.to : e.from;
      const to = step.reversed ? e.from : e.to;
      if (seq.length === 0) seq.push(from);
      if (seq[seq.length - 1] !== to) seq.push(to);
    }
    // Map each original node to its nearest support node, collapse dups.
    const supportSeq: string[] = [];
    for (const nid of seq) {
      const gp = g.nodes.get(nid);
      if (!gp) continue;
      const sn = index.nearest(gp.pos, params.dHat * 2) ?? index.nearest(gp.pos, Infinity);
      if (sn && supportSeq[supportSeq.length - 1] !== sn) supportSeq.push(sn);
    }
    const steps: TraversalStep[] = [];
    for (let i = 0; i < supportSeq.length - 1; i++) {
      const seg = bfsLinePath(supportSeq[i], supportSeq[i + 1], lineId, edges, adj);
      if (seg) steps.push(...seg);
    }
    if (steps.length > 0) lineTraversals.set(lineId, steps);
  }

  // Stop flags: a line stops at a support node if it stopped at the original
  // node nearest to it.
  const stopAt = new Set<string>();
  for (const e of g.edges) {
    for (const [lineId, flags] of e.stops) {
      const place = (origNodeId: string, stops: boolean) => {
        if (!stops) return;
        const gp = g.nodes.get(origNodeId);
        if (!gp) return;
        const sn = index.nearest(gp.pos, params.dHat * 2);
        if (sn) stopAt.add(lineId + '|' + sn);
      };
      place(e.from, flags.atFrom);
      place(e.to, flags.atTo);
    }
  }

  // Insert stations.
  const stations = new Map<string, SupportStation>();
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
    // Candidate support nodes within radius, scored by served-line count.
    const candidates: Array<{ id: string; served: Set<string> }> = [];
    for (const [nid, node] of nodes) {
      if (dist(node.pos, centroid) > params.stationCandidateRadius) continue;
      const served = new Set<string>();
      for (const eid of adj.get(nid) ?? []) {
        for (const l of edges.get(eid)!.lineIds) if (wantLines.has(l)) served.add(l);
      }
      if (served.size > 0) candidates.push({ id: nid, served });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.served.size - a.served.size);

    const used = new Set<string>();
    let idx = 0;
    for (const cand of candidates) {
      const adds = [...cand.served].filter((l) => !used.has(l));
      if (adds.length === 0) continue;
      for (const l of adds) used.add(l);
      const stationId = idx === 0 ? group.id : group.id + '__alt' + idx;
      stations.set(stationId, {
        id: stationId,
        label: group.name,
        lngLat: group.center,
        nodeId: cand.id,
      });
      idx++;
      if (used.size >= wantLines.size) break;
    }
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
