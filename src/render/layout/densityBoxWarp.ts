// Dense-box expansion warp. NOT density-equalizing — it finds the densest
// regions (cells above a percentile cutoff, grouped into axis-aligned bounding
// boxes) and modestly EXPANDS each to lower its crowding, leaving the rest of
// the map geographically faithful. Rectilinear by construction: the expansion
// window tapers by BOX (Chebyshev) distance, so a box grows into a bigger box
// rather than a circle (the radial-kernel approach rounded the whole map).
// Modest expansion ⇒ small gradients ⇒ fold-safe in a single pass (no flow, no
// global-α starvation). Determinism: + − × ÷ √ plus densityGrid2D's quantized
// exp → bit-identical cross-V8.

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
  /** Taper margin as a fraction of the box's larger half-extent. Default 1. */
  marginFrac?: number;
}

// (BoxWarpOptions extends the same option bag densityGrid2D reads.)
type DensityWarp2DOptionsLike = DensityWarpOptions & { sigmaPx?: number };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Largest strength s for which W = p + s·field stays fold-free, i.e. the Jacobian
// det = 1 + s·tr(∇field) + s²·det(∇field) ≥ `floor` at every grid cell. This is
// the TRUE limit — far higher than a Frobenius-norm bound, which the box's
// uniform-scale interior (∇field=I, always fold-free) would peg at 0.9/√2.
// Binary search (fixed iters → deterministic); floor keeps any cell from
// compressing below `floor` area. Pure arithmetic, cross-V8 stable.
function foldSafeStrength(
  Fx: Float64Array, Fy: Float64Array, B: number, cw: number, ch: number, target: number, floor: number,
): number {
  const a: number[] = [], b: number[] = [], c: number[] = [], d: number[] = [];
  for (let y = 1; y < B - 1; y++)
    for (let x = 1; x < B - 1; x++) {
      a.push((Fx[y * B + x + 1] - Fx[y * B + x - 1]) / (2 * cw)); // dFx/dx
      b.push((Fx[(y + 1) * B + x] - Fx[(y - 1) * B + x]) / (2 * ch)); // dFx/dy
      c.push((Fy[y * B + x + 1] - Fy[y * B + x - 1]) / (2 * cw)); // dFy/dx
      d.push((Fy[(y + 1) * B + x] - Fy[(y - 1) * B + x]) / (2 * ch)); // dFy/dy
    }
  const n = a.length;
  const minDet = (s: number): number => {
    let m = Infinity;
    for (let i = 0; i < n; i++) {
      const det = 1 + s * (a[i] + d[i]) + s * s * (a[i] * d[i] - b[i] * c[i]);
      if (det < m) m = det;
    }
    return m;
  };
  if (minDet(target) >= floor) return target;
  let lo = 0;
  let hi = target;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (minDet(mid) >= floor) lo = mid;
    else hi = mid;
  }
  return lo;
}

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
 *  buildDensityWarp). Identity where there are no dense boxes. */
export function buildBoxExpandWarp(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: BoxWarpOptions = {},
): WarpFn {
  const boxes = findDenseBoxes(samples, box, opts);
  if (boxes.length === 0) return (p) => [p[0], p[1]];
  const strengthTarget = Math.max(0, (opts.expand ?? 1.4) - 1);
  const marginFrac = opts.marginFrac ?? 1;
  if (strengthTarget === 0) return (p) => [p[0], p[1]];

  const bs = boxes.map((b) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const hx = (b.x1 - b.x0) / 2;
    const hy = (b.y1 - b.y0) / 2;
    const m = Math.max(1, marginFrac * Math.max(hx, hy)); // taper width (≥1px)
    return { cx, cy, hx, hy, m };
  });

  // displacement at strength 1: push each point outward by a BOX-windowed amount
  // (wx·wy, each axis tapering linearly over the margin) so the box grows into a
  // bigger box and the surround returns to identity beyond the margin.
  const field = (px: number, py: number): [number, number] => {
    let ux = 0;
    let uy = 0;
    for (const b of bs) {
      const dx = px - b.cx;
      const dy = py - b.cy;
      const wx = clamp01(1 - Math.max(0, Math.abs(dx) - b.hx) / b.m);
      const wy = clamp01(1 - Math.max(0, Math.abs(dy) - b.hy) / b.m);
      const w = wx * wy;
      ux += dx * w;
      uy += dy * w;
    }
    return [ux, uy];
  };

  // fold-safe strength: u = strength·field, so det(I+∇u)>0 ⇐ strength·max‖∇field‖<1.
  // Sample ‖∇field‖ on a grid and clamp (reuses foldSafeAlpha).
  const B = opts.bins ?? 96;
  const cw = (box.maxX - box.minX) / B;
  const ch = (box.maxY - box.minY) / B;
  const Fx = new Float64Array(B * B);
  const Fy = new Float64Array(B * B);
  for (let j = 0; j < B; j++)
    for (let i = 0; i < B; i++) {
      const [fx, fy] = field(box.minX + (i + 0.5) * cw, box.minY + (j + 0.5) * ch);
      Fx[j * B + i] = fx;
      Fy[j * B + i] = fy;
    }
  // true fold limit (floor 0.1 = no cell compresses below 10% area)
  const strength = foldSafeStrength(Fx, Fy, B, cw, ch, strengthTarget, 0.1);
  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_WARP_DEBUG) {
    const sz = bs.map((b) => `${(2 * b.hx).toFixed(0)}x${(2 * b.hy).toFixed(0)}`).join(',');
    console.error(`[boxwarp] boxes=${bs.length} strengthTarget=${strengthTarget.toFixed(2)} strength=${strength.toFixed(3)} (fold-clamped) sizes=[${sz}]`);
  }

  return (p) => {
    const [ux, uy] = field(p[0], p[1]);
    return [p[0] + strength * ux, p[1] + strength * uy];
  };
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
): WarpFn {
  const sep = buildDensityWarp(samples, box, sepOpts);
  const warpedSamples = samples.map((s) => sep([s[0], s[1]]) as Pixel);
  const bx = buildBoxExpandWarp(warpedSamples, box, boxOpts);
  return (p) => bx(sep(p));
}
