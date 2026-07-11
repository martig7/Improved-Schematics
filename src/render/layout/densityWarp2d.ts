// 2D excess-density grid: bins point samples, smooths them with a separable
// Gaussian, and returns a mean-zero excess-density field. This is the density
// oracle the demand box warp thresholds on to find dense sectors. Determinism:
// only + - * / plus Math.exp QUANTIZED to 1e-12, so it is bit-identical
// cross-V8.

import type { Pixel } from './types';
import type { WarpBox, DensityWarpOptions } from './densityWarp';

export interface DensityWarp2DOptions extends DensityWarpOptions {
  /** Repulsion kernel radius in PIXELS. Controls how local the expansion is. */
  sigmaPx?: number;
  /** Flow iterations (Gastner/Newman style). 1 = single pass, which is weak on
   *  extreme dynamic range because the global fold-clamp starves dense centres.
   *  >1 composes small fold-safe steps into a strong, density-equalizing warp.
   *  Default 1. */
  iterations?: number;
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
// bit-identical across V8 builds. Same discipline as densityWarp.ts.
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

  // rho has mean 1 ((1-beta)·1 + beta·1). CLIP rho to maxScale, a dynamic-range
  // cap. Without it one super-dense spot dominates max‖∇F‖ and collapses the
  // global fold-safe α to ~0, suppressing the warp everywhere. Re-centre
  // afterwards so e stays mean-zero (no drift).
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
