// Dense-box expansion warp. NOT density-equalizing — it finds the densest
// regions (cells above a fraction-of-peak cutoff, grouped into axis-aligned
// bounding boxes) and EXPANDS each to lower its crowding, leaving the far field
// geographically faithful. Rectilinear by construction (per-axis box bands, not
// a radial kernel that would round the whole map).
//
// Two stages. (1) SATURATE: each axis ramps at unit slope inside the box, eases
// the slope to 0 across the margin, then HOLDS constant — so the surround is
// carried outward rather than crammed back to identity. Tapering back to identity
// (the previous box-window) forced, by area conservation, a compression ring just
// outside the box — the "weirdly thin geography at the edge of growth". A
// saturating push keeps the per-axis map monotone (slope in [1, 1+strength]), so
// the raw expansion is fold-free at any strength and has NO localized thinning.
// (2) NORMALIZE: the saturating push grows the overall bbox, so rescale the
// warped canvas back to fit growthCap × the canvas PER AXIS — exactly the
// "balance" the separable warp gets for free (its CDF maps the canvas onto
// itself, filling it). This makes `expand` a RELATIVE core magnification instead
// of an absolute size multiplier (no 10× blowup), and the compensating shrink is
// one global per-axis rescale spread evenly across the whole map — so the only
// compression anywhere is that gentle factor, never a ring. Per axis (not a
// single uniform scale) so the warped canvas FILLS the canvas instead of
// letterboxing — a uniform scale leaves a bare-land margin that renders as
// "black edges" round the map.
//
// buildDemandBoxWarp (the demand-driven builder) supersedes the two-stage
// saturate/normalize scheme above: boxes come from density peaks ∪ predicted
// octi contraction, each box is expanded by exactly what its OWN edges need to
// survive contraction (per-box strengths, not one global `expand`), and the
// resulting growth is KEPT by growing the output canvas (up to `maxGrowth`)
// instead of normalizing it back to the input canvas. A bounded secant
// refinement pass then re-solves each box against the POST-warp threshold (the
// median edge length rises as boxes expand), and buildSepDemandBoxWarp composes
// the separable warp (global magnification) under the demand warp (local room).
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

export interface BoxWarpOptions extends DensityWarp2DOptionsLike {
  /** Cutoff as a fraction of the PEAK excess density (0–1): cells above
   *  frac·max are "dense". Threshold on the peak, NOT a percentile over all
   *  cells — most cells are empty, so a global percentile collapses to "above
   *  average" and grabs the whole halo. Higher frac = tighter core. Default 0.4. */
  frac?: number;
  /** Target expansion factor for a dense box (≥1). Default 1.4. */
  expand?: number;
  /** Saturation margin as a fraction of the box's larger half-extent: the
   *  per-axis slope eases from 1+strength back to 1 across this width, beyond
   *  which the push holds constant and the surround rigidly translates outward.
   *  Larger = softer box edge + more outward growth. Default 1. */
  marginFrac?: number;
  /** How much the overall map may grow: the warped canvas is uniformly rescaled
   *  to fit growthCap × the original canvas (1 = canvas-preserving, like the
   *  separable warp; 1.2 = allow 20% bigger). This is what keeps `expand` from
   *  blowing the map up — it makes `expand` a RELATIVE core magnification rather
   *  than an absolute size multiplier. Default 1. */
  growthCap?: number;
}

// (BoxWarpOptions extends the same option bag densityGrid2D reads.)
type DensityWarp2DOptionsLike = DensityWarpOptions & { sigmaPx?: number };

/** Find the densest regions as axis-aligned bounding boxes (pixel coords):
 *  threshold the smoothed excess-density grid at the pct-th percentile, then
 *  bound each 4-connected component of above-cutoff cells. */
export function findDenseBoxes(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: BoxWarpOptions = {},
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

/** Build the dense-box expansion warp. Drop-in WarpFn (same shape as
 *  buildDensityWarp). Identity where there are no dense boxes. When `out` is given,
 *  `out.boxes` is set to the dense boxes mapped THROUGH this warp (i.e. in the
 *  warp's OUTPUT space), so a caller can overlay where the magnified cores landed. */
export function buildBoxExpandWarp(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: BoxWarpOptions = {},
  out?: { boxes?: DenseBox[] },
): WarpFn {
  const boxes = findDenseBoxes(samples, box, opts);
  if (boxes.length === 0) { if (out) out.boxes = []; return (p) => [p[0], p[1]]; }
  const strengthTarget = Math.max(0, (opts.expand ?? 1.4) - 1);
  const marginFrac = opts.marginFrac ?? 1;
  // Identity warp (expand≈1): the dense regions exist but aren't magnified, so they
  // land where they are (input space == output space).
  if (strengthTarget === 0) { if (out) out.boxes = boxes.map((b) => ({ ...b })); return (p) => [p[0], p[1]]; }

  const bs = boxes.map((b) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const hx = (b.x1 - b.x0) / 2;
    const hy = (b.y1 - b.y0) / 2;
    const m = Math.max(1, marginFrac * Math.max(hx, hy)); // saturation margin (≥1px)
    return { cx, cy, hx, hy, m };
  });

  // Smooth saturating per-axis push (the strength-1 displacement). Inside the box
  // half-extent h the map ramps at unit slope (expansion); across the margin m
  // the slope eases linearly 1→0 (so there is no slope crease at the box edge);
  // beyond that the push is constant — the surround is rigidly translated
  // outward, NOT crammed back to identity. Odd-symmetric; the slope is in [0,1]
  // everywhere, so p + strength·push is monotone per axis ⇒ det ≥ 1 (no
  // thinning) and fold-free at any strength. ux depends only on px and uy only
  // on py, so the Jacobian is diagonal and det = (1+s·push'x)(1+s·push'y) ≥ 1.
  const push = (t: number, h: number, m: number): number => {
    const a = t < 0 ? -t : t; // |t|
    let p: number;
    if (a <= h) p = a;
    else if (a <= h + m) { const u = a - h; p = a - (u * u) / (2 * m); }
    else p = h + m / 2;
    return t < 0 ? -p : p;
  };
  const field = (px: number, py: number): [number, number] => {
    let ux = 0;
    let uy = 0;
    for (const b of bs) {
      ux += push(px - b.cx, b.hx, b.m);
      uy += push(py - b.cy, b.hy, b.m);
    }
    return [ux, uy];
  };

  // No fold-clamp: the saturating push is monotone per axis, so det ≥ 1 at any
  // strength. On its own the push grows the bbox by ~2·strength·(h + m/2) per box
  // per axis — the raw (pre-normalization) expansion.
  const strength = strengthTarget;
  const raw = (px: number, py: number): Pixel => {
    const [ux, uy] = field(px, py);
    return [px + strength * ux, py + strength * uy];
  };

  // Canvas-preserving normalization — restores the separable warp's "balance".
  // The raw push grows the overall bbox; rescale the warped canvas back to fit
  // growthCap × the original canvas, PER AXIS (like the separable warp's fx/fy),
  // so the warped canvas fills the canvas exactly instead of letterboxing. A
  // single (uniform) scale would leave a bare-canvas margin on the shorter axis —
  // that margin renders as the empty land base, the "black edges" round the map.
  // Per-axis fill removes it; the slight x-vs-y scale difference is a global
  // aspect adjustment (exactly what separable does), NOT localized thinning.
  // Net: the dense core is magnified RELATIVE to its surround, the compensating
  // shrink is one global per-axis rescale spread evenly across the map (no
  // compression ring, no blowup). `field` is monotone per axis and independent
  // across axes, so the warped canvas corners are the bbox extremes (no search).
  const cap = opts.growthCap ?? 1;
  const xl = raw(box.minX, box.minY)[0];
  const xr = raw(box.maxX, box.minY)[0];
  const yt = raw(box.minX, box.minY)[1];
  const yb = raw(box.minX, box.maxY)[1];
  const cw2 = box.maxX - box.minX;
  const ch2 = box.maxY - box.minY;
  const sx = (cw2 * cap) / (xr - xl);
  const sy = (ch2 * cap) / (yb - yt);
  const cxCanvas = (box.minX + box.maxX) / 2;
  const cyCanvas = (box.minY + box.maxY) / 2;
  const cxWarp = (xl + xr) / 2;
  const cyWarp = (yt + yb) / 2;
  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_WARP_DEBUG) {
    const sz = bs.map((b) => `${(2 * b.hx).toFixed(0)}x${(2 * b.hy).toFixed(0)}`).join(',');
    console.error(`[boxwarp] boxes=${bs.length} strength=${strength.toFixed(2)} rawGrowth=${((xr - xl) / cw2).toFixed(2)}x scale=${sx.toFixed(3)},${sy.toFixed(3)} (per-axis fill, cap=${cap}) sizes=[${sz}]`);
  }

  const warpFn: WarpFn = (p) => {
    const q = raw(p[0], p[1]);
    return [cxCanvas + (q[0] - cxWarp) * sx, cyCanvas + (q[1] - cyWarp) * sy];
  };
  // Map each dense box's corners through the warp into output space. The warp is
  // monotone increasing per axis, so an axis-aligned box stays axis-aligned and the
  // corner order (x0<x1, y0<y1) is preserved.
  if (out) {
    out.boxes = boxes.map((b) => {
      const a = warpFn([b.x0, b.y0]);
      const c = warpFn([b.x1, b.y1]);
      return { x0: a[0], y0: a[1], x1: c[0], y1: c[1] };
    });
  }
  return warpFn;
}

// Overlap the separable density warp with the dense-box expansion: separable
// supplies the GLOBAL magnification (blows the dense network up to readable size,
// the cross), then the box expansion adds LOCAL rectilinear room on the now-
// magnified dense core. The box must be found in the SEPARABLE-WARPED space (that
// is where the network sits after the first warp), so advect the samples through
// `sep` before box-finding. Composition of two fold-free maps is fold-free.
export function buildSepBoxWarp(
  samples: readonly Pixel[],
  box: WarpBox,
  sepOpts: DensityWarpOptions,
  boxOpts: BoxWarpOptions,
  out?: { boxes?: DenseBox[] },
): WarpFn {
  const sep = buildDensityWarp(samples, box, sepOpts);
  const warpedSamples = samples.map((s) => sep([s[0], s[1]]) as Pixel);
  // The boxes are found in separable-warped space and `bx` maps them to its output
  // space, which IS the composed warp's output (bx is applied last) — so `out.boxes`
  // is correct for the full sep+box warp without further mapping.
  const bx = buildBoxExpandWarp(warpedSamples, box, boxOpts, out);
  return (p) => bx(sep(p));
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
  // Same smooth saturating odd-symmetric push as buildBoxExpandWarp (slope in
  // [0,1] ⇒ each s·push term is monotone ⇒ the sum is monotone per axis ⇒
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
 *  contraction, each expanded by exactly what its edges need to survive
 *  contraction (× userMult), growth absorbed by the canvas up to maxGrowth. */
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
  const boxes = mergeIntersectingBoxes([...density, ...contraction]);
  if (boxes.length === 0) {
    if (out) { out.boxes = []; out.expands = []; }
    return { warp: (p) => [p[0], p[1]], growthX: 1, growthY: 1 };
  }

  const gaps = nodeGaps(g);
  const need = (cell / 2) * slack;
  let expands = boxes.map((b) => boxDemand(b, g.nodes, gaps, need, userMult, expandMax));
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
    // Previous secant point per box: the UNWARPED state (expand 1, input-space box).
    let ePrev = boxes.map(() => 1);
    let gapPrev = boxes.map((b) => gapInBox(b, g.nodes));
    let needPrev = need;
    for (let pass = 0; pass < 4; pass++) {
      const advected = g.nodes.map((p) => result.warp([p[0], p[1]]) as Pixel);
      const needAfter = (opts.cellFromMedLen(medianEdgeLenPx({ nodes: advected, edges: g.edges })) / 2) * slack;
      const gapNow = boxes.map((_, i) => gapInBox(oref.boxes![i], advected));
      const eNext = expands.map((e, i) => {
        const gap = gapNow[i];
        if (!Number.isFinite(gap) || gap >= needAfter) return e; // cleared
        const margin = needAfter * 0.05; // headroom for the affine-model error
        // (the two 1e-9 guards below are just "<= 0 with an fp cushion";
        // scale-independent — the guarded deltas are far above 1e-9 whenever
        // a real step happened.)
        const de = e - ePrev[i];
        if (de <= 1e-9) return Math.min(expandMax, (e * (needAfter + margin)) / gap); // no slope yet: proportional seed
        const denom = (gap - gapPrev[i]) - (needAfter - needPrev);
        // denom <= 0: the need rises at least as fast as this box's gap — the
        // target is out of reach of expansion alone; jump to the ceiling (the
        // growth cap then freezes the median so the gap can catch up).
        if (denom <= 1e-9) return expandMax;
        const target = e + ((needAfter + margin - gap) * de) / denom;
        return Math.min(expandMax, Math.max(e, target));
      });
      // No progress — every box either cleared or sits saturated at the
      // ceiling: another pass would rebuild bit-identically, so stop.
      if (eNext.every((e, i) => e === expands[i])) break;
      ePrev = expands; gapPrev = gapNow; needPrev = needAfter;
      expands = eNext;
      result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, oref);
    }
  }
  if (out) out.expands = expands;

  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_WARP_DEBUG) {
    const ex = expands.map((e) => e.toFixed(2)).join(',');
    console.error(
      `[boxwarp] boxes=${boxes.length} (density=${density.length} contraction=${contraction.length}) ` +
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
