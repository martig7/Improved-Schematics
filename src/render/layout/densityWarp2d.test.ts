import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densityGrid2D, displacementField2D, foldSafeAlpha, buildDensityWarp2D } from './densityWarp2d';
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

test('displacementField2D: pushes outward from a dense cluster', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 80; k++) samples.push([50 + ((k % 4) - 2), 50 + (((k / 4) | 0) % 4 - 2)]); // cluster at center (50,50)
  const grid = densityGrid2D(samples, BOX, { bins: 32, sigmaBins: 1.5, beta: 0.8 });
  const { Fx, Fy } = displacementField2D(grid, 10);
  const idx = (px: number, py: number) => Math.min(31, (py / (100 / 32)) | 0) * 32 + Math.min(31, (px / (100 / 32)) | 0);
  // a point to the RIGHT of center should be pushed further right (Fx > 0)
  assert.ok(Fx[idx(62, 50)] > 0, `right of cluster pushed right, got ${Fx[idx(62, 50)]}`);
  // a point ABOVE center (smaller y) pushed further up (Fy < 0)
  assert.ok(Fy[idx(50, 38)] < 0, `above cluster pushed up, got ${Fy[idx(50, 38)]}`);
  // radial both ways: a point LEFT of center is pushed further left (Fx < 0)
  assert.ok(Fx[idx(38, 50)] < 0, `left of cluster pushed left, got ${Fx[idx(38, 50)]}`);
});

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
  const Fx = new Float64Array(16 * 16);
  const Fy = new Float64Array(16 * 16); // F = 0 → M = 0
  assert.equal(foldSafeAlpha(Fx, Fy, grid, 0.8), 0.8);
});

// numeric area magnification J = det(Jacobian of W) at p, via finite differences
function jacDet(W: (p: Pixel) => Pixel, p: Pixel, h = 0.5): number {
  const wx1 = W([p[0] + h, p[1]]);
  const wx0 = W([p[0] - h, p[1]]);
  const wy1 = W([p[0], p[1] + h]);
  const wy0 = W([p[0], p[1] - h]);
  const a = (wx1[0] - wx0[0]) / (2 * h);
  const b = (wy1[0] - wy0[0]) / (2 * h);
  const c = (wx1[1] - wx0[1]) / (2 * h);
  const d = (wy1[1] - wy0[1]) / (2 * h);
  return a * d - b * c;
}

test('buildDensityWarp2D: uniform (edge-to-edge) fill → near-identity', () => {
  // must fill to the box EDGES: a grid that leaves empty borders is not uniform
  // density (populated interior vs empty edge) and the warp correctly expands it.
  const samples: Pixel[] = [];
  for (let y = 1; y < 100; y += 2.5) for (let x = 1; x < 100; x += 2.5) samples.push([x, y]);
  const W = buildDensityWarp2D(samples, BOX, { alpha: 0.8, bins: 32, sigmaPx: 10 });
  for (const p of [[50, 50], [40, 60], [70, 30]] as Pixel[]) {
    const out = W(p);
    assert.ok(Math.hypot(out[0] - p[0], out[1] - p[1]) < 2, `uniform → ~no displacement at ${p}, got ${Math.hypot(out[0] - p[0], out[1] - p[1]).toFixed(2)}`);
  }
});

test('buildDensityWarp2D: dense cluster expands LOCALLY, not its whole row/column', () => {
  const samples: Pixel[] = [];
  for (let k = 0; k < 120; k++) samples.push([50 + ((k % 6) - 3), 50 + (((k / 6) | 0) % 6 - 3)]); // cluster at (50,50)
  const W = buildDensityWarp2D(samples, BOX, { alpha: 0.8, bins: 48, sigmaPx: 8 });
  const jCenter = jacDet(W, [50, 50]); // inside cluster → expanded
  const jSameRow = jacDet(W, [88, 50]); // same row, far from cluster
  const jSameCol = jacDet(W, [50, 12]); // same column, far from cluster
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
