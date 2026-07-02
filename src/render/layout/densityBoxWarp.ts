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
// plus any capsule pair separations — via a smooth
// saturating per-axis push: inside the box half-extent the map ramps at unit
// slope, eases the slope to 0 across the margin, then HOLDS constant — so the
// surround is carried outward rather than crammed back to identity. Tapering
// back to identity (an earlier, now-deleted design) forced, by area
// conservation, a compression ring just outside the box — the "weirdly thin
// geography at the edge of growth". A saturating push keeps the per-axis map
// monotone (slope in [0,1], so p + s·push is monotone for s >= 0), so the
// expansion is fold-free at any strength and has NO localized thinning.
//
// GROWTH, not claw-back: the saturating push only grows the overall bbox, and
// that growth is KEPT — the output canvas grows to min(raw growth, maxGrowth)
// × the input canvas PER AXIS, instead of being rescaled back to the input
// canvas size the way a fixed-expand scheme would. Per axis (not a single
// uniform scale) so the warped canvas FILLS the grown canvas instead of
// letterboxing — a uniform scale would leave a bare-land margin that renders
// as "black edges" round the map. A bounded secant refinement pass then
// re-solves each box's demand against the POST-warp contraction threshold
// (the median edge length — and so the threshold — rises as boxes expand),
// and buildSepDemandBoxWarp composes the separable warp (global
// magnification) under the demand warp (local room), finding boxes and
// measuring demand in separable-warped space.
// Determinism: + − × ÷ √ min max only → bit-identical cross-V8.

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
 *  density. Deterministic: plain array iteration + arithmetic. */
export function findContractionBoxes(g: BoxGraph, threshold: number): DenseBox[] {
  const parent = g.nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const touched = new Uint8Array(g.nodes.length);
  for (const [a, b] of g.edges) {
    if (edgeLen(g, a, b) >= threshold) continue;
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
  for (const b of byRoot.values()) {
    if (b.n < 2) continue;
    boxes.push({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad });
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

export type BoxKind = 'density' | 'contraction' | 'capsule';
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
  const out: DemandBox[] = [];
  for (const e of byRoot.values()) {
    out.push({ x0: e.x0 - e.pad, y0: e.y0 - e.pad, x1: e.x1 + e.pad, y1: e.y1 + e.pad, kind: 'capsule', pairs: e.pairs });
  }
  return out;
}

/** Nesting-aware merge (spec §3). Same-kind overlaps union to their bbox (as
 *  the old mergeIntersectingBoxes). A box fully CONTAINED in a different-kind
 *  box NESTS — both survive; the summed per-axis pushes stay monotone, so
 *  compounding is fold-free, and the inner push only adds a rigid translation
 *  to the outer far field. Cross-kind PARTIAL overlap unions conservatively
 *  (kind precedence capsule > contraction > density; pairs concatenate) so
 *  partial pushes never double-stack. Deterministic fixpoint scan. */
export function mergeDemandBoxes(boxes: DemandBox[]): DemandBox[] {
  const out = boxes.map((b) => ({ ...b, pairs: [...b.pairs] }));
  const contains = (a: DemandBox, b: DemandBox): boolean =>
    b.x0 >= a.x0 - 1e-6 && b.x1 <= a.x1 + 1e-6 && b.y0 >= a.y0 - 1e-6 && b.y1 <= a.y1 + 1e-6;
  const rank: Record<BoxKind, number> = { density: 0, contraction: 1, capsule: 2 };
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const overlap = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
        if (!overlap) continue;
        if (a.kind !== b.kind && (contains(a, b) || contains(b, a))) continue; // nest
        out[i] = {
          x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          kind: rank[a.kind] >= rank[b.kind] ? a.kind : b.kind,
          pairs: [...a.pairs, ...b.pairs],
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
  }
  return out;
}

// (DemandOptions, below, extends the same option bag densityGrid2D reads.)
type DensityWarp2DOptionsLike = DensityWarpOptions & { sigmaPx?: number };

/** Options `findDenseBoxes` reads out of the (larger) `DemandOptions` bag it's
 *  normally called with — kept as its own alias so callers that only want the
 *  density oracle (no graph, no demand) can pass a minimal bag. */
type FindDenseBoxesOptions = DensityWarp2DOptionsLike & {
  /** Cutoff as a fraction of the PEAK excess density (0–1): cells above
   *  frac·max are "dense". Threshold on the peak, NOT a percentile over all
   *  cells — most cells are empty, so a global percentile collapses to "above
   *  average" and grabs the whole halo. Higher frac = tighter core. Default 0.4. */
  frac?: number;
};

/** Find the densest regions as axis-aligned bounding boxes (pixel coords):
 *  threshold the smoothed excess-density grid at the pct-th percentile, then
 *  bound each 4-connected component of above-cutoff cells. */
export function findDenseBoxes(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: FindDenseBoxesOptions = {},
): DenseBox[] {
  if (samples.length === 0) return [];
  // maxScale 1e9 = NO clip: the density's dynamic range (Manhattan ≈ 55× mean vs
  // the boroughs ≈ 10×) is exactly the signal we threshold on; densityGrid2D's
  // default clip (8) would flatten them to the same value and hide the gradient.
  const grid = densityGrid2D(samples, box, { ...opts, maxScale: 1e9 });
  const { e, bins: B, x0, y0, cw, ch } = grid;
  const frac = opts.frac ?? 0.4;

  // cutoff = frac · peak density. (Most cells are empty, so a percentile over
  // all cells would be negative and select the whole above-average halo.)
  let emax = 0;
  for (let i = 0; i < B * B; i++) if (e[i] > emax) emax = e[i];
  const cutoff = frac * emax;

  const dense = new Uint8Array(B * B);
  for (let i = 0; i < B * B; i++) dense[i] = e[i] >= cutoff && e[i] > 0 ? 1 : 0;

  const seen = new Uint8Array(B * B);
  const boxes: DenseBox[] = [];
  for (let start = 0; start < B * B; start++) {
    if (!dense[start] || seen[start]) continue;
    let minx = B;
    let miny = B;
    let maxx = -1;
    let maxy = -1;
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
      if (cx > 0 && dense[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (cx < B - 1 && dense[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (cy > 0 && dense[c - B] && !seen[c - B]) { seen[c - B] = 1; stack.push(c - B); }
      if (cy < B - 1 && dense[c + B] && !seen[c + B]) { seen[c + B] = 1; stack.push(c + B); }
    }
    boxes.push({ x0: x0 + minx * cw, y0: y0 + miny * ch, x1: x0 + (maxx + 1) * cw, y1: y0 + (maxy + 1) * ch });
  }
  return boxes;
}

export interface DemandOptions extends DensityWarp2DOptionsLike {
  /** Density-oracle cutoff (fraction of peak), as findDenseBoxes. Default 0.4. */
  frac?: number;
  /** Saturation margin as a fraction of box half-extent (as before). Default 1. */
  marginFrac?: number;
  /** Derive the octi cellSize estimate ĉ from a median edge length — supplied by
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
  /** Max per-axis canvas growth; demand beyond it shrinks globally. Default 2. */
  maxGrowth?: number;
  /** Capsule-demand oracle inputs (optional — omitted by unit-level callers
   *  and dev tools that have no marker model; the oracle then doesn't run). */
  capsule?: CapsuleOracleOptions & {
    /** Per-g.nodes-index stopping-line estimate (lines through the node —
     *  an upper bound on stop marks; slack-friendly). */
    lineCounts: readonly number[];
  };
}

export interface DemandWarpResult {
  warp: WarpFn;
  /** Capped per-axis canvas growth (>= 1): the output canvas is growth × input canvas. */
  growthX: number;
  growthY: number;
}

/** Per-box demand: the expansion that lifts the box's median node gap to the
 *  demand target `need` (= ĉ/2 · slack), times the user's aesthetic multiplier.
 *  A box whose gaps already clear the target gets ~userMult (aesthetics only). */
function boxDemand(
  b: DenseBox,
  nodes: readonly Pixel[],
  gaps: readonly number[],
  need: number,
  userMult: number,
  expandMax: number,
): number {
  const inside: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && Number.isFinite(gaps[i]) && gaps[i] > 0)
      inside.push(gaps[i]);
  }
  if (inside.length === 0) return Math.min(expandMax, Math.max(1, userMult));
  inside.sort((x, y) => x - y);
  const gMed = inside[inside.length >> 1];
  return Math.min(expandMax, Math.max(1, userMult * Math.max(1, need / gMed)));
}

/** Build the per-axis saturating push warp for `boxes` with PER-BOX strengths,
 *  growing the canvas by min(raw growth, maxGrowth) per axis instead of
 *  normalizing back to the input canvas. Top-left anchored: [minX..maxX] maps
 *  to [minX .. minX + W·growthX] (the caller's content refit re-frames anyway). */
function buildWarpFromBoxes(
  boxes: DenseBox[],
  strengths: readonly number[], // expand_b - 1, per box
  box: WarpBox,
  marginFrac: number,
  maxGrowth: number,
  out?: { boxes?: DenseBox[] },
): DemandWarpResult {
  const identity: WarpFn = (p) => [p[0], p[1]];
  if (boxes.length === 0 || strengths.every((s) => s === 0)) {
    if (out) out.boxes = boxes.map((b) => ({ ...b }));
    return { warp: identity, growthX: 1, growthY: 1 };
  }
  const bs = boxes.map((b, i) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const hx = (b.x1 - b.x0) / 2;
    const hy = (b.y1 - b.y0) / 2;
    const m = Math.max(1, marginFrac * Math.max(hx, hy));
    return { cx, cy, hx, hy, m, s: strengths[i] };
  });
  // Smooth saturating odd-symmetric push, per-box strength s (slope in [0,1]
  // ⇒ each s·push term is monotone ⇒ the sum is monotone per axis ⇒
  // fold-free, det >= 1).
  const push = (t: number, h: number, m: number): number => {
    const a = t < 0 ? -t : t;
    let p: number;
    if (a <= h) p = a;
    else if (a <= h + m) { const u = a - h; p = a - (u * u) / (2 * m); }
    else p = h + m / 2;
    return t < 0 ? -p : p;
  };
  const raw = (px: number, py: number): Pixel => {
    let ux = 0;
    let uy = 0;
    for (const b of bs) {
      ux += b.s * push(px - b.cx, b.hx, b.m);
      uy += b.s * push(py - b.cy, b.hy, b.m);
    }
    return [px + ux, py + uy];
  };
  // Growth instead of claw-back: the raw push only expands (monotone, det >= 1),
  // so the warped canvas corners give the raw growth; cap per axis at maxGrowth.
  // sx = 1 while demand fits (the room is REAL); < 1 only past the cap (global,
  // even shrink — never a ring).
  const xl = raw(box.minX, box.minY)[0];
  const xr = raw(box.maxX, box.minY)[0];
  const yt = raw(box.minX, box.minY)[1];
  const yb = raw(box.minX, box.maxY)[1];
  const W = box.maxX - box.minX;
  const H = box.maxY - box.minY;
  const rawGx = (xr - xl) / W;
  const rawGy = (yb - yt) / H;
  const growthX = Math.min(rawGx, maxGrowth);
  const growthY = Math.min(rawGy, maxGrowth);
  const sx = growthX / rawGx;
  const sy = growthY / rawGy;
  const warp: WarpFn = (p) => {
    const q = raw(p[0], p[1]);
    return [box.minX + (q[0] - xl) * sx, box.minY + (q[1] - yt) * sy];
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
 *  contraction ∪ predicted capsule collisions (when opts.capsule is supplied),
 *  each expanded by exactly what its own targets need — contraction survival
 *  plus capsule pair separations (× userMult) — growth absorbed by the canvas
 *  up to maxGrowth. */
export function buildDemandBoxWarp(
  samples: readonly Pixel[],
  g: BoxGraph,
  box: WarpBox,
  opts: DemandOptions,
  out?: { boxes?: DenseBox[]; expands?: number[] },
): DemandWarpResult {
  const safety = opts.safety ?? 1.3;
  const slack = opts.slack ?? 1.3;
  const userMult = opts.userMult ?? 1;
  const expandMax = opts.expandMax ?? 10;
  const maxGrowth = opts.maxGrowth ?? 2;
  const marginFrac = opts.marginFrac ?? 1;

  const medLen = medianEdgeLenPx(g);
  const cell = opts.cellFromMedLen(medLen);
  const density = samples.length ? findDenseBoxes(samples, box, opts) : [];
  const contraction = findContractionBoxes(g, (cell / 2) * safety);
  const capsule = opts.capsule ? findCapsuleBoxes(g, opts.capsule.lineCounts, opts.capsule) : [];
  const boxes = mergeDemandBoxes([
    ...density.map((b) => ({ ...b, kind: 'density' as const, pairs: [] })),
    ...contraction.map((b) => ({ ...b, kind: 'contraction' as const, pairs: [] })),
    ...capsule,
  ]);
  if (boxes.length === 0) {
    if (out) { out.boxes = []; out.expands = []; }
    return { warp: (p) => [p[0], p[1]], growthX: 1, growthY: 1 };
  }

  const gaps = nodeGaps(g);
  const need = (cell / 2) * slack;
  let expands = boxes.map((b) => boxDemand(b, g.nodes, gaps, need, userMult, expandMax));
  // Capsule pair targets seed on top of the contraction-floor demand: the
  // expansion that lifts each pair to its required separation (× userMult).
  expands = expands.map((e, i) => {
    let seed = e; // (not `out` — that's the output-sink parameter used below)
    for (const t of boxes[i].pairs) {
      const pa = g.nodes[t.a], pb = g.nodes[t.b];
      const d = Math.sqrt((pa[0] - pb[0]) * (pa[0] - pb[0]) + (pa[1] - pb[1]) * (pa[1] - pb[1]));
      if (d > 0) seed = Math.max(seed, Math.min(expandMax, Math.max(1, userMult * Math.max(1, t.required / d))));
    }
    return seed;
  });
  // Refinement needs the output-space boxes even when the caller passed no `out`.
  const oref: { boxes?: DenseBox[] } = out ?? {};
  let result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, oref);

  // Refinement: expansion raises the global median edge length, so the real
  // post-warp contraction threshold is HIGHER than the pre-warp estimate the
  // first-pass demands targeted — and expanding further raises it again (edges
  // that straddle a box boundary stretch with the box and can dominate the
  // median), so a proportional bump chases a moving target and converges to the
  // threshold FROM BELOW without ever clearing it. Instead solve for the fixed
  // point: per box, both the inside-gap and the global need are affine in the
  // box's expand while the growth cap is slack (node positions are affine in
  // the push strengths), so a secant step through the last two (expand, gap,
  // need) states lands where the gap clears the need — with a small margin for
  // the model error — then rebuild and re-verify. Bounded passes; arithmetic is
  // + − × ÷ √ min max only, fixed iteration order → deterministic.
  {
    // Median gap of edges with BOTH endpoints inside the box — the statistic
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
    // pair-separation targets (CONSTANT need — capsule size doesn't move with
    // the warp). The secant solves each box against its worst violator; the
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
    for (let pass = 0; pass < 4; pass++) {
      const advected = g.nodes.map((p) => result.warp([p[0], p[1]]) as Pixel);
      const needAfter = (opts.cellFromMedLen(medianEdgeLenPx({ nodes: advected, edges: g.edges })) / 2) * slack;
      const now = boxes.map((_, i) => evalBox(i, oref.boxes![i], advected, needAfter));
      const eNext = expands.map((e, i) => {
        const { gap, need: needV } = now[i];
        if (!Number.isFinite(gap) || gap >= needV) return e; // cleared
        const margin = needV * 0.05; // headroom for the affine-model error
        // (the two 1e-9 guards below are just "<= 0 with an fp cushion";
        // scale-independent — the guarded deltas are far above 1e-9 whenever
        // a real step happened.)
        const de = e - ePrev[i];
        if (de <= 1e-9) return Math.min(expandMax, (e * (needV + margin)) / gap); // no slope yet: proportional seed
        const denom = (gap - prev[i].gap) - (needV - prev[i].need);
        // denom <= 0: the need rises at least as fast as this box's gap — the
        // target is out of reach of expansion alone; jump to the ceiling (the
        // growth cap then freezes the median so the gap can catch up).
        if (denom <= 1e-9) return expandMax;
        const target = e + ((needV + margin - gap) * de) / denom;
        return Math.min(expandMax, Math.max(e, target));
      });
      // No progress — every box either cleared or sits saturated at the
      // ceiling: another pass would rebuild bit-identically, so stop.
      if (eNext.every((e, i) => e === expands[i])) break;
      ePrev = expands; prev = now;
      expands = eNext;
      result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, oref);
    }
  }
  if (out) out.expands = expands;

  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_WARP_DEBUG) {
    const ex = expands.map((e) => e.toFixed(2)).join(',');
    console.error(
      `[boxwarp] boxes=${boxes.length} (density=${density.length} contraction=${contraction.length} capsule=${capsule.length}) ` +
      `cell=${cell.toFixed(1)} need=${need.toFixed(1)} expands=[${ex}] growth=${result.growthX.toFixed(2)},${result.growthY.toFixed(2)} (cap=${maxGrowth})`,
    );
  }
  return result;
}

/** Separable warp (global magnification) composed with the demand-driven box
 *  warp (local rectilinear room). Boxes are found — and demands measured — in
 *  SEPARABLE-WARPED space, so both the samples and the graph advect through
 *  `sep` first. Composition of fold-free maps is fold-free; growth comes only
 *  from the box layer (the separable CDF maps the canvas onto itself). */
export function buildSepDemandBoxWarp(
  samples: readonly Pixel[],
  g: BoxGraph,
  box: WarpBox,
  sepOpts: DensityWarpOptions,
  boxOpts: DemandOptions,
  out?: { boxes?: DenseBox[]; expands?: number[] },
): DemandWarpResult {
  const sep = buildDensityWarp(samples, box, sepOpts);
  const warpedSamples = samples.map((s) => sep([s[0], s[1]]) as Pixel);
  const warpedGraph: BoxGraph = { nodes: g.nodes.map((p) => sep([p[0], p[1]]) as Pixel), edges: g.edges };
  const bx = buildDemandBoxWarp(warpedSamples, warpedGraph, box, boxOpts, out);
  return { warp: (p) => bx.warp(sep(p)), growthX: bx.growthX, growthY: bx.growthY };
}
