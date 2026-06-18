# 2D Local Density Warp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separable (rows/columns) density warp with an opt-in 2D local density-repulsion warp that expands dense *sectors*, fold-free and cross-V8 deterministic.

**Architecture:** New pure module `src/render/layout/densityWarp2d.ts` exporting `buildDensityWarp2D(samples, box, opts): WarpFn` (same signature as the existing `buildDensityWarp`). It builds a 2D excess-density grid, convolves it with a radial repulsion kernel into a displacement field `F`, auto-clamps the strength `α` so the Jacobian stays positive everywhere (fold-free), and returns a closure that bilinearly interpolates `x + α·F(x)`. `renderGeographic` selects it via `OCTI_WARP_MODE=2d` (default stays `separable`). The existing `__warpDebug` stash + `dev/warp-heatmap.ts` visualize it unchanged.

**Tech Stack:** TypeScript, `tsx --test` (node:test), Vite build. Determinism rule: only `+ − × ÷ √` plus `Math.exp` **quantized** to 1e-12 (matches `densityWarp.ts`).

**Spec:** `docs/superpowers/specs/2026-06-17-2d-density-warp-design.md`

**Commit note:** This repo's owner commits deliberately and is currently on `master` with other uncommitted work. Before the first commit, branch off master (e.g. `feat/2d-density-warp`). The per-task commit steps below are the intended granularity; confirm with the user if they prefer to batch.

---

## Reference: shared types (already exist in `src/render/layout/densityWarp.ts`)

```typescript
export interface WarpBox { minX: number; minY: number; maxX: number; maxY: number; }
export type WarpFn = (p: Pixel) => Pixel;           // Pixel = [number, number] from './types'
export interface DensityWarpOptions {
  bins?: number; sigmaBins?: number; beta?: number; alpha?: number; maxScale?: number;
}
```

The new module imports these. `Pixel` comes from `./types`.

---

## Task 1: 2D excess-density grid

Build a mean-zero 2D excess-density grid from the weighted samples: 2D histogram → separable Gaussian smoothing (quantized `exp`) → uniform-floor mix → subtract mean.

**Files:**
- Create: `src/render/layout/densityWarp2d.ts`
- Test: `src/render/layout/densityWarp2d.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/render/layout/densityWarp2d.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densityGrid2D } from './densityWarp2d';
import type { Pixel } from './types';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

test('densityGrid2D: excess density is mean-zero', () => {
  const samples: Pixel[] = [[20, 20], [21, 19], [22, 21], [80, 80]];
  const g = densityGrid2D(samples, BOX, { bins: 16, sigmaBins: 1.5, beta: 0.7 });
  assert.equal(g.bins, 16);
  assert.equal(g.e.length, 16 * 16);
  let sum = 0;
  for (let i = 0; i < g.e.length; i++) sum += g.e[i];
  assert.ok(Math.abs(sum) < 1e-9, `excess should sum to ~0, got ${sum}`);
});

test('densityGrid2D: dense corner has positive excess, empty corner negative', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 50; k++) samples.push([10 + (k % 5), 10 + ((k / 5) | 0)]); // tight cluster near (10,10)
  const g = densityGrid2D(samples, BOX, { bins: 16, sigmaBins: 1.5, beta: 0.7 });
  const at = (px: number, py: number) =>
    g.e[Math.min(15, (py / (100 / 16)) | 0) * 16 + Math.min(15, (px / (100 / 16)) | 0)];
  assert.ok(at(11, 11) > 0, 'dense cell positive');
  assert.ok(at(90, 90) < 0, 'empty cell negative');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: FAIL — `densityGrid2D` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/render/layout/densityWarp2d.ts
import type { Pixel } from './types';
import type { WarpBox, WarpFn, DensityWarpOptions } from './densityWarp';

export interface DensityWarp2DOptions extends DensityWarpOptions {
  /** Repulsion kernel radius in PIXELS — how local the expansion is. */
  sigmaPx?: number;
}

export interface DensityGrid2D {
  e: Float64Array; // excess density, mean 0, row-major bins×bins
  bins: number;
  x0: number; y0: number; cw: number; ch: number; // cell origin + size (px)
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
  for (let i = -r; i <= r; i++) { kernel[i + r] = qexp(-(i * i) / (2 * sigmaBins * sigmaBins)); ksum += kernel[i + r]; }
  const tmp = new Float64Array(B * B);
  for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
    let v = 0; for (let j = -r; j <= r; j++) { const xx = Math.min(B - 1, Math.max(0, x + j)); v += h[y * B + xx] * kernel[j + r]; }
    tmp[y * B + x] = v / ksum;
  }
  const hs = new Float64Array(B * B);
  for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
    let v = 0; for (let j = -r; j <= r; j++) { const yy = Math.min(B - 1, Math.max(0, y + j)); v += tmp[yy * B + x] * kernel[j + r]; }
    hs[y * B + x] = v / ksum;
  }

  // rho has mean 1 ((1-beta)·1 + beta·1); e = rho - 1 has mean exactly 0
  let hsum = 0; for (let i = 0; i < B * B; i++) hsum += hs[i];
  const mean = hsum / (B * B) || 1;
  const e = new Float64Array(B * B);
  for (let i = 0; i < B * B; i++) e[i] = (1 - beta) + beta * (hs[i] / mean) - 1;

  return { e, bins: B, x0: box.minX, y0: box.minY, cw, ch };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/densityWarp2d.ts src/render/layout/densityWarp2d.test.ts
git commit -m "feat(warp): 2D excess-density grid (densityGrid2D)"
```

---

## Task 2: Radial repulsion displacement field

Convolve the excess-density grid with a radial kernel that pushes space outward from dense cells, producing `Fx`/`Fy` grids. Precompute the kernel once (the only `exp` calls).

**Files:**
- Modify: `src/render/layout/densityWarp2d.ts`
- Test: `src/render/layout/densityWarp2d.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to densityWarp2d.test.ts (densityGrid2D already imported in Task 1)
import { displacementField2D } from './densityWarp2d';

test('displacementField2D: pushes outward from a dense cluster', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 80; k++) samples.push([50 + ((k % 4) - 2), 50 + (((k / 4) | 0) % 4 - 2)]); // cluster at center (50,50)
  const grid = densityGrid2D(samples, BOX, { bins: 32, sigmaBins: 1.5, beta: 0.8 });
  const { Fx, Fy } = displacementField2D(grid, 10);
  const idx = (px: number, py: number) => (Math.min(31, (py / (100 / 32)) | 0)) * 32 + Math.min(31, (px / (100 / 32)) | 0);
  // a point to the RIGHT of center should be pushed further right (Fx > 0)
  assert.ok(Fx[idx(62, 50)] > 0, `right of cluster pushed right, got ${Fx[idx(62, 50)]}`);
  // a point ABOVE center (smaller y) pushed further up (Fy < 0)
  assert.ok(Fy[idx(50, 38)] < 0, `above cluster pushed up, got ${Fy[idx(50, 38)]}`);
  // at the exact center the radial field cancels (~0)
  assert.ok(Math.abs(Fx[idx(50, 50)]) < 1e-6 && Math.abs(Fy[idx(50, 50)]) < 1e-6, 'center ~0');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: FAIL — `displacementField2D` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to densityWarp2d.ts
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

  // precompute kernel: for offset o = (source − query) cell delta, the query is
  // pushed by e·(query − source)·w(|·|) = e·(−o·cellSize)·w. Store kxw/kyw.
  const span = 2 * rad + 1;
  const kxw = new Float64Array(span * span);
  const kyw = new Float64Array(span * span);
  for (let oy = -rad; oy <= rad; oy++) for (let ox = -rad; ox <= rad; ox++) {
    const ddx = ox * cw, ddy = oy * ch;          // source − query, in px
    const w = qexp(-(ddx * ddx + ddy * ddy) / s2);
    kxw[(oy + rad) * span + (ox + rad)] = -ddx * w; // query − source = −(source − query)
    kyw[(oy + rad) * span + (ox + rad)] = -ddy * w;
  }

  for (let qy = 0; qy < B; qy++) for (let qx = 0; qx < B; qx++) {
    let fx = 0, fy = 0;
    for (let oy = -rad; oy <= rad; oy++) {
      const cy = qy + oy; if (cy < 0 || cy >= B) continue;
      for (let ox = -rad; ox <= rad; ox++) {
        const cx = qx + ox; if (cx < 0 || cx >= B) continue;
        const ec = e[cy * B + cx]; if (ec === 0) continue;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/densityWarp2d.ts src/render/layout/densityWarp2d.test.ts
git commit -m "feat(warp): radial repulsion displacement field (displacementField2D)"
```

---

## Task 3: Fold-safe α clamp

Compute the max Frobenius norm of `∇F` over the grid (central differences) and return `α_safe = min(α_target, 0.9/M)` — the sufficient condition for a fold-free Jacobian.

**Files:**
- Modify: `src/render/layout/densityWarp2d.ts`
- Test: `src/render/layout/densityWarp2d.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to densityWarp2d.test.ts
import { foldSafeAlpha } from './densityWarp2d';

test('foldSafeAlpha: clamps below 0.9/M, never above target', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 300; k++) samples.push([50, 50]); // pathological spike → large ∇F
  const grid = densityGrid2D(samples, BOX, { bins: 32, sigmaBins: 1.5, beta: 0.9 });
  const { Fx, Fy } = displacementField2D(grid, 8);
  const a = foldSafeAlpha(Fx, Fy, grid, 0.8);
  assert.ok(a > 0 && a <= 0.8, `0 < α ≤ target, got ${a}`);
});

test('foldSafeAlpha: flat field → returns target unchanged', () => {
  const grid = densityGrid2D([], BOX, { bins: 16 }); // no samples → e all 0
  const Fx = new Float64Array(16 * 16), Fy = new Float64Array(16 * 16); // F = 0 → M = 0
  assert.equal(foldSafeAlpha(Fx, Fy, grid, 0.8), 0.8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: FAIL — `foldSafeAlpha` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to densityWarp2d.ts
export function foldSafeAlpha(
  Fx: Float64Array,
  Fy: Float64Array,
  grid: DensityGrid2D,
  alphaTarget: number,
): number {
  const { bins: B, cw, ch } = grid;
  let M = 0;
  for (let y = 1; y < B - 1; y++) for (let x = 1; x < B - 1; x++) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/densityWarp2d.ts src/render/layout/densityWarp2d.test.ts
git commit -m "feat(warp): fold-safe alpha clamp (foldSafeAlpha)"
```

---

## Task 4: Assemble `buildDensityWarp2D` + WarpFn

Tie the pieces together into the public `buildDensityWarp2D` returning a `WarpFn` that bilinearly interpolates `F` and returns `x + α·F(x)`. Add the key property tests: identity on uniform input, **local** expansion (not a band), fold-free, deterministic.

**Files:**
- Modify: `src/render/layout/densityWarp2d.ts`
- Test: `src/render/layout/densityWarp2d.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to densityWarp2d.test.ts
import { buildDensityWarp2D } from './densityWarp2d';

// numeric area magnification J = det(Jacobian of W) at p, via finite differences
function jacDet(W: (p: Pixel) => Pixel, p: Pixel, h = 0.5): number {
  const wx1 = W([p[0] + h, p[1]]), wx0 = W([p[0] - h, p[1]]);
  const wy1 = W([p[0], p[1] + h]), wy0 = W([p[0], p[1] - h]);
  const a = (wx1[0] - wx0[0]) / (2 * h), b = (wy1[0] - wy0[0]) / (2 * h);
  const c = (wx1[1] - wx0[1]) / (2 * h), d = (wy1[1] - wy0[1]) / (2 * h);
  return a * d - b * c;
}

test('buildDensityWarp2D: uniform samples → near-identity', () => {
  const samples: Pixel[] = [];
  for (let y = 5; y < 100; y += 10) for (let x = 5; x < 100; x += 10) samples.push([x, y]);
  const W = buildDensityWarp2D(samples, BOX, { alpha: 0.8, bins: 32, sigmaPx: 10 });
  const p: Pixel = [50, 50];
  const out = W(p);
  assert.ok(Math.hypot(out[0] - p[0], out[1] - p[1]) < 2, 'uniform → ~no displacement');
});

test('buildDensityWarp2D: dense cluster expands LOCALLY, not its whole row/column', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 120; k++) samples.push([50 + ((k % 6) - 3), 50 + (((k / 6) | 0) % 6 - 3)]); // cluster at (50,50)
  const W = buildDensityWarp2D(samples, BOX, { alpha: 0.8, bins: 48, sigmaPx: 8 });
  const jCenter = jacDet(W, [50, 50]);          // inside cluster → expanded
  const jSameRow = jacDet(W, [88, 50]);         // same row, far from cluster
  const jSameCol = jacDet(W, [50, 12]);         // same column, far from cluster
  assert.ok(jCenter > 1.2, `cluster expands, J=${jCenter.toFixed(2)}`);
  // locality (the whole point): a far same-row / same-column point is NOT
  // co-stretched. The separable warp would make these ≈ jCenter; the 2D warp
  // leaves them near 1. Absolute bound, so it cleanly distinguishes the two.
  assert.ok(jSameRow < 1.1, `row neighbour not co-stretched, J=${jSameRow.toFixed(2)}`);
  assert.ok(jSameCol < 1.1, `col neighbour not co-stretched, J=${jSameCol.toFixed(2)}`);
});

test('buildDensityWarp2D: fold-free (Jacobian det > 0 everywhere) on a peaked input', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 500; k++) samples.push([30, 70]); // extreme spike
  const W = buildDensityWarp2D(samples, BOX, { alpha: 2.0, bins: 48, sigmaPx: 6 });
  for (let y = 2; y < 100; y += 4) for (let x = 2; x < 100; x += 4) {
    assert.ok(jacDet(W, [x, y]) > 0, `det>0 at (${x},${y})`);
  }
});

test('buildDensityWarp2D: deterministic (identical output on identical input)', () => {
  const samples: Pixel[] = [[20, 20], [21, 22], [80, 30], [55, 55]];
  const a = buildDensityWarp2D(samples, BOX, { alpha: 0.8, bins: 32, sigmaPx: 10 });
  const b = buildDensityWarp2D(samples, BOX, { alpha: 0.8, bins: 32, sigmaPx: 10 });
  for (const p of [[10, 10], [50, 50], [90, 90]] as Pixel[]) {
    assert.deepEqual(a(p), b(p));
  }
});

test('buildDensityWarp2D: empty samples or alpha<=0 → identity', () => {
  const W0 = buildDensityWarp2D([], BOX, { alpha: 0.8 });
  assert.deepEqual(W0([33, 44]), [33, 44]);
  const Wa = buildDensityWarp2D([[50, 50]], BOX, { alpha: 0 });
  assert.deepEqual(Wa([33, 44]), [33, 44]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: FAIL — `buildDensityWarp2D` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to densityWarp2d.ts
export function buildDensityWarp2D(
  samples: readonly Pixel[],
  box: WarpBox,
  opts: DensityWarp2DOptions = {},
): WarpFn {
  const alphaTarget = opts.alpha ?? 0.8;
  if (samples.length === 0 || alphaTarget <= 0) return (p) => [p[0], p[1]];
  const sigmaPx = opts.sigmaPx ?? (box.maxX - box.minX) / 12;

  const grid = densityGrid2D(samples, box, opts);
  const { Fx, Fy } = displacementField2D(grid, sigmaPx);
  const alpha = foldSafeAlpha(Fx, Fy, grid, alphaTarget);
  const { bins: B, x0, y0, cw, ch } = grid;

  // bilinear sample of (Fx,Fy) at pixel p; cell i centre = origin + (i+0.5)*size.
  // u,v clamped to [0, B-1] so out-of-box points use the edge field (no fold).
  return (p) => {
    let u = (p[0] - x0) / cw - 0.5; if (u < 0) u = 0; else if (u > B - 1) u = B - 1;
    let v = (p[1] - y0) / ch - 0.5; if (v < 0) v = 0; else if (v > B - 1) v = B - 1;
    const i0 = Math.min(B - 2, Math.floor(u)), j0 = Math.min(B - 2, Math.floor(v));
    const tu = u - i0, tv = v - j0;
    const s = (A: Float64Array) =>
      A[j0 * B + i0] * (1 - tu) * (1 - tv) + A[j0 * B + i0 + 1] * tu * (1 - tv) +
      A[(j0 + 1) * B + i0] * (1 - tu) * tv + A[(j0 + 1) * B + i0 + 1] * tu * tv;
    return [p[0] + alpha * s(Fx), p[1] + alpha * s(Fy)];
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/render/layout/densityWarp2d.test.ts`
Expected: PASS (all 10 tests). If the locality test is borderline, the *direction* (cluster J clearly > row/col J) must hold — tune `sigmaPx` in the test, not the assertion's intent.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all pass, 0 failures (this module adds 11 tests to the suite's prior 246).

- [ ] **Step 6: Commit**

```bash
git add src/render/layout/densityWarp2d.ts src/render/layout/densityWarp2d.test.ts
git commit -m "feat(warp): assemble buildDensityWarp2D (fold-free local 2D warp)"
```

---

## Task 5: Integrate behind `OCTI_WARP_MODE` (default separable)

Select the 2D warp in `renderGeographic` only when `OCTI_WARP_MODE=2d`; default behaviour is unchanged.

**Files:**
- Modify: `src/render/renderGeographic.ts` (the `buildDensityWarp(...)` call site, ~line 546, plus an env read near the other warp knobs ~line 453)

- [ ] **Step 1: Add the mode + sigma env reads**

Near `warpAlpha`/`warpMaxScale` (~line 453), add:

```typescript
  const warpMode =
    typeof process !== 'undefined' ? (process as { env?: Record<string, string> }).env?.OCTI_WARP_MODE : undefined;
  const warpSigmaPx = (() => {
    const env = typeof process !== 'undefined' ? Number((process as { env?: Record<string, string> }).env?.OCTI_WARP_SIGMA) : NaN;
    return Number.isFinite(env) && env > 0 ? env : undefined; // undefined → module default (box/12)
  })();
```

- [ ] **Step 2: Add the import**

At the existing `import { buildDensityWarp, type WarpFn } from './layout/densityWarp';` line, add a sibling import:

```typescript
import { buildDensityWarp2D } from './layout/densityWarp2d';
```

- [ ] **Step 3: Branch the warp construction**

Replace the existing call (currently):

```typescript
  const warp = buildDensityWarp(
    warpSamples,
    { minX: 0, minY: 0, maxX: width, maxY: height },
    { alpha: warpAlpha, maxScale: warpMaxScale },
  );
```

with:

```typescript
  const warpBox = { minX: 0, minY: 0, maxX: width, maxY: height };
  const warp =
    warpMode === '2d'
      ? buildDensityWarp2D(warpSamples, warpBox, { alpha: warpAlpha, sigmaPx: warpSigmaPx })
      : buildDensityWarp(warpSamples, warpBox, { alpha: warpAlpha, maxScale: warpMaxScale });
```

- [ ] **Step 4: Verify default unchanged + build**

Run: `npx tsx dev/box-diag.ts improvedschematics-input-difficult-nyc.json 2>&1 | grep -oE "mega fallbacks=[0-9]+"`
Expected: `mega fallbacks=6` (default mode = separable, identical to before).

Run: `npm run build`
Expected: builds, no error.

- [ ] **Step 5: Verify the 2D mode runs + is captured by the heatmap**

Run: `OCTI_WARP_MODE=2d npx tsx dev/warp-heatmap.ts improvedschematics-input-difficult-nyc.json dev/_warp-2d`
Expected: writes `dev/_warp-2d.png`; the `J=…` range prints. Open the PNG: magnification should appear as **local sectors**, not a row/column cross.

- [ ] **Step 6: Commit**

```bash
git add src/render/renderGeographic.ts
git commit -m "feat(warp): select 2D warp via OCTI_WARP_MODE (default separable)"
```

---

## Task 6: Validation gates (boxes, convergence, visual)

Not a code task — the decision gate before considering a default flip. Record results for the user.

- [ ] **Step 1: Box counts, 2D mode, all dumps**

Run each and record `mega fallbacks`:
```bash
for d in difficult-nyc nyc chi; do printf "%s: " "$d"; OCTI_WARP_MODE=2d npx tsx dev/box-diag.ts improvedschematics-input-$d.json 2>&1 | grep -oE "mega fallbacks=[0-9]+"; done
OCTI_WARP_MODE=2d npx tsx dev/box-diag.ts improvedschematics-dump-sea-w-geo.json 2>&1 | grep -oE "mega fallbacks=[0-9]+" || echo "sea: 0"
```
Expected/target: difficult-nyc ≤ 6 (ideally fewer); sea/nyc/chi not worse than their separable baselines (0/0/0).

- [ ] **Step 2: Convergence**

Run: `OCTI_WARP_MODE=2d npx tsx dev/_ulpcheck.ts improvedschematics-dump-sea-w-geo.json 2>&1 | tail -3`
Expected: `=== CONVERGED ✓ ===`. (If it diverges, the only suspects are an unquantized `exp` or a non-`√` transcendental — grep the new module.)

- [ ] **Step 3: Visual gate (render new vs separable)**

```bash
for m in difficult-nyc nyc chi; do
  OCTI_WARP_MODE=2d npx tsx dev/_render-boxes.ts improvedschematics-input-$m.json dev/_2d-$m 1500
  npx tsx dev/_render-boxes.ts improvedschematics-input-$m.json dev/_sep-$m 1500
done
OCTI_WARP_MODE=2d npx tsx dev/_render-boxes.ts improvedschematics-dump-sea-w-geo.json dev/_2d-sea 1500
npx tsx dev/_render-boxes.ts improvedschematics-dump-sea-w-geo.json dev/_sep-sea 1500
```
Present `_2d-*` vs `_sep-*` and the `_warp-2d` heatmap to the user. **User decides** whether the maps look as good or better.

- [ ] **Step 4: Decision**

- If the user approves the look AND boxes/convergence pass: flip the default — in `renderGeographic.ts` change the branch to `warpMode !== 'separable'` (default 2d), commit `feat(warp): make 2D density warp the default`.
- If single-pass under-expands the densest cores (heatmap centres still saturated after the α-throttle): open the **escalation** (spec §"Escalation path", approach B — iterate the field) as a follow-up plan.
- Either way, update memory ([[jfk-terminal-cluster]], [[loom-octi-pipeline]]) with the outcome.

---

## Notes on performance

The displacement convolution is `O(bins² · (3σ/cell)²)` with the kernel precomputed (only `(2·rad+1)²` `exp` calls). At bins=96, σ≈canvas/12, that's a few million multiply-adds — tens of ms, once per smoothed render (not per frame). If it shows up hot, the kernel is separable (`w(|d|)=gx(dx)·gy(dy)`), so `Fx`/`Fy` can drop to two-pass separable convolutions — a pure optimization, same output.
