// 2D LOCAL density-equalizing warp (vs. the separable rows/columns warp in
// densityWarp.ts). Builds a 2D excess-density grid, convolves it with a radial
// repulsion kernel that pushes space OUTWARD from dense cells, auto-clamps the
// strength so the Jacobian stays positive everywhere (unconditionally fold-free),
// and returns a closure that bilinearly interpolates x + α·F(x). Expansion
// concentrates on dense SECTORS, not whole rows/columns. Determinism: only
// + − × ÷ √ plus Math.exp QUANTIZED to 1e-12, so it is bit-identical cross-V8.
// Spec: docs/superpowers/specs/2026-06-17-2d-density-warp-design.md

import type { Pixel } from './types';
import type { WarpBox, WarpFn, DensityWarpOptions } from './densityWarp';

export interface DensityWarp2DOptions extends DensityWarpOptions {
  /** Repulsion kernel radius in PIXELS — how local the expansion is. */
  sigmaPx?: number;
  /** Flow iterations (Gastner–Newman style). 1 = single pass (weak on extreme
   *  dynamic range — the global fold-clamp starves dense centres). >1 composes
   *  small fold-safe steps into a strong, density-equalizing warp. Default 1. */
  iterations?: number;
}

// Bilinear sample of a scalar grid A at pixel (px,py); edge-clamped so out-of-box
// points use the edge field (keeps the composite map fold-free).
function sampleGrid(
  A: Float64Array, B: number, x0: number, y0: number, cw: number, ch: number, px: number, py: number,
): number {
  let u = (px - x0) / cw - 0.5;
  if (u < 0) u = 0;
  else if (u > B - 1) u = B - 1;
  let v = (py - y0) / ch - 0.5;
  if (v < 0) v = 0;
  else if (v > B - 1) v = B - 1;
  const i0 = Math.min(B - 2, Math.floor(u));
  const j0 = Math.min(B - 2, Math.floor(v));
  const tu = u - i0;
  const tv = v - j0;
  return (
    A[j0 * B + i0] * (1 - tu) * (1 - tv) +
    A[j0 * B + i0 + 1] * tu * (1 - tv) +
    A[(j0 + 1) * B + i0] * (1 - tu) * tv +
    A[(j0 + 1) * B + i0 + 1] * tu * tv
  );
}

export interface DensityGrid2D {
  e: Float64Array; // excess density, mean 0, row-major bins×bins
  bins: number;
  x0: number;
  y0: number;
  cw: number; // cell width (px)
  ch: number; // cell height (px)
}

// Quantize exp to 1e-12 (sub-ULP at coordinate scale) so the smoothing kernel is
// bit-identical across V8 builds — identical discipline to densityWarp.ts.
const qexp = (x: number): number => Math.round(Math.exp(x) * 1e12) / 1e12;

export function densityGrid2D(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: DensityWarp2DOptions = {},
): DensityGrid2D {
  const B = opts.bins ?? 96;
  const sigmaBins = opts.sigmaBins ?? 2.5;
  const beta = opts.beta ?? 0.7;
  const cw = (box.maxX - box.minX) / B;
  const ch = (box.maxY - box.minY) / B;

  const h = new Float64Array(B * B);
  for (const s of samples) {
    const ix = Math.min(B - 1, Math.max(0, Math.floor((s[0] - box.minX) / cw)));
    const iy = Math.min(B - 1, Math.max(0, Math.floor((s[1] - box.minY) / ch)));
    h[iy * B + ix]++;
  }

  // separable Gaussian smoothing (clamped borders), quantized kernel
  const r = Math.max(1, Math.ceil(sigmaBins * 3));
  const kernel = new Float64Array(2 * r + 1);
  let ksum = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = qexp(-(i * i) / (2 * sigmaBins * sigmaBins));
    ksum += kernel[i + r];
  }
  const tmp = new Float64Array(B * B);
  for (let y = 0; y < B; y++)
    for (let x = 0; x < B; x++) {
      let v = 0;
      for (let j = -r; j <= r; j++) {
        const xx = Math.min(B - 1, Math.max(0, x + j));
        v += h[y * B + xx] * kernel[j + r];
      }
      tmp[y * B + x] = v / ksum;
    }
  const hs = new Float64Array(B * B);
  for (let y = 0; y < B; y++)
    for (let x = 0; x < B; x++) {
      let v = 0;
      for (let j = -r; j <= r; j++) {
        const yy = Math.min(B - 1, Math.max(0, y + j));
        v += tmp[yy * B + x] * kernel[j + r];
      }
      hs[y * B + x] = v / ksum;
    }

  // rho has mean 1 ((1-beta)·1 + beta·1). CLIP rho to maxScale (the 1D warp's
  // dynamic-range cap): without it one super-dense spot (Manhattan ≈ 55× mean)
  // dominates max‖∇F‖ and collapses the global fold-safe α to ~0, suppressing
  // the warp everywhere. Re-centre afterwards so e stays mean-zero (no drift).
  const maxScale = opts.maxScale ?? 8;
  let hsum = 0;
  for (let i = 0; i < B * B; i++) hsum += hs[i];
  const mean = hsum / (B * B) || 1;
  const e = new Float64Array(B * B);
  let esum = 0;
  for (let i = 0; i < B * B; i++) {
    let rho = (1 - beta) + beta * (hs[i] / mean);
    if (rho > maxScale) rho = maxScale;
    e[i] = rho;
    esum += rho;
  }
  const emean = esum / (B * B);
  for (let i = 0; i < B * B; i++) e[i] -= emean;

  return { e, bins: B, x0: box.minX, y0: box.minY, cw, ch };
}

// Radial repulsion displacement field: F(x) = Σ_cells e_c·(x−c)·w(|x−c|), so a
// dense cell (e>0) pushes nearby space outward (expands its sector) and a sparse
// cell (e<0) pulls inward. Computed per grid cell with the kernel precomputed
// once (the only exp calls), then bilinearly sampled by buildDensityWarp2D.
export function displacementField2D(
  grid: DensityGrid2D,
  sigmaPx: number,
): { Fx: Float64Array; Fy: Float64Array } {
  const { e, bins: B, cw, ch } = grid;
  const Fx = new Float64Array(B * B);
  const Fy = new Float64Array(B * B);
  const cell = Math.min(cw, ch);
  const rad = Math.max(1, Math.ceil((3 * sigmaPx) / cell));
  const s2 = 2 * sigmaPx * sigmaPx;

  // precompute kernel per cell-offset o = (source − query): the query is pushed
  // by e·(query − source)·w(|·|) = e·(−o·cellSize)·w. Store kxw/kyw.
  const span = 2 * rad + 1;
  const kxw = new Float64Array(span * span);
  const kyw = new Float64Array(span * span);
  for (let oy = -rad; oy <= rad; oy++)
    for (let ox = -rad; ox <= rad; ox++) {
      const ddx = ox * cw;
      const ddy = oy * ch;
      const w = qexp(-(ddx * ddx + ddy * ddy) / s2);
      kxw[(oy + rad) * span + (ox + rad)] = -ddx * w; // query − source = −(source − query)
      kyw[(oy + rad) * span + (ox + rad)] = -ddy * w;
    }

  for (let qy = 0; qy < B; qy++)
    for (let qx = 0; qx < B; qx++) {
      let fx = 0;
      let fy = 0;
      for (let oy = -rad; oy <= rad; oy++) {
        const cy = qy + oy;
        if (cy < 0 || cy >= B) continue;
        for (let ox = -rad; ox <= rad; ox++) {
          const cx = qx + ox;
          if (cx < 0 || cx >= B) continue;
          const ec = e[cy * B + cx];
          if (ec === 0) continue;
          const ki = (oy + rad) * span + (ox + rad);
          fx += ec * kxw[ki];
          fy += ec * kyw[ki];
        }
      }
      Fx[qy * B + qx] = fx;
      Fy[qy * B + qx] = fy;
    }
  return { Fx, Fy };
}

// W(x) = x + α·F(x) is fold-free iff det(I + α·∇F) > 0 everywhere. ‖∇F‖·α < 1 is
// a sufficient condition, so clamp α to 0.9/M where M = max grid Frobenius ‖∇F‖
// (an upper bound on the spectral norm — conservative, never under-clamps, and
// pure √ + arithmetic, no eigenvalue solve).
export function foldSafeAlpha(
  Fx: Float64Array,
  Fy: Float64Array,
  grid: DensityGrid2D,
  alphaTarget: number,
): number {
  const { bins: B, cw, ch } = grid;
  let M = 0;
  for (let y = 1; y < B - 1; y++)
    for (let x = 1; x < B - 1; x++) {
      const dFxdx = (Fx[y * B + x + 1] - Fx[y * B + x - 1]) / (2 * cw);
      const dFxdy = (Fx[(y + 1) * B + x] - Fx[(y - 1) * B + x]) / (2 * ch);
      const dFydx = (Fy[y * B + x + 1] - Fy[y * B + x - 1]) / (2 * cw);
      const dFydy = (Fy[(y + 1) * B + x] - Fy[(y - 1) * B + x]) / (2 * ch);
      const fro = Math.sqrt(dFxdx * dFxdx + dFxdy * dFxdy + dFydx * dFydx + dFydy * dFydy);
      if (fro > M) M = fro;
    }
  if (!(M > 0)) return alphaTarget;
  return Math.min(alphaTarget, 0.9 / M);
}

// Public entry: build the 2D local density warp. Same signature as
// buildDensityWarp (densityWarp.ts) so it is a drop-in in renderGeographic.
// Iterates the repulsion field (Gastner–Newman flow): each step is a small
// fold-safe displacement, re-measured on the advected samples; the composite of
// fold-free maps is fold-free, and the cumulative warp is strong enough to
// expand dense sectors that a single pass cannot (global-α starvation). The
// returned WarpFn replays the stored steps in sequence on any query point.
export function buildDensityWarp2D(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: DensityWarp2DOptions = {},
): WarpFn {
  const alphaTarget = opts.alpha ?? 0.8;
  if (samples.length === 0 || alphaTarget <= 0) return (p) => [p[0], p[1]];
  const sigmaPx = opts.sigmaPx ?? (box.maxX - box.minX) / 12;
  const iters = Math.max(1, Math.floor(opts.iterations ?? 1));
  const B = opts.bins ?? 96;
  const x0 = box.minX;
  const y0 = box.minY;
  const cw = (box.maxX - box.minX) / B;
  const ch = (box.maxY - box.minY) / B;

  const steps: { Fx: Float64Array; Fy: Float64Array; alpha: number }[] = [];
  const pos: Pixel[] = samples.map((s) => [s[0], s[1]]); // advected through the flow
  for (let k = 0; k < iters; k++) {
    const grid = densityGrid2D(pos, box, opts);
    const { Fx, Fy } = displacementField2D(grid, sigmaPx);
    const alpha = foldSafeAlpha(Fx, Fy, grid, alphaTarget);
    if (!(alpha > 0)) break;
    steps.push({ Fx, Fy, alpha });
    if (k < iters - 1) {
      for (const p of pos) {
        const fx = sampleGrid(Fx, B, x0, y0, cw, ch, p[0], p[1]);
        const fy = sampleGrid(Fy, B, x0, y0, cw, ch, p[0], p[1]);
        p[0] += alpha * fx;
        p[1] += alpha * fy;
      }
    }
  }

  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_WARP_DEBUG) {
    const a0 = steps[0]?.alpha ?? 0;
    const aN = steps[steps.length - 1]?.alpha ?? 0;
    console.error(`[warp2d] iters=${steps.length}/${iters} sigmaPx=${sigmaPx.toFixed(0)} alpha[0]=${a0.toExponential(2)} alpha[last]=${aN.toExponential(2)}`);
  }

  return (q) => {
    let x = q[0];
    let y = q[1];
    for (const st of steps) {
      const fx = sampleGrid(st.Fx, B, x0, y0, cw, ch, x, y);
      const fy = sampleGrid(st.Fy, B, x0, y0, cw, ch, x, y);
      x += st.alpha * fx;
      y += st.alpha * fy;
    }
    return [x, y];
  };
}
