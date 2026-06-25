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
// Determinism: + − × ÷ and min only → bit-identical cross-V8.

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
