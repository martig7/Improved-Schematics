// Density-equalizing spatial warp (Tobler pseudo-cartogram style): expand
// dense parts of the map at the expense of empty ones, the way hand-drawn NYC
// subway maps enlarge Manhattan relative to the outer boroughs. Applied to
// pixel space BEFORE octilinearization so the uniform grid effectively gets
// finer where the network is crowded — and to the water polygons through the
// same function so the geography deforms coherently.
//
// LOOM's authors list exactly this as future work (EuroVis 2020, §7: "It may
// be interesting to locally enlarge areas of the input line graph (for
// example, the city center) prior to octilinearization") — their Enlarger.cpp
// is an unfinished stub, so this is our own design.
//
// Method: per axis, build a Gaussian-smoothed histogram of station positions,
// mix it with a uniform floor, integrate to a piecewise-linear CDF F, and map
//   x' = (1-alpha)·x + alpha·(x0 + W·F(x))
// independently for x and y. Each axis map is strictly increasing (the floor
// guarantees a positive derivative), so the 2D warp is a product of two 1D
// homeomorphisms: unconditionally fold-free — no polygon can self-intersect,
// no ordering ever inverts, for ANY parameter values. It is also exactly
// invertible (piecewise linear), and O(1) per point after O(N+B) setup.

import type { Pixel } from './types';

export interface DensityWarpOptions {
  /** Histogram bins per axis. Default 96. */
  bins?: number;
  /** Gaussian smoothing radius in bins. Default 2.5. */
  sigmaBins?: number;
  /** Weight of measured density vs uniform floor (0..1). Default 0.7. */
  beta?: number;
  /** Warp strength: 0 = identity, 1 = full equalization. Default 0.6. */
  alpha?: number;
  /**
   * Clamp on local linear magnification. Default 8 (raised from the original 3
   * so line-rich hubs may dilate harder). The warp stays unconditionally
   * fold-free at any value, so set this very high to effectively remove the
   * ceiling — distortion is then bounded only by the density of the input.
   */
  maxScale?: number;
  /**
   * Floor on local linear scale — the symmetric counterpart of maxScale. The
   * warp magnifies the dense core by COMPRESSING the sparse periphery; left
   * unbounded that compression crushes peripheral station spacing below the octi
   * grid cell, so octi contracts the (now sub-cell) edges and strands terminus
   * markers off their line (the Newark/Queens edge-terminus disconnections).
   * Clamping the local scale >= minScale keeps peripheral gaps wide enough to
   * survive octilinearization. The natural unclamped minimum is 1 - alpha*beta
   * (~0.58 at the defaults), so any minScale at or below that is a no-op.
   * Default 0 (no extra floor). Raising it trades a little core magnification
   * for peripheral spacing (the canvas budget is fixed).
   */
  minScale?: number;
}

export type WarpFn = (p: Pixel) => Pixel;

export interface WarpBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function buildDensityWarp(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: DensityWarpOptions = {},
): WarpFn {
  const alpha = opts.alpha ?? 0.6;
  if (samples.length === 0 || alpha <= 0) return (p) => p;
  const fx = axisWarp(samples.map((s) => s[0]), box.minX, box.maxX, opts);
  const fy = axisWarp(samples.map((s) => s[1]), box.minY, box.maxY, opts);
  return (p) => [fx(p[0]), fy(p[1])];
}

function axisWarp(
  xs: number[],
  x0: number,
  x1: number,
  opts: DensityWarpOptions,
): (x: number) => number {
  const B = opts.bins ?? 96;
  const sigma = opts.sigmaBins ?? 2.5;
  const beta = opts.beta ?? 0.7;
  const alpha = opts.alpha ?? 0.6;
  const maxScale = opts.maxScale ?? 8;
  const W = x1 - x0;
  if (!(W > 0)) return (x) => x;

  // station histogram
  const h = new Float64Array(B);
  let total = 0;
  for (const x of xs) {
    const i = Math.min(B - 1, Math.max(0, Math.floor(((x - x0) / W) * B)));
    h[i]++;
    total++;
  }
  if (total === 0) return (x) => x;

  // gaussian smoothing
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * r + 1);
  let ksum = 0;
  for (let i = -r; i <= r; i++) {
    // Quantize the Gaussian weights: Math.exp is not correctly-rounded across
    // V8 builds, and this run-invariant kernel convolves the histogram → CDF →
    // every warped coordinate fed to the chaotic octi search. Rounding to 1e-12
    // (sub-ULP at coordinate scale) makes the warp map bit-identical cross-V8.
    kernel[i + r] = Math.round(Math.exp(-(i * i) / (2 * sigma * sigma)) * 1e12) / 1e12;
    ksum += kernel[i + r];
  }
  const hs = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    let v = 0;
    for (let j = -r; j <= r; j++) {
      const idx = Math.min(B - 1, Math.max(0, i + j)); // clamp at borders
      v += h[idx] * kernel[j + r];
    }
    hs[i] = v / ksum;
  }

  // mix with the uniform floor; rho sums to 1
  let hsum = 0;
  for (let i = 0; i < B; i++) hsum += hs[i];
  const rho = new Float64Array(B);
  for (let i = 0; i < B; i++) rho[i] = (1 - beta) / B + (beta * hs[i]) / hsum;

  // clamp the implied local scale s_i = (1-alpha) + alpha·B·rho_i into
  // [minScale, maxScale]: water-fill (clip both ends + renormalize) a few times.
  // rhoCap·B > 1 > rhoFloor·B keeps a valid distribution; rhoFloor floors the
  // sparse-region compression so peripheral gaps survive the octi grid.
  const minScale = opts.minScale ?? 0;
  const rhoCap = (maxScale - (1 - alpha)) / (alpha * B);
  const rhoFloor = Math.max(0, (minScale - (1 - alpha)) / (alpha * B));
  for (let it = 0; it < 16; it++) {
    let sum = 0;
    for (let i = 0; i < B; i++) {
      if (rho[i] > rhoCap) rho[i] = rhoCap;
      else if (rho[i] < rhoFloor) rho[i] = rhoFloor;
      sum += rho[i];
    }
    if (Math.abs(sum - 1) < 1e-9) break;
    for (let i = 0; i < B; i++) rho[i] /= sum;
  }

  // piecewise-linear CDF
  const cdf = new Float64Array(B + 1);
  for (let i = 0; i < B; i++) cdf[i + 1] = cdf[i] + rho[i];
  const norm = cdf[B];
  for (let i = 0; i <= B; i++) cdf[i] /= norm;

  return (x: number) => {
    const t = (x - x0) / W;
    let F: number;
    if (t <= 0) {
      F = t * B * (rho[0] / norm); // extend first-bin slope outward
    } else if (t >= 1) {
      F = 1 + (t - 1) * B * (rho[B - 1] / norm);
    } else {
      const u = t * B;
      const i = Math.min(B - 1, Math.floor(u));
      F = cdf[i] + (u - i) * (rho[i] / norm);
    }
    return (1 - alpha) * x + alpha * (x0 + W * F);
  };
}
