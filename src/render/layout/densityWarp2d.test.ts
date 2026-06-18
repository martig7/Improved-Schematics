import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densityGrid2D, displacementField2D, foldSafeAlpha } from './densityWarp2d';
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
