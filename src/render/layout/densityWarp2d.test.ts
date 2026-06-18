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
