// Dense-box expansion warp. NOT density-equalizing — it finds the densest /
// most contraction-prone regions as axis-aligned bounding boxes and EXPANDS
// each to lower its crowding, leaving the far field geographically faithful.
// Rectilinear by construction (per-axis box bands, not a radial kernel that
// would round the whole map).
//
// Demand-driven pipeline (buildDemandBoxWarp): boxes come from density peaks
// (findDenseBoxes, a fraction-of-peak cutoff on excess density) UNION
// predicted octi contraction (findContractionBoxes, a union-find over edges
// shorter than the predicted contraction threshold — this is what catches
// small pinned clusters, like JFK's 8px-apart terminals, that are invisible
// to fraction-of-peak density) UNION predicted capsule collisions
// (findCapsuleBoxes, a spatial pair scan over marker-row needs — interchanges
// closer than their combined capsule half-lengths, which need FAR more room
// than the contraction threshold grants). Overlapping boxes are merged to a
// nesting-aware fixpoint (mergeDemandBoxes: same-kind unions, cross-kind
// containment nests and compounds) so pushes never double-stack. Each box is
// then expanded by exactly what its OWN targets need — contraction survival
// plus any capsule pair separations — DIRECTION-INTELLIGENTLY: the scalar
// demand is split per axis along the box's crowd anisotropy
// (boxCrowdAnisotropy — nearest-neighbour displacements say WHICH axis lacks
// room, so Manhattan's parallel vertical trunks get their room horizontally
// instead of half-wasting it on the axis the lines already span) — via a smooth
// saturating per-axis push: inside the box half-extent the map ramps at unit
// slope, eases the slope to 0 across the margin, then HOLDS constant — so the
// surround is carried outward rather than crammed back to identity. Tapering
// back to identity (an earlier, now-deleted design) forced, by area
// conservation, a compression ring just outside the box — the "weirdly thin
// geography at the edge of growth". A saturating push keeps the per-axis map
// monotone (slope in [0,1], so p + s·push is monotone for s >= 0), so the
// expansion is fold-free at any strength and has NO localized thinning.
//
// GROWTH, not claw-back — and SPACE ∝ WARP: the saturating push only grows
// the overall bbox, and that growth is KEPT — the output canvas grows PER
// AXIS to exactly what the granted warp produces, so the far field always
// keeps unit scale (a saturated push is a rigid translation out there).
// maxGrowth THROTTLES the push strengths when the raw growth would exceed it
// (growth is affine in the strengths, so the throttle is exact) — it never
// squeezes the warped map back into a capped canvas: the old global-shrink
// cap made the outskirts pay for the core's room (Staten Island crushed into
// bands at the canvas edges). Per axis (not a single uniform scale) so the
// warped canvas FILLS the grown canvas instead of letterboxing. A bounded
// secant refinement pass re-solves each box's demand against the POST-warp
// contraction threshold (the median edge length — and so the threshold —
// rises as boxes expand) with the cap SLACK (throttling inside the loop
// would jam every box to the ceiling chasing an unreachable target); the
// throttle is applied once, on the final build. buildSepDemandBoxWarp
// composes the separable warp (global magnification) under the demand warp
// (local room), finding boxes and measuring demand in separable-warped space.
// Determinism: + − × ÷ √ min max only → bit-identical cross-V8.

import { envNum, envStr } from '../../env';
import { probeDensity, probeBoxes, debugBoxWarp } from './debug/densityBoxWarp.debug';
import type { Pixel } from './types';
import type { WarpBox, WarpFn, DensityWarpOptions } from './densityWarp';
import { densityGrid2D } from './densityWarp2d';
import { buildDensityWarp } from './densityWarp';

export interface DenseBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The projected transit graph, for the contraction oracle: node positions in
 *  the warp's INPUT pixel space plus edges as index pairs into `nodes`. */
export interface BoxGraph {
  nodes: readonly Pixel[];
  edges: readonly [number, number][];
}

const edgeLen = (g: BoxGraph, a: number, b: number): number => {
  const dx = g.nodes[a][0] - g.nodes[b][0];
  const dy = g.nodes[a][1] - g.nodes[b][1];
  return Math.sqrt(dx * dx + dy * dy); // sqrt is correctly-rounded (cross-V8 safe)
};

/** Median projected edge length (0 when the graph has no edges). */
export function medianEdgeLenPx(g: BoxGraph): number {
  const ls = g.edges.map(([a, b]) => edgeLen(g, a, b)).sort((x, y) => x - y);
  return ls.length ? ls[ls.length >> 1] : 0;
}

/** Mean incident-edge length per node (Infinity for isolated nodes) — the same
 *  "neighbour gap" statistic renderGeographic uses for warp weights. */
// used by buildDemandBoxWarp
function nodeGaps(g: BoxGraph): number[] {
  const sum = new Float64Array(g.nodes.length);
  const cnt = new Float64Array(g.nodes.length);
  for (const [a, b] of g.edges) {
    const l = edgeLen(g, a, b);
    sum[a] += l; cnt[a]++;
    sum[b] += l; cnt[b]++;
  }
  return [...sum].map((s, i) => (cnt[i] ? s / cnt[i] : Infinity));
}

/** Contraction oracle: cluster nodes joined by edges shorter than `threshold`
 *  (the predicted octi contraction length ĉ/2 × safety) via union-find, and
 *  bound each cluster of >= 2 nodes, padded by threshold/2 per side so the
 *  expansion push has extent even for collinear pairs. Catches small pinned
 *  clusters (JFK's 8px terminals) that are invisible to fraction-of-peak
 *  density.
 *
 *  LOCALITY BOUND: a component whose bbox exceeds `maxSpan` (default
 *  6 × threshold, derived, I7) is not one pinned cluster: transitive
 *  chaining over consecutive short edges can span a whole borough, and a
 *  borough-scale box's demand statistic is then dominated by its tightest
 *  pairs, pricing a giant expansion for a local problem. Oversized
 *  components decompose into one padded box PER SHORT EDGE; the clip-apart
 *  merge de-overlaps them (and its heavy-overlap rule re-unions genuinely
 *  shared spots), so survival demand stays local and honest.
 *  Deterministic: plain array iteration + arithmetic. */
export function findContractionBoxes(g: BoxGraph, threshold: number, maxSpan?: number): DenseBox[] {
  const span = maxSpan ?? threshold * 6;
  const parent = g.nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const touched = new Uint8Array(g.nodes.length);
  const shortEdges: [number, number][] = [];
  for (const [a, b] of g.edges) {
    if (edgeLen(g, a, b) >= threshold) continue;
    shortEdges.push([a, b]);
    touched[a] = 1;
    touched[b] = 1;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }
  const byRoot = new Map<number, DenseBox & { n: number }>();
  for (let i = 0; i < g.nodes.length; i++) {
    if (!touched[i]) continue;
    const r = find(i);
    const p = g.nodes[i];
    const cur = byRoot.get(r);
    if (!cur) byRoot.set(r, { x0: p[0], y0: p[1], x1: p[0], y1: p[1], n: 1 });
    else {
      if (p[0] < cur.x0) cur.x0 = p[0];
      if (p[0] > cur.x1) cur.x1 = p[0];
      if (p[1] < cur.y0) cur.y0 = p[1];
      if (p[1] > cur.y1) cur.y1 = p[1];
      cur.n++;
    }
  }
  const pad = threshold / 2;
  const boxes: DenseBox[] = [];
  const oversized = new Set<number>();
  for (const [root, b] of byRoot) {
    if (b.n < 2) continue;
    if (b.x1 - b.x0 > span || b.y1 - b.y0 > span) { oversized.add(root); continue; }
    boxes.push({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad });
  }
  if (oversized.size) {
    for (const [a, b] of shortEdges) {
      if (!oversized.has(find(a))) continue;
      const pa = g.nodes[a], pb = g.nodes[b];
      boxes.push({
        x0: Math.min(pa[0], pb[0]) - pad, y0: Math.min(pa[1], pb[1]) - pad,
        x1: Math.max(pa[0], pb[0]) + pad, y1: Math.max(pa[1], pb[1]) + pad,
      });
    }
  }
  return boxes;
}

/** Merge intersecting boxes to their union bbox, repeated to a fixpoint, so the
 *  summed per-axis pushes never double-stack on overlapping regions (density
 *  boxes and contraction boxes can overlap). Deterministic: fixed scan order. */
export function mergeIntersectingBoxes(boxes: DenseBox[]): DenseBox[] {
  const out = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          out[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          };
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  return out;
}

export type BoxKind = 'density' | 'contraction' | 'capsule' | 'corridor';
/** A pairwise spacing requirement: the warped distance between nodes a,b must
 *  reach `required` px (capsule separation — CONSTANT under the warp, unlike
 *  the octi contraction threshold, which moves as the map stretches). */
export interface PairTarget { a: number; b: number; required: number }
/** A warp box with its oracle kind and extra spacing targets. Every box also
 *  implicitly carries the octi-contraction floor (inside-edge median ≥
 *  ĉ/2·slack) in the refinement — `pairs` ADD capsule-scale requirements. */
export interface DemandBox extends DenseBox {
  kind: BoxKind;
  pairs: PairTarget[];
  /** Normalized density (density boxes only): linear in the map's own range
   *  between the discovery cutoff (0) and the peak (1). The aesthetic demand
   *  term is `1 + (userMult - 1) * aes`; survival demand ignores it. */
  aes?: number;
}

export interface CapsuleOracleOptions {
  /** Marker lane pitch in px (LINE_WIDTH + LINE_GAP at the call site). */
  spacing: number;
  /** Per-capsule slack beyond the marker row, px. Default 4. */
  margin?: number;
  /** Inter-capsule clearance (casing + breathing room), px. Default 8. */
  casing?: number;
}

/** Capsule-demand oracle: stations whose MARKER ROWS cannot both fit in the
 *  space between them. Per node, the capsule half-length is
 *  (lineCount−1)·spacing/2 + margin (a 1-line node is a plain dot — excluded).
 *  Pairs are found by SPATIAL proximity (bucket grid), NOT graph adjacency —
 *  capsule collisions don't require a shared edge (SEA mn89×mn461). Flagged
 *  pairs union-find into clusters → one box per cluster carrying ALL its
 *  violating pairs as targets. Deterministic: index-ordered scans, integer
 *  bucket keys iterated per node (not per Map order). */
export function findCapsuleBoxes(
  g: BoxGraph,
  lineCounts: readonly number[],
  o: CapsuleOracleOptions,
): DemandBox[] {
  const margin = o.margin ?? 4;
  const casing = o.casing ?? 8;
  const need = (i: number): number => {
    const lc = lineCounts[i] ?? 1;
    return lc >= 2 ? ((lc - 1) * o.spacing) / 2 + margin : 0;
  };
  const idx: number[] = [];
  let maxNeed = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    const n = need(i);
    if (n > 0) { idx.push(i); if (n > maxNeed) maxNeed = n; }
  }
  if (idx.length < 2) return [];
  // bucket grid at the largest possible pair threshold so any violating pair
  // sits in the same or an adjacent cell
  const cell = 2 * maxNeed + casing;
  const key = (x: number, y: number): string => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  const buckets = new Map<string, number[]>();
  for (const i of idx) {
    const k = key(g.nodes[i][0], g.nodes[i][1]);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }
  const parent = new Map<number, number>(idx.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(i) !== i) { const nx = parent.get(i)!; parent.set(i, root); i = nx; }
    return root;
  };
  const pairs: PairTarget[] = [];
  for (const i of idx) {
    const [ix, iy] = g.nodes[i];
    const cx = Math.floor(ix / cell);
    const cy = Math.floor(iy / cell);
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const arr = buckets.get(cx + ox + ',' + (cy + oy));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue; // each pair once, index-ordered → deterministic
          const dx = ix - g.nodes[j][0];
          const dy = iy - g.nodes[j][1];
          const required = need(i) + need(j) + casing;
          if (Math.sqrt(dx * dx + dy * dy) >= required) continue;
          pairs.push({ a: i, b: j, required });
          const ra = find(i), rb = find(j);
          if (ra !== rb) parent.set(rb, ra);
        }
      }
  }
  if (pairs.length === 0) return [];
  const byRoot = new Map<number, { x0: number; y0: number; x1: number; y1: number; pairs: PairTarget[]; pad: number }>();
  for (const t of pairs) {
    const r = find(t.a);
    let e = byRoot.get(r);
    if (!e) { e = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, pairs: [], pad: 0 }; byRoot.set(r, e); }
    for (const n of [t.a, t.b]) {
      const p = g.nodes[n];
      if (p[0] < e.x0) e.x0 = p[0];
      if (p[0] > e.x1) e.x1 = p[0];
      if (p[1] < e.y0) e.y0 = p[1];
      if (p[1] > e.y1) e.y1 = p[1];
      if (need(n) > e.pad) e.pad = need(n);
    }
    e.pairs.push(t);
  }
  // LOCALITY BOUND (mirrors findContractionBoxes): transitive pair chaining
  // can span a borough; a borough-scale capsule box then prices its whole
  // region by its tightest pair. Components wider than a few pair thresholds
  // decompose into one padded box PER VIOLATING PAIR; the clip-apart merge
  // de-overlaps them and re-unions the genuinely shared spots.
  const maxSpan = 4 * cell;
  const out: DemandBox[] = [];
  for (const e of byRoot.values()) {
    if (e.x1 - e.x0 <= maxSpan && e.y1 - e.y0 <= maxSpan) {
      out.push({ x0: e.x0 - e.pad, y0: e.y0 - e.pad, x1: e.x1 + e.pad, y1: e.y1 + e.pad, kind: 'capsule', pairs: e.pairs });
      continue;
    }
    for (const t of e.pairs) {
      const pa = g.nodes[t.a], pb = g.nodes[t.b];
      const pad = Math.max(need(t.a), need(t.b));
      out.push({
        x0: Math.min(pa[0], pb[0]) - pad, y0: Math.min(pa[1], pb[1]) - pad,
        x1: Math.max(pa[0], pb[0]) + pad, y1: Math.max(pa[1], pb[1]) + pad,
        kind: 'capsule', pairs: [t],
      });
    }
  }
  return out;
}

export interface CorridorOracleOptions {
  /** Drawn lane pitch in px (LINE_WIDTH + LINE_GAP at the call site). */
  spacing: number;
  /** Clearance beyond the two painted half widths, px. Default one pitch. */
  margin?: number;
  /** Ignore passes closer than this: near-coincident corridors get welded or
   *  contracted into ONE drawn corridor downstream, so demanding painted
   *  clearance between them is over-demand. Supplied by the build (the
   *  contraction threshold); default 0. */
  minDist?: number;
  /** Ignore pairs whose requirement is at most this: the octi grid separates
   *  distinct corridors by at least one cell, so only paint that outgrows a
   *  cell step is a real squeeze. Supplied by the build (the cell estimate
   *  with headroom); default 0. */
  minReq?: number;
}

/** Corridor-clearance oracle: a node whose corridor passes ALONGSIDE another
 *  corridor closer than their combined painted half widths. Lines are
 *  zero-width to the layout, but a bundle paints (lineCount-1)/2 lanes to each
 *  side of its centerline; where a neighbouring corridor's clearance is
 *  smaller than that, the drawn lanes ride through the neighbour's ink.
 *  Flags (node, segment) pairs: the node's perpendicular foot must fall on the
 *  segment INTERIOR (a genuine flank pass), and graph-adjacent geometry is
 *  excluded (corridors that MEET at a node are a junction, not a squeeze).
 *  Each hit becomes a pair target against the segment's nearer endpoint, with
 *  the requirement scaled by the diagonal-to-perpendicular ratio so lifting
 *  the node pair to the target lifts the true clearance to what the paint
 *  needs. Deterministic: index-ordered scans, plain arithmetic. */
export function findCorridorBoxes(
  g: BoxGraph,
  edgeLines: readonly (readonly string[])[],
  o: CorridorOracleOptions,
): DemandBox[] {
  const margin = o.margin ?? o.spacing;
  const minDist = o.minDist ?? 0;
  const minReq = o.minReq ?? 0;
  const halfW = (ei: number): number => {
    const lc = edgeLines[ei]?.length ?? 1;
    return lc >= 2 ? ((lc - 1) * o.spacing) / 2 : 0;
  };
  // Per-node adjacency, widest incident half width, and the union of lines
  // through the node (a corridor that SHARES a line with the edge is the same
  // service: it merges or interlines downstream, never a foreign squeeze).
  const adj = new Map<number, Set<number>>();
  const nodeHalfW = new Array<number>(g.nodes.length).fill(0);
  const nodeLines: Array<Set<string> | undefined> = new Array(g.nodes.length);
  for (let ei = 0; ei < g.edges.length; ei++) {
    const [a, b] = g.edges[ei];
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
    const w = halfW(ei);
    if (w > nodeHalfW[a]) nodeHalfW[a] = w;
    if (w > nodeHalfW[b]) nodeHalfW[b] = w;
    for (const n of [a, b]) {
      let s = nodeLines[n];
      if (!s) nodeLines[n] = s = new Set();
      for (const l of edgeLines[ei] ?? []) s.add(l);
    }
  }
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(i) !== i) { const nx = parent.get(i)!; parent.set(i, root); i = nx; }
    return root;
  };
  const ensure = (i: number): void => { if (!parent.has(i)) parent.set(i, i); };
  let maxNodeHalfW = 0;
  for (const w of nodeHalfW) if (w > maxNodeHalfW) maxNodeHalfW = w;
  const pairs: PairTarget[] = [];
  const padOf = new Map<number, number>(); // node -> widest requirement seen
  for (let ei = 0; ei < g.edges.length; ei++) {
    const [a, b] = g.edges[ei];
    const pa = g.nodes[a];
    const pb = g.nodes[b];
    const vx = pb[0] - pa[0];
    const vy = pb[1] - pa[1];
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-9) continue;
    const wE = halfW(ei);
    const adjA = adj.get(a)!;
    const adjB = adj.get(b)!;
    // Segment AABB inflated by the largest requirement this edge can make.
    const maxReq = wE + maxNodeHalfW + margin;
    if (wE + maxNodeHalfW <= 0) continue; // both sides zero-width everywhere
    const x0 = Math.min(pa[0], pb[0]) - maxReq;
    const x1 = Math.max(pa[0], pb[0]) + maxReq;
    const y0 = Math.min(pa[1], pb[1]) - maxReq;
    const y1 = Math.max(pa[1], pb[1]) + maxReq;
    const linesE = edgeLines[ei] ?? [];
    for (let u = 0; u < g.nodes.length; u++) {
      if (u === a || u === b) continue;
      if (adjA.has(u) || adjB.has(u)) continue; // meets this corridor at a junction
      const req = wE + nodeHalfW[u] + margin;
      if (req <= margin) continue; // neither side paints beyond a single lane
      if (req <= minReq) continue; // a one-cell grid step absorbs this pair
      const p = g.nodes[u];
      if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      const uLines = nodeLines[u];
      if (uLines) {
        let shared = false;
        for (const l of linesE) { if (uLines.has(l)) { shared = true; break; } }
        if (shared) continue; // same service: merges or interlines, not a squeeze
      }
      const t = ((p[0] - pa[0]) * vx + (p[1] - pa[1]) * vy) / len2;
      if (t < 0.15 || t > 0.85) continue; // endpoint zone: junction/contraction territory
      const fx = pa[0] + vx * t;
      const fy = pa[1] + vy * t;
      const d = Math.sqrt((p[0] - fx) ** 2 + (p[1] - fy) ** 2);
      if (d < minDist || d < 1e-9 || d >= req) continue;
      const v = t < 0.5 ? a : b;
      const pv = g.nodes[v];
      const duv = Math.sqrt((p[0] - pv[0]) ** 2 + (p[1] - pv[1]) ** 2);
      if (duv < 1e-9) continue;
      // Lift the node pair so the same scale lifts the perpendicular
      // clearance d to req.
      pairs.push({ a: Math.min(u, v), b: Math.max(u, v), required: duv * (req / d) });
      ensure(u); ensure(v);
      const ru = find(u), rv = find(v);
      if (ru !== rv) parent.set(rv, ru);
      if (req > (padOf.get(u) ?? 0)) padOf.set(u, req);
      if (req > (padOf.get(v) ?? 0)) padOf.set(v, req);
    }
  }
  if (pairs.length === 0) return [];
  const byRoot = new Map<number, { x0: number; y0: number; x1: number; y1: number; pairs: PairTarget[]; pad: number }>();
  for (const t of pairs) {
    const r = find(t.a);
    let e = byRoot.get(r);
    if (!e) { e = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, pairs: [], pad: 0 }; byRoot.set(r, e); }
    for (const n of [t.a, t.b]) {
      const p = g.nodes[n];
      if (p[0] < e.x0) e.x0 = p[0];
      if (p[0] > e.x1) e.x1 = p[0];
      if (p[1] < e.y0) e.y0 = p[1];
      if (p[1] > e.y1) e.y1 = p[1];
      const pad = padOf.get(n) ?? 0;
      if (pad > e.pad) e.pad = pad;
    }
    e.pairs.push(t);
  }
  const out: DemandBox[] = [];
  for (const e of byRoot.values()) {
    out.push({ x0: e.x0 - e.pad, y0: e.y0 - e.pad, x1: e.x1 + e.pad, y1: e.y1 + e.pad, kind: 'corridor', pairs: e.pairs });
  }
  return out;
}

/** Crowd anisotropy of a box: WHICH AXIS is actually crowded, read off the
 *  nearest-neighbour displacement of every node inside the box. If your
 *  nearest neighbour sits BESIDE you (horizontal displacement), horizontal
 *  room is what separates you. Parallel trunks a fixed pitch apart read
 *  crowded across that pitch, a pinned pair reads crowded along its own
 *  displacement, and a mixed cluster reads neutral. One statistic serves all
 *  three demand kinds because growth must always happen ALONG the displacement
 *  of the pairs that lack room. Contributions are weighted by inverse distance,
 *  floored at 1px so a coincident-ish pair can't hijack the whole box, so the
 *  tightest pairs steer the direction the same way they dominate the demand.
 *  Returns r ∈ [0,1]: the fraction of the box's expansion that belongs on the
 *  X axis (0.5 = isotropic). Deterministic: fixed index order, + − × ÷ √ min
 *  max only. O(n²) per box, run once per build. Boxes hold at most a few
 *  hundred nodes. */
export function boxCrowdAnisotropy(b: DenseBox, g: BoxGraph): number {
  const idx: number[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    const p = g.nodes[i];
    if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1) idx.push(i);
  }
  const { wx, wy } = nnDirWeights(idx, g, dirContext(g));
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < idx.length; k++) { sx += wx[k]; sy += wy[k]; }
  const tot = sx + sy;
  return tot > 0 ? sx / tot : 0.5;
}

/** Whole-graph context for the crowding-direction search: edge adjacency as
 *  integer keys (a·N+b both ways) plus each node's CORRIDOR direction. That
 *  direction is the length-weighted, sign-normalized mean of its incident edge
 *  directions (unit vector; hasDir=0 for isolated nodes). */
interface DirContext { N: number; adj: Set<number>; cx: Float64Array; cy: Float64Array; hasDir: Uint8Array }
function dirContext(g: BoxGraph): DirContext {
  const N = g.nodes.length;
  const adj = new Set<number>();
  const cx = new Float64Array(N);
  const cy = new Float64Array(N);
  const hasDir = new Uint8Array(N);
  for (const [a, b] of g.edges) {
    adj.add(a * N + b);
    adj.add(b * N + a);
    let dx = g.nodes[b][0] - g.nodes[a][0];
    let dy = g.nodes[b][1] - g.nodes[a][1];
    // sign-normalize to the upper half-plane so opposite-direction incident
    // edges (the usual straight-through corridor) reinforce instead of cancel
    if (dy < 0 || (dy === 0 && dx < 0)) { dx = -dx; dy = -dy; }
    cx[a] += dx; cy[a] += dy;
    cx[b] += dx; cy[b] += dy;
  }
  for (let i = 0; i < N; i++) {
    const l = Math.sqrt(cx[i] * cx[i] + cy[i] * cy[i]);
    if (l > 0) { cx[i] /= l; cy[i] /= l; hasDir[i] = 1; }
  }
  return { N, adj, cx, cy, hasDir };
}

/** How parallel a displacement may be to the node's corridor before it stops
 *  counting as crowding: |cos| above this (≈ ±32°) means "down my own
 *  corridor". */
const CORRIDOR_COS = 0.85;

/** Per-node crowding-direction weights over the node set `idx`: each node's
 *  nearest OFF-CORRIDOR neighbour (within `idx`) displacement, decomposed per
 *  axis and inverse-distance weighted (floored at 1px). Two exclusions define
 *  "off-corridor". Graph-adjacent neighbours are skipped because an edge owns
 *  its own gap, which octi's contraction machinery manages between consecutive
 *  stations. Neighbours whose displacement lies along the node's corridor
 *  direction are skipped too: an any-hop same-line node (a trunk's 2-hop stop)
 *  can be nearer than the parallel line and would mask it, and along-corridor
 *  room is octi's job, not the warp's. What remains is exactly the crowding
 *  only ROOM can fix: parallel trunk lines a fixed pitch apart, colliding
 *  interchange rows, brushing corridors. Shared by boxCrowdAnisotropy
 *  (sum → one r) and splitMixedBoxes (per-node, so a candidate cut is scored in
 *  the PARENT's context; re-measuring a half in isolation lets the cut amputate
 *  a node's true neighbours and flip its direction reading). */
function nnDirWeights(idx: readonly number[], g: BoxGraph, ctx: DirContext): { wx: Float64Array; wy: Float64Array } {
  const { N, adj, cx, cy, hasDir } = ctx;
  const wx = new Float64Array(idx.length);
  const wy = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const pi = g.nodes[i];
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (const j of idx) {
      if (j === i || adj.has(i * N + j)) continue;
      const dx = g.nodes[j][0] - pi[0];
      const dy = g.nodes[j][1] - pi[1];
      const d2 = dx * dx + dy * dy;
      if (d2 >= best || !(d2 > 0)) continue;
      if (hasDir[i]) {
        const dot = dx * cx[i] + dy * cy[i];
        if (dot * dot > CORRIDOR_COS * CORRIDOR_COS * d2) continue; // down my own corridor
      }
      best = d2; bx = dx; by = dy;
    }
    if (!Number.isFinite(best)) continue; // no off-corridor neighbour
    const w = 1 / Math.max(1, Math.sqrt(best));
    wx[k] = (w * bx * bx) / best; // neighbour beside me → x is the crowded axis
    wy[k] = (w * by * by) / best;
  }
  return { wx, wy };
}

/** Overlap resolution WITHOUT union growth (spec 2026-07-18): a box never
 *  grows by merging, so the chain reactions that used to build map-core mega
 *  boxes (dozens of padded boxlets bbox-unioning into one) are structurally
 *  impossible. Rules, in order:
 *  - CONTAINMENT across kinds NESTS: both survive (the inner push adds a
 *    rigid translation to the outer far field; summed pushes stay monotone).
 *  - Same-kind overlap covering at least HALF the smaller box unions as
 *    genuinely-the-same-region (bounded growth: no chaining, since the union
 *    of a >=50%-overlapping pair stays comparable to the larger box).
 *  - Every other overlap CLIPS the lower-precedence box out of the overlap
 *    along its axis of least area loss (kind precedence capsule > contraction
 *    > density; equal precedence: the smaller box yields). Boxes end
 *    DISJOINT, so partial pushes never double-stack. A clip whose remainder
 *    is a sub-pixel sliver drops the box and migrates its pair targets to
 *    the box that clipped it.
 *  Input is canonically pre-sorted, so the fixpoint result is independent of
 *  the callers' assembly order. Deterministic scan; arithmetic only. */
export function mergeDemandBoxes(boxes: DemandBox[]): DemandBox[] {
  const rank: Record<BoxKind, number> = { density: 0, contraction: 1, capsule: 2, corridor: 3 };
  const area = (b: DemandBox): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const out = boxes
    .map((b) => ({ ...b, pairs: [...b.pairs] }))
    .sort((a, b) =>
      (rank[b.kind] - rank[a.kind]) || (area(b) - area(a)) ||
      (a.x0 - b.x0) || (a.y0 - b.y0) || (a.x1 - b.x1) || (a.y1 - b.y1));
  const MIN_EXTENT = 1; // px: a thinner clip remainder is a sliver, not a box
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 1e-6 || oy <= 1e-6) continue; // disjoint (touching edges are fine)
        const aInB = a.x0 >= b.x0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.y0 >= b.y0 - 1e-6 && a.y1 <= b.y1 + 1e-6;
        const bInA = b.x0 >= a.x0 - 1e-6 && b.x1 <= a.x1 + 1e-6 && b.y0 >= a.y0 - 1e-6 && b.y1 <= a.y1 + 1e-6;
        if (a.kind !== b.kind && (aInB || bInA)) continue; // nest
        const small = area(a) <= area(b) ? a : b;
        // Same-region union: heavy overlap AND a union bbox no bigger than
        // the pair's combined footprint. The area bound stops 2D chaining
        // (a big box strip-overlapping a boxlet unions with corner waste and
        // is rejected into a clip), while collinear corridor runs — whose
        // union is waste-free — still coalesce into one coherent box.
        const ux0 = Math.min(a.x0, b.x0), uy0 = Math.min(a.y0, b.y0);
        const ux1 = Math.max(a.x1, b.x1), uy1 = Math.max(a.y1, b.y1);
        const unionArea = (ux1 - ux0) * (uy1 - uy0);
        if (a.kind === b.kind && (aInB || bInA ||
            (ox * oy >= 0.5 * area(small) && unionArea <= area(a) + area(b)))) {
          const aes = Math.max(a.aes ?? 0, b.aes ?? 0);
          out[i] = {
            ...a,
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
            pairs: [...a.pairs, ...b.pairs],
            ...(aes > 0 ? { aes } : {}),
          };
          out.splice(j, 1);
          changed = true;
          break outer;
        }
        // clip the loser out of the overlap
        const loserIsA =
          rank[a.kind] !== rank[b.kind] ? rank[a.kind] < rank[b.kind]
          : area(a) !== area(b) ? area(a) < area(b)
          : false; // tie: the later scan position (j) yields
        const loser = loserIsA ? a : b;
        const winner = loserIsA ? b : a;
        // candidate clips: slide one loser edge to the winner's boundary;
        // keep the remainder with the most area
        let bx0 = loser.x0, by0 = loser.y0, bx1 = loser.x1, by1 = loser.y1;
        let bestA = -1;
        const consider = (x0: number, y0: number, x1: number, y1: number) => {
          const ca = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
          if (ca > bestA) { bestA = ca; bx0 = x0; by0 = y0; bx1 = x1; by1 = y1; }
        };
        if (loser.x0 < winner.x0) consider(loser.x0, loser.y0, winner.x0, loser.y1);
        if (loser.x1 > winner.x1) consider(winner.x1, loser.y0, loser.x1, loser.y1);
        if (loser.y0 < winner.y0) consider(loser.x0, loser.y0, loser.x1, winner.y0);
        if (loser.y1 > winner.y1) consider(loser.x0, winner.y1, loser.x1, loser.y1);
        if (bestA < 0 || bx1 - bx0 < MIN_EXTENT || by1 - by0 < MIN_EXTENT) {
          winner.pairs.push(...loser.pairs);
          out.splice(out.indexOf(loser), 1);
        } else {
          loser.x0 = bx0; loser.y0 = by0; loser.x1 = bx1; loser.y1 = by1;
        }
        changed = true;
        break outer;
      }
  }
  return out;
}

/** Split direction-MIXED boxes into direction-coherent sub-boxes, recursively.
 *  A single per-box direction cannot serve a box that covers both vertical and
 *  horizontal trunks, because their crowd anisotropies cancel to neutral (~0.5)
 *  under any pair weighting. So: try cutting the box at the median inside-node
 *  coordinate on each axis; keep the cut whose halves DISAGREE most in
 *  anisotropy (a variance-reduction split), tighten each half to its own nodes
 *  (padded, clipped to its side of the cut so halves stay disjoint and summed
 *  pushes never double-stack), and recurse. A direction-coherent box never
 *  splits (gain below MIN_GAIN), so maps without mixed regions are untouched.
 *  Splitting also localizes the DEMAND solve: a region-spanning box holds most
 *  of the graph, so expanding it drags the global median (and with it the
 *  contraction threshold) up nearly 1:1 and the secant rightly jumps to the
 *  ceiling, whereas sub-boxes each hold a small share and converge. A cut that
 *  would separate a capsule pair's endpoints is vetoed (the pair's separation
 *  push must come from ONE box); surviving pairs land in the half that contains
 *  both endpoints. Deterministic: median cuts, fixed axis order, fixed
 *  thresholds. */
export function splitMixedBoxes(boxes: DemandBox[], g: BoxGraph, pad: number): DemandBox[] {
  const adj = dirContext(g);
  const MIN_NODES = 24; // don't split small clusters — their direction is already coherent-ish
  const MIN_HALF = 8;   // each half must keep a meaningful direction sample
  const MIN_GAIN = 0.2; // halves must disagree by at least this much in r
  const MAX_DEPTH = 3;  // ≤ 8 sub-boxes per parent
  const inside = (b: DenseBox): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < g.nodes.length; i++) {
      const p = g.nodes[i];
      if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1) idx.push(i);
    }
    return idx;
  };
  // bbox of `idx` + pad, clipped to `clip` — the tightened half-box
  const tighten = (idx: number[], clip: DenseBox): DenseBox => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of idx) {
      const p = g.nodes[i];
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return {
      x0: Math.max(clip.x0, x0 - pad), y0: Math.max(clip.y0, y0 - pad),
      x1: Math.min(clip.x1, x1 + pad), y1: Math.min(clip.y1, y1 + pad),
    };
  };
  const out: DemandBox[] = [];
  const rec = (b: DemandBox, depth: number): void => {
    let idx = inside(b);
    // Tighten every box to its own nodes first (density boxes come smeared by
    // the grid smoothing): a directional push must hug the nodes that voted
    // for its direction, or its band overhangs a neighbouring region and
    // stretches it on the wrong axis. Shrinking never creates overlap.
    if (depth === 0 && idx.length >= 2) {
      const t = tighten(idx, b);
      if (t.x0 !== b.x0 || t.y0 !== b.y0 || t.x1 !== b.x1 || t.y1 !== b.y1) {
        b = { ...b, ...t };
        idx = inside(b);
      }
    }
    if (depth >= MAX_DEPTH || idx.length < MIN_NODES) { out.push(b); return; }
    // Per-node direction weights in the PARENT context, fixed across all
    // candidate cuts: a half is scored by aggregating its members' weights,
    // never by re-measuring the half in isolation (a cut that slices off one
    // trunk line would amputate its across-line neighbours and flip its
    // reading to along-line — a huge but bogus gain).
    const { wx, wy } = nnDirWeights(idx, g, adj);
    const rOf = (member: (i: number) => boolean): number => {
      let sx = 0;
      let sy = 0;
      for (let k = 0; k < idx.length; k++) if (member(idx[k])) { sx += wx[k]; sy += wy[k]; }
      const tot = sx + sy;
      return tot > 0 ? sx / tot : 0.5;
    };
    let bestGain = MIN_GAIN;
    let best: { a: DemandBox; c: DemandBox } | null = null;
    for (const axis of [0, 1] as const) {
      const coords = idx.map((i) => g.nodes[i][axis]).sort((x, y) => x - y);
      // Candidate cuts at every 5% node-count quantile — direction blocks can
      // be small (NYC's x-crowded Manhattan trunk band is ~18% of the mega
      // box's nodes) and a coarse grid never lands a cut on their boundary;
      // any half containing the block plus its neighbouring opposite-direction
      // band reads neutral and the gain vanishes. Scoring a cut is O(n) over
      // precomputed weights, so the dense scan is cheap.
      for (let q = 1; q <= 19; q++) {
        const f = q / 20;
        const cut = coords[Math.floor(f * coords.length)];
        const A = idx.filter((i) => g.nodes[i][axis] < cut);
        const C = idx.filter((i) => g.nodes[i][axis] >= cut);
        if (A.length < MIN_HALF || C.length < MIN_HALF) continue;
        const gain = Math.abs(rOf((i) => g.nodes[i][axis] < cut) - rOf((i) => g.nodes[i][axis] >= cut));
        if (gain > bestGain) {
          bestGain = gain;
          const clipA: DenseBox = axis === 0 ? { ...b, x1: cut } : { ...b, y1: cut };
          const clipC: DenseBox = axis === 0 ? { ...b, x0: cut } : { ...b, y0: cut };
          // A pair follows any half holding one of its endpoints — a straddling
          // pair lands in BOTH (each box's push still stretches the interval
          // between the endpoints; the secant re-measures the true distance
          // each pass, so double-serving converges, it doesn't double-count).
          const aSide = (t: PairTarget): boolean => g.nodes[t.a][axis] < cut || g.nodes[t.b][axis] < cut;
          const cSide = (t: PairTarget): boolean => g.nodes[t.a][axis] >= cut || g.nodes[t.b][axis] >= cut;
          best = {
            a: { ...tighten(A, clipA), kind: b.kind, pairs: b.pairs.filter(aSide) },
            c: { ...tighten(C, clipC), kind: b.kind, pairs: b.pairs.filter(cSide) },
          };
        }
      }
    }
    if (!best) {
      // Hierarchical density decomposition — the fallback for BIG boxes where
      // no straight cut clears the direction bar. The NYC midtown+Brooklyn+
      // Queens remainder is radially interleaved (vertical, diagonal and
      // horizontal trunks all fan out from the East River crossings), so
      // every quantile cut leaves both halves neutral — but the density
      // surface still separates it: the rivers are valleys. Re-threshold the
      // box's own nodes at a rising cutoff ladder until the region falls
      // apart into ≥ 2 cores, box each core, and recurse (direction cuts get
      // a second chance INSIDE each core). Halo nodes between cores (bridge
      // spans over water) stay unboxed — long crossing edges carry no
      // contraction demand. Gated on node count so small clusters and other
      // cities' modest boxes never shatter. Deterministic: fixed ladder,
      // fixed grid, component scan order.
      // Only rescue direction-MIXED boxes (r near neutral): a coherent box
      // that found no internal cut is already well-served whole — shattering
      // it into cores just weakens its push and multiplies secant states.
      const DECOMP_MIN = 96;
      const rWhole = rOf(() => true);
      if (idx.length >= DECOMP_MIN && depth < MAX_DEPTH && Math.abs(rWhole - 0.5) < 0.15) {
        const pts = idx.map((i) => g.nodes[i]);
        const wb = { minX: b.x0, minY: b.y0, maxX: b.x1, maxY: b.y1 };
        for (const f of [0.45, 0.55, 0.65]) {
          // Components of a radial fan can have INTERLOCKING bounding boxes
          // even when their cell sets are disjoint. A box regrown over a
          // neighbour's nodes double-stacks pushes. Pad, merge overlaps back
          // together, THEN tighten; accept only ≥ 2 disjoint cores that are
          // each strictly smaller than the parent (real progress).
          const padded = findDenseBoxes(pts, wb, { bins: 48, frac: f }).map((cb) => ({
            x0: Math.max(b.x0, cb.x0 - pad), y0: Math.max(b.y0, cb.y0 - pad),
            x1: Math.min(b.x1, cb.x1 + pad), y1: Math.min(b.y1, cb.y1 + pad),
          }));
          const cores = mergeIntersectingBoxes(padded)
            .map((cb) => tighten(inside(cb), cb))
            .filter((cb) => {
              const n = inside(cb).length;
              return n >= MIN_HALF && n < idx.length;
            });
          if (cores.length < 2) continue;
          // pairs: a core holding an endpoint takes the pair. Its push
          // stretches the interval even when the other endpoint sits outside,
          // by the same argument as straddling cut-pairs. A pair NO core
          // touches gets its own small dedicated box, recreating the capsule
          // box the bbox-union merge swallowed, rather than expanding a core
          // over the halo. Expansion regrows cores over each other, and
          // recursion then re-decomposes the overlap into a pile of
          // double-stacked near-copies.
          const children: DemandBox[] = cores.map((cb) => ({ ...cb, kind: b.kind, pairs: [], ...(b.aes !== undefined ? { aes: b.aes } : {}) }));
          const orphans: DemandBox[] = [];
          for (const t of b.pairs) {
            const pa = g.nodes[t.a], pb = g.nodes[t.b];
            const holds = children.filter((c) =>
              (pa[0] >= c.x0 && pa[0] <= c.x1 && pa[1] >= c.y0 && pa[1] <= c.y1) ||
              (pb[0] >= c.x0 && pb[0] <= c.x1 && pb[1] >= c.y0 && pb[1] <= c.y1));
            if (holds.length) for (const c of holds) c.pairs.push(t);
            else orphans.push({
              x0: Math.max(b.x0, Math.min(pa[0], pb[0]) - pad),
              y0: Math.max(b.y0, Math.min(pa[1], pb[1]) - pad),
              x1: Math.min(b.x1, Math.max(pa[0], pb[0]) + pad),
              y1: Math.min(b.y1, Math.max(pa[1], pb[1]) + pad),
              kind: b.kind, pairs: [t],
            });
          }
          // overlapping orphan boxes would double-stack, so union them
          for (const ob of mergeDemandBoxes(orphans)) out.push(ob);
          for (const c of children) rec(c, depth + 1);
          return;
        }
      }
      out.push(b);
      return;
    }
    rec(best.a, depth + 1);
    rec(best.c, depth + 1);
  };
  for (const b of boxes) rec(b, 0);
  return out;
}

// (DemandOptions, below, extends the same option bag densityGrid2D reads.)
type DensityWarp2DOptionsLike = DensityWarpOptions & { sigmaPx?: number };

/** Options `findDenseBoxes` reads out of the (larger) `DemandOptions` bag it's
 *  normally called with. Kept as its own alias so callers that only want the
 *  density oracle (no graph, no demand) can pass a minimal bag. */
type FindDenseBoxesOptions = DensityWarp2DOptionsLike & {
  /** Cutoff as a fraction of the PEAK excess density (0–1): cells above
   *  frac·max are "dense". Threshold on the peak, NOT a percentile over all
   *  cells. Most cells are empty, so a global percentile collapses to "above
   *  average" and grabs the whole halo. Higher frac = tighter core. Default 0.4. */
  frac?: number;
};

/** Find the densest regions as axis-aligned bounding boxes (pixel coords):
 *  threshold the smoothed excess-density grid at the cutoff (frac of peak),
 *  then bound each 4-connected component of above-cutoff cells. Each box
 *  carries `d`, its mean excess normalized LINEARLY between the cutoff and
 *  the map's peak (0 = at the cutoff, 1 = the densest core): the aesthetic
 *  demand scales with d, so a shallow-range map warps barely at all while
 *  the true core of a dense map earns the full user multiplier. */
export function findDenseBoxes(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: FindDenseBoxesOptions = {},
): Array<DenseBox & { d: number }> {
  if (samples.length === 0) return [];
  // maxScale 1e9 = NO clip: the density's wide dynamic range is exactly the
  // signal we threshold on. densityGrid2D's default clip (8) would flatten a
  // very dense region and a moderately dense one to the same value and hide
  // the gradient.
  const grid = densityGrid2D(samples, box, { ...opts, maxScale: 1e9 });
  const { e, bins: B, x0, y0, cw, ch } = grid;
  const frac = opts.frac ?? 0.4;

  // cutoff = frac · peak density. (Most cells are empty, so a percentile over
  // all cells would be negative and select the whole above-average halo.)
  let emax = 0;
  for (let i = 0; i < B * B; i++) if (e[i] > emax) emax = e[i];
  const cutoff = frac * emax;

  probeDensity(B, e, cutoff, emax, samples.length);

  const dense = new Uint8Array(B * B);
  for (let i = 0; i < B * B; i++) dense[i] = e[i] >= cutoff && e[i] > 0 ? 1 : 0;

  const seen = new Uint8Array(B * B);
  const boxes: Array<DenseBox & { d: number }> = [];
  for (let start = 0; start < B * B; start++) {
    if (!dense[start] || seen[start]) continue;
    let minx = B;
    let miny = B;
    let maxx = -1;
    let maxy = -1;
    let esum = 0;
    let ecnt = 0;
    const stack: number[] = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % B;
      const cy = (c / B) | 0;
      if (cx < minx) minx = cx;
      if (cx > maxx) maxx = cx;
      if (cy < miny) miny = cy;
      if (cy > maxy) maxy = cy;
      esum += e[c];
      ecnt++;
      if (cx > 0 && dense[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (cx < B - 1 && dense[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (cy > 0 && dense[c - B] && !seen[c - B]) { seen[c - B] = 1; stack.push(c - B); }
      if (cy < B - 1 && dense[c + B] && !seen[c + B]) { seen[c + B] = 1; stack.push(c + B); }
    }
    // normalized density: mean component excess, linear between the cutoff
    // (d=0) and the peak (d=1); a flat map (emax ~ cutoff) yields d=0.
    const span = emax - cutoff;
    const d = span > 1e-9 ? Math.min(1, Math.max(0, (esum / ecnt - cutoff) / span)) : 0;
    boxes.push({ x0: x0 + minx * cw, y0: y0 + miny * ch, x1: x0 + (maxx + 1) * cw, y1: y0 + (maxy + 1) * ch, d });
  }
  return boxes;
}

export interface DemandOptions extends DensityWarp2DOptionsLike {
  /** Density-oracle cutoff (fraction of peak), as findDenseBoxes. Default 0.4. */
  frac?: number;
  /** Saturation margin as a fraction of box half-extent. Default 1. */
  marginFrac?: number;
  /** Derive the octi cellSize estimate ĉ from a median edge length. Supplied by
   *  the caller so the divisor regime matches the real layout. */
  cellFromMedLen: (medLenPx: number) => number;
  /** Safety factor on the contraction threshold ĉ/2 (ĉ is an estimate). Default 1.3. */
  safety?: number;
  /** Headroom above bare survival for the demand target. Default 1.3. */
  slack?: number;
  /** User aesthetic multiplier on every box's demand (Box warp slider). Default 1. */
  userMult?: number;
  /** Per-box expansion ceiling. Default 10. */
  expandMax?: number;
  /** Max per-axis canvas growth; demand beyond it shrinks globally. Default 2.5. */
  maxGrowth?: number;
  /** Percentage-of-max-saturation mode (0–1): the granted growth FACTOR is
   *  this fraction of the max-saturation growth (the full demand's growth),
   *  floored at identity — t=0.5 on a map that saturates at 4.64 grows
   *  exactly 2.32; positions below 1/saturation are the identity. Overrides
   *  maxGrowth when set (expandMax per-box safety still applies). */
  growthPct?: number;
  /** Direction-intelligence amount, 0–1: how far each box's expansion is
   *  reallocated toward its crowded axis (boxCrowdAnisotropy). 0 = isotropic
   *  split, 1 = full reallocation. Default 1. Env OCTI_BOX_ANISO
   *  overrides for dev sweeps. */
  aniso?: number;
  /** Enable the contraction (pinch-survival) oracle. Default OFF: the warp is
   *  aesthetic and pinches are the draw's job. Overrides the OCTI_BOX_CONTRACTION
   *  env. Unit tests of the contraction pipeline set it true explicitly. */
  contraction?: boolean;
  /** Capsule-demand oracle inputs. Optional: omitted by unit-level callers
   *  and dev tools that have no marker model, in which case the oracle
   *  doesn't run. */
  capsule?: CapsuleOracleOptions & {
    /** Per-g.nodes-index stopping-line estimate (lines through the node,
     *  an upper bound on stop marks; slack-friendly). */
    lineCounts: readonly number[];
  };
  /** Corridor-clearance oracle inputs. Optional: omitted by unit-level
   *  callers and dev tools without a line model, in which case the oracle
   *  doesn't run. */
  corridor?: CorridorOracleOptions & {
    /** Per-g.edges-index line ids (painted width + same-service exclusion). */
    edgeLines: readonly (readonly string[])[];
  };
}

export interface DemandWarpResult {
  warp: WarpFn;
  /** Capped per-axis canvas growth (>= 1): the output canvas is growth × input canvas. */
  growthX: number;
  growthY: number;
}

/** Per-box SURVIVAL demand: the expansion that lifts the box's median node
 *  gap to the demand target `need` (= ĉ/2 · slack). Absolute and
 *  slider-independent: the user multiplier no longer scales survival (the
 *  caller composes the aesthetic term separately, from the box's normalized
 *  density). A box whose gaps already clear the target gets 1 (no demand). */
function boxDemand(
  b: DenseBox,
  nodes: readonly Pixel[],
  gaps: readonly number[],
  need: number,
  expandMax: number,
): number {
  const inside: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && Number.isFinite(gaps[i]) && gaps[i] > 0)
      inside.push(gaps[i]);
  }
  if (inside.length === 0) return 1;
  inside.sort((x, y) => x - y);
  const gMed = inside[inside.length >> 1];
  return Math.min(expandMax, Math.max(1, need / gMed));
}

/** Build the per-axis saturating push warp for `boxes` with PER-BOX strengths.
 *  The canvas grows by exactly the (possibly throttled) warp's raw growth per
 *  axis, so space stays proportional to the warp granted. Past maxGrowth the
 *  strengths are throttled, never the map squeezed. Top-left anchored:
 *  [minX..maxX] maps to [minX .. minX + W·growthX] (the caller's content
 *  refit re-frames anyway). */
function buildWarpFromBoxes(
  boxes: DenseBox[],
  strengths: readonly [number, number][], // per box: [sx, sy] = per-axis expand - 1
  box: WarpBox,
  marginFrac: number,
  maxGrowth: number | [number, number], // scalar, or per-axis caps [capX, capY]
  out?: { boxes?: DenseBox[] },
  perAxisMargin = false, // aniso path: each axis's ramp scales with ITS half-extent
): DemandWarpResult {
  const [capGx, capGy] = Array.isArray(maxGrowth) ? maxGrowth : [maxGrowth, maxGrowth];
  const identity: WarpFn = (p) => [p[0], p[1]];
  if (boxes.length === 0 || strengths.every(([sx, sy]) => sx === 0 && sy === 0)) {
    if (out) out.boxes = boxes.map((b) => ({ ...b }));
    return { warp: identity, growthX: 1, growthY: 1 };
  }
  const bs = boxes.map((b, i) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const hx = (b.x1 - b.x0) / 2;
    const hy = (b.y1 - b.y0) / 2;
    // One margin from the LONGER half-extent for both axes lets an elongated
    // box's push in its THIN axis ramp across its long extent, bleeding its
    // stretch far into the neighbouring sub-box and washing the directions
    // back out. Per-axis margins keep each axis's ramp proportional to that
    // axis's own extent.
    const m = Math.max(1, marginFrac * Math.max(hx, hy));
    const mx = perAxisMargin ? Math.max(1, marginFrac * hx) : m;
    const my = perAxisMargin ? Math.max(1, marginFrac * hy) : m;
    return { cx, cy, hx, hy, mx, my, sx: strengths[i][0], sy: strengths[i][1] };
  });
  // Smooth saturating odd-symmetric push, per-box strength s. C2-CONTINUOUS
  // (no-coastline-kinks invariant): the margin ramps the SLOPE with a
  // smootherstep, slope(u) = 1 - (6u^5 - 15u^4 + 10u^3), u = (a-h)/m. The push
  // is its integral, p = h + m*(u - 2.5u^4 + 3u^5 - u^6), so slope'(0)=slope'(1)=0
  // — curvature matches the flat regions on both sides and there is no corner at
  // any margin width (the old a-(a-h)^2/(2m) had a LINEAR slope ramp: curvature
  // jumped by s/m at both ends = the kink). slope in [0,1] keeps each s*push
  // monotone (fold-free, det>=1), and the gain over the margin is still exactly
  // m/2 (integral of a symmetric smootherstep is 1/2), so far-field displacement
  // and the growth/throttle math are unchanged. Horner, no Math.pow (cross-V8).
  const push = (t: number, h: number, m: number): number => {
    const a = t < 0 ? -t : t;
    let p: number;
    if (a <= h) p = a;
    else if (a <= h + m) {
      const u = (a - h) / m;
      p = h + m * u * (1 + u * u * u * (-2.5 + u * (3 - u)));
    } else p = h + m / 2;
    return t < 0 ? -p : p;
  };
  const raw = (px: number, py: number): Pixel => {
    let ux = 0;
    let uy = 0;
    for (const b of bs) {
      ux += b.sx * push(px - b.cx, b.hx, b.mx);
      uy += b.sy * push(py - b.cy, b.hy, b.my);
    }
    return [px + ux, py + uy];
  };
  // SPACE ∝ WARP: the canvas always grows to exactly what the granted warp
  // produces, and the far field ALWAYS keeps unit scale (a saturated push is
  // a rigid translation out there). When the raw growth would exceed
  // maxGrowth, the cap THROTTLES the push strengths, proportionally and per
  // axis, instead of squeezing the whole warped map back into the capped
  // canvas the way a global sx<1 rescale would. The squeeze makes the
  // outskirts pay for the core's room, crushing them into edge bands. The
  // throttle grants less room instead and leaves the far field
  // geographically true. Growth is AFFINE in the strengths (corner images
  // are sums of s·push terms), so the throttle factor is exact:
  // λ = (cap−1)/(raw−1) lands growth on the cap in one step.
  const W = box.maxX - box.minX;
  const H = box.maxY - box.minY;
  const corners = () => ({
    xl: raw(box.minX, box.minY)[0],
    xr: raw(box.maxX, box.minY)[0],
    yt: raw(box.minX, box.minY)[1],
    yb: raw(box.minX, box.maxY)[1],
  });
  let { xl, xr, yt, yb } = corners();
  const rawGx = (xr - xl) / W;
  const rawGy = (yb - yt) / H;
  if (rawGx > capGx && rawGx > 1) {
    const lx = (Math.max(1, capGx) - 1) / (rawGx - 1);
    for (const b of bs) b.sx *= lx;
  }
  if (rawGy > capGy && rawGy > 1) {
    const ly = (Math.max(1, capGy) - 1) / (rawGy - 1);
    for (const b of bs) b.sy *= ly;
  }
  if (rawGx > capGx || rawGy > capGy) ({ xl, xr, yt, yb } = corners());
  const growthX = (xr - xl) / W;
  const growthY = (yb - yt) / H;
  const warp: WarpFn = (p) => {
    const q = raw(p[0], p[1]);
    return [box.minX + (q[0] - xl), box.minY + (q[1] - yt)];
  };
  if (out) {
    out.boxes = boxes.map((b) => {
      const a = warp([b.x0, b.y0]);
      const c = warp([b.x1, b.y1]);
      return { x0: a[0], y0: a[1], x1: c[0], y1: c[1] };
    });
  }
  return { warp, growthX, growthY };
}

/** Demand-driven dense-box warp: boxes from density peaks ∪ predicted octi
 *  contraction ∪ predicted capsule collisions (when opts.capsule is supplied).
 *  Each is expanded by exactly what its own targets need (contraction survival
 *  plus capsule pair separations, × userMult). Growth is absorbed by the canvas
 *  up to maxGrowth. */
export function buildDemandBoxWarp(
  samples: readonly Pixel[],
  g: BoxGraph,
  box: WarpBox,
  opts: DemandOptions,
  out?: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] },
): DemandWarpResult {
  const safety = opts.safety ?? 1.3;
  const slack = opts.slack ?? 1.3;
  const userMult = opts.userMult ?? 1;
  const expandMax = opts.expandMax ?? 10;
  const maxGrowth = opts.maxGrowth ?? 2.5;
  const marginFrac = opts.marginFrac ?? 1;
  const anisoAmt = (() => {
    const env = envNum('OCTI_BOX_ANISO');
    const a = Number.isFinite(env) ? env : (opts.aniso ?? 1);
    return Math.min(1, Math.max(0, a));
  })();

  const medLen = medianEdgeLenPx(g);
  const cell = opts.cellFromMedLen(medLen);
  // The warp is an AESTHETIC feature: give crowded areas room to breathe and
  // emphasize important areas, with FEW meaningful boxes. Its two aesthetic
  // drivers are the DENSITY oracle (line-weighted station crowding — captures
  // both crowded regions and important hubs) and the CAPSULE oracle (spreading
  // colliding interchanges — emphasis on the important interchange areas).
  // OCTI_BOX_DENSITY=0 drops density (diagnostic).
  const useDensity = envStr('OCTI_BOX_DENSITY') !== '0';
  // Empty padding remnants and lone stops warp nothing a marker needs; drop
  // post-merge boxes holding fewer than 2 stations. OCTI_BOX_DROP_TINY=0 keeps
  // the legacy behavior.
  const dropTiny = envStr('OCTI_BOX_DROP_TINY') !== '0';
  // The CONTRACTION oracle is pure pinch-survival: it pre-spread every sub-8px
  // edge so octi wouldn't contract it. That is the DRAW's job now (a draw must
  // render any geometry cleanly; loops/broken-contiguity from a pinch are draw
  // bugs, not warp concerns) — and its ~60 tiny per-pinch boxes were exactly
  // the swarm that undermined the aesthetic goal. DEFAULT OFF. OCTI_BOX_CONTRACTION=1
  // (or 'all') re-enables it for comparison; the draw issues its removal
  // surfaces are tracked as a draw-robustness backlog, not fixed here.
  const contractionEnv = envStr('OCTI_BOX_CONTRACTION');
  const useContraction = opts.contraction ?? (contractionEnv === '1' || contractionEnv === 'all');
  const density = (useDensity && samples.length) ? findDenseBoxes(samples, box, opts) : [];
  const capsule = opts.capsule ? findCapsuleBoxes(g, opts.capsule.lineCounts, opts.capsule) : [];
  const contraction = useContraction ? findContractionBoxes(g, (cell / 2) * safety) : [];
  // The corridor oracle ignores passes inside the contraction threshold (those
  // corridors get welded or contracted into ONE drawn corridor downstream) and
  // pairs whose paint a single grid cell already absorbs.
  const corridor = opts.corridor
    ? findCorridorBoxes(g, opts.corridor.edgeLines, {
        ...opts.corridor,
        minDist: Math.max(opts.corridor.minDist ?? 0, (cell / 2) * safety),
        minReq: Math.max(opts.corridor.minReq ?? 0, cell * 1.25),
      })
    : [];
  let merged = mergeDemandBoxes([
    ...density.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, kind: 'density' as const, pairs: [], aes: b.d })),
    ...contraction.map((b) => ({ ...b, kind: 'contraction' as const, pairs: [] })),
    ...capsule,
    ...corridor,
  ]);
  if (dropTiny) {
    // A box earns its push only if it actually holds stations to spread: count
    // the graph nodes inside and drop any with fewer than 2 (empty clip
    // remnants, lone stops). Density boxes are exempt — their job is to dilate
    // a REGION, not to separate a specific pair, so they legitimately span
    // sparse ground between the cells that made them dense.
    const nodesInBox = (b: DemandBox): number => {
      let n = 0;
      for (const p of g.nodes) {
        if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && ++n >= 2) break;
      }
      return n;
    };
    merged = merged.filter((b) => b.kind === 'density' || nodesInBox(b) >= 2);
  }
  const need = (cell / 2) * slack;
  // Direction intelligence step 1: break direction-mixed boxes into coherent
  // sub-boxes so each can take its room on its OWN crowded axis. anisoAmt 0
  // leaves boxes unsplit.
  const boxes = anisoAmt > 0 ? splitMixedBoxes(merged, g, need / 2) : merged;
  probeBoxes(density, merged, boxes, g.nodes, (b) => boxCrowdAnisotropy(b, g));
  if (boxes.length === 0) {
    if (out) { out.boxes = []; out.expands = []; }
    return { warp: (p) => [p[0], p[1]], growthX: 1, growthY: 1 };
  }

  const gaps = nodeGaps(g);
  // Demand = max(survival, aesthetics). Survival (need/gap, pair lifts) is
  // absolute and granted at 1x at every slider position; the user multiplier
  // scales ONLY the aesthetic term, linear in the box's normalized density
  // (density boxes carry aes in [0,1]; oracle boxes carry none). A shallow
  // density range or a slider at/below center leaves aesthetics at 1.
  let expands = boxes.map((b) => {
    const survival = boxDemand(b, g.nodes, gaps, need, expandMax);
    const aesthetic = 1 + Math.max(0, userMult - 1) * (b.aes ?? 0);
    return Math.min(expandMax, Math.max(survival, aesthetic));
  });
  // Capsule pair targets seed on top: the expansion that lifts each pair to
  // its required separation (absolute, slider-independent).
  expands = expands.map((e, i) => {
    let seed = e; // (not `out`, which is the output-sink parameter used below)
    for (const t of boxes[i].pairs) {
      const pa = g.nodes[t.a], pb = g.nodes[t.b];
      const d = Math.sqrt((pa[0] - pb[0]) * (pa[0] - pb[0]) + (pa[1] - pb[1]) * (pa[1] - pb[1]));
      if (d > 0) seed = Math.max(seed, Math.min(expandMax, Math.max(1, t.required / d)));
    }
    return seed;
  });
  // Direction intelligence: each box's scalar expand is split into per-axis
  // strengths along its crowd anisotropy, sx = 2r·(e−1) and sy = 2(1−r)·(e−1).
  // This is a LINEAR split (no pow: determinism, and node positions stay affine
  // in e, which the secant refinement's model requires). r is measured once on
  // the input-space graph (stable under the warp to first order) and softened by
  // anisoAmt; the [0.1, 0.9] clamp keeps BOTH axes responsive so the secant
  // always has a positive slope on whichever axis the contraction floor
  // measures. Total strength 2(e−1) is conserved, so an isotropic box (r=0.5)
  // reproduces the isotropic split exactly. Per-axis strength is still capped at
  // expandMax−1 (the scalar cap's intent, per axis).
  const rs = boxes.map((b) => {
    const r = 0.5 + (boxCrowdAnisotropy(b, g) - 0.5) * anisoAmt;
    return Math.min(0.9, Math.max(0.1, r));
  });
  // Anisotropy is a REALLOCATION luxury, not a survival budget: as a box's
  // demand e approaches the expandMax ceiling, interpolate the split back to
  // isotropic (t → 1) so both axes can still reach the full ceiling factor.
  // A starved weak axis must never make an extreme contraction demand
  // unreachable that the isotropic warp could clear. (Mix weights sum to 2 at
  // every t, so total strength is conserved throughout.)
  const axisStrengths = (es: readonly number[]): [number, number][] =>
    es.map((e, i) => {
      const t = Math.min(1, Math.max(0, (e - 1) / (expandMax - 1)));
      const mixX = 2 * rs[i] * (1 - t) + t;
      const mixY = 2 * (1 - rs[i]) * (1 - t) + t;
      return [
        Math.min(expandMax - 1, mixX * (e - 1)),
        Math.min(expandMax - 1, mixY * (e - 1)),
      ];
    });
  // Refinement needs the output-space boxes even when the caller passed no `out`.
  // It solves against the UNTHROTTLED warp (cap = ∞): the secant's affine model
  // assumes the room it asks for is granted. Throttling inside the loop would
  // undo each raise and jam every box to the ceiling chasing an unreachable
  // target (and the ceiling forces isotropy). The cap is applied ONCE, on the
  // final build: demands = the warp we'd like, throttle = the warp we allow,
  // canvas = exactly the space the allowed warp produces.
  const oref: { boxes?: DenseBox[] } = out ?? {};
  let result = buildWarpFromBoxes(boxes, axisStrengths(expands), box, marginFrac, Infinity, oref, anisoAmt > 0);

  // Refinement: expansion raises the global median edge length, so the real
  // post-warp contraction threshold is HIGHER than the pre-warp estimate the
  // first-pass demands targeted, and expanding further raises it again (edges
  // that straddle a box boundary stretch with the box and can dominate the
  // median), so a proportional bump chases a moving target and converges to the
  // threshold FROM BELOW without ever clearing it. Instead solve for the fixed
  // point: per box, both the inside-gap and the global need are affine in the
  // box's expand while the growth cap is slack (node positions are affine in
  // the push strengths), so a secant step through the last two (expand, gap,
  // need) states lands where the gap clears the need, with a small margin for
  // the model error, then rebuild and re-verify. Bounded passes; arithmetic is
  // + − × ÷ √ min max only, fixed iteration order → deterministic.
  {
    // Median gap of edges with BOTH endpoints inside the box, the statistic
    // octi contraction acts on (nodeGaps averages straddling edges into it,
    // which would credit a box with room that lies outside it).
    const gapInBox = (b: DenseBox, nodes: readonly Pixel[]): number => {
      const ls: number[] = [];
      for (const [a, c] of g.edges) {
        const pa = nodes[a], pc = nodes[c];
        if (pa[0] >= b.x0 && pa[0] <= b.x1 && pa[1] >= b.y0 && pa[1] <= b.y1 &&
            pc[0] >= b.x0 && pc[0] <= b.x1 && pc[1] >= b.y0 && pc[1] <= b.y1) {
          const dx = pa[0] - pc[0], dy = pa[1] - pc[1];
          ls.push(Math.sqrt(dx * dx + dy * dy));
        }
      }
      ls.sort((x, y) => x - y);
      return ls.length ? ls[ls.length >> 1] : Infinity; // no inside edges → nothing to clear
    };
    // Worst-of evaluation: every box carries the contraction floor (inside-
    // edge median vs the CURRENT global threshold), and capsule boxes add
    // pair-separation targets (CONSTANT need, since capsule size doesn't move
    // with the warp). The secant solves each box against its worst violator; the
    // per-box `need` is now part of the secant state because pair needs and
    // the contraction threshold evolve differently.
    const evalBox = (i: number, bbox: DenseBox, nodes: readonly Pixel[], needFloor: number): { gap: number; need: number } => {
      let gap = gapInBox(bbox, nodes);
      let needV = needFloor;
      let worst = Number.isFinite(gap) && gap > 0 ? needV / gap : 0;
      for (const t of boxes[i].pairs) {
        const pa = nodes[t.a], pb = nodes[t.b];
        const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
        const d = Math.sqrt(dx * dx + dy * dy);
        const ratio = d > 0 ? t.required / d : Infinity;
        if (ratio > worst) { worst = ratio; gap = d; needV = t.required; }
      }
      return { gap, need: needV };
    };
    // Previous secant point per box: the UNWARPED state (expand 1, input-space box).
    let prev = boxes.map((b, i) => evalBox(i, b, g.nodes, need));
    let ePrev = boxes.map(() => 1);
    // 6 passes (was 4): the per-pass raise is now bounded 1.5x, so a genuine
    // deficit converges from below in a couple more steps instead of being
    // cleared by a single overshooting jump.
    for (let pass = 0; pass < 6; pass++) {
      const advected = g.nodes.map((p) => result.warp([p[0], p[1]]) as Pixel);
      const needAfter = (opts.cellFromMedLen(medianEdgeLenPx({ nodes: advected, edges: g.edges })) / 2) * slack;
      const now = boxes.map((_, i) => evalBox(i, oref.boxes![i], advected, needAfter));
      const eNext = expands.map((e, i) => {
        const { gap, need: needV } = now[i];
        if (!Number.isFinite(gap) || gap >= needV) return e; // cleared
        const margin = needV * 0.05; // headroom for the affine-model error
        // (the two 1e-9 guards below are just "<= 0 with an fp cushion";
        // scale-independent, since the guarded deltas are far above 1e-9
        // whenever a real step happened.)
        // EVERY refinement raise is bounded to 1.5x per pass, and a raise is
        // granted only on measured PROGRESS. The first-pass demand already
        // encodes the measured need/gap ratios directly (pinned pairs seed at
        // their true lift), so refinement only polishes against the post-warp
        // state. The old behavior escalated on stalls; a box whose gap does
        // not respond to its own expansion (a large cluster whose median
        // inside edge lies along its weak axis) then ratcheted to the ceiling
        // and the growth throttle renormalized the whole map onto the cap.
        // Deficits that expansion provably cannot clear are ACCEPTED, not
        // chased.
        const step = (t: number): number => Math.min(expandMax, Math.min(e * 1.5, Math.max(e, t)));
        const de = e - ePrev[i];
        if (de <= 1e-9) return step((e * (needV + margin)) / gap); // no slope yet: proportional seed
        const denom = (gap - prev[i].gap) - (needV - prev[i].need);
        // denom <= 0: the need moved at least as fast as this box's gap. The
        // push saturates as e rises (straddling edges stop stretching, the
        // median stops climbing, the gap catches up), so a BOUNDED step
        // toward that regime is warranted; the jump to the ceiling is not.
        if (denom <= 1e-9) return step(expandMax);
        return step(e + ((needV + margin - gap) * de) / denom);
      });
      // No progress: every box either cleared or sits saturated at the
      // ceiling, so another pass would rebuild bit-identically. Stop.
      if (eNext.every((e, i) => e === expands[i])) break;
      ePrev = expands; prev = now;
      expands = eNext;
      result = buildWarpFromBoxes(boxes, axisStrengths(expands), box, marginFrac, Infinity, oref, anisoAmt > 0);
    }
  }
  // The one and only capped build. Percentage mode: the granted GROWTH
  // FACTOR is t x the max-saturation growth (the full solved demand's
  // growth), floored at identity — 50% of a map whose saturation renders at
  // 4.64 is exactly 2.32. `result` still holds the last unthrottled build,
  // so its growth IS the max saturation; the exact per-axis throttle lands
  // the strengths on the target. Legacy mode throttles against the fixed
  // growth budget (see buildWarpFromBoxes: strengths scale, far field stays
  // unit-scale, canvas = exactly the allowed warp's growth).
  if (opts.growthPct !== undefined) {
    const t = Math.min(1, Math.max(0, opts.growthPct));
    const capX = Math.max(1, t * result.growthX);
    const capY = Math.max(1, t * result.growthY);
    result = buildWarpFromBoxes(boxes, axisStrengths(expands), box, marginFrac, [capX, capY], oref, anisoAmt > 0);
  } else {
    result = buildWarpFromBoxes(boxes, axisStrengths(expands), box, marginFrac, maxGrowth, oref, anisoAmt > 0);
  }
  if (out) { out.expands = expands; out.aniso = rs; }

  debugBoxWarp({
    boxCount: boxes.length, densityCount: density.length, contractionCount: contraction.length,
    capsuleCount: capsule.length, corridorCount: corridor.length, mergedCount: merged.length, cell, need, expands, rs, anisoAmt,
    growthX: result.growthX, growthY: result.growthY, maxGrowth,
  });
  return result;
}

/** Separable warp (global magnification) composed with the demand-driven box
 *  warp (local rectilinear room). Boxes are found, and demands measured, in
 *  SEPARABLE-WARPED space, so both the samples and the graph advect through
 *  `sep` first. Composition of fold-free maps is fold-free; growth comes only
 *  from the box layer (the separable CDF maps the canvas onto itself). */
export function buildSepDemandBoxWarp(
  samples: readonly Pixel[],
  g: BoxGraph,
  box: WarpBox,
  sepOpts: DensityWarpOptions,
  boxOpts: DemandOptions,
  out?: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] },
): DemandWarpResult {
  const sep = buildDensityWarp(samples, box, sepOpts);
  const warpedSamples = samples.map((s) => sep([s[0], s[1]]) as Pixel);
  const warpedGraph: BoxGraph = { nodes: g.nodes.map((p) => sep([p[0], p[1]]) as Pixel), edges: g.edges };
  const bx = buildDemandBoxWarp(warpedSamples, warpedGraph, box, boxOpts, out);
  return { warp: (p) => bx.warp(sep(p)), growthX: bx.growthX, growthY: bx.growthY };
}
