import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetPolyline } from './offsets';
import type { Pixel } from './types';

test('offsetPolyline with zero offset returns the input points', () => {
  const pts: Pixel[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const out = offsetPolyline(pts, 0);
  assert.deepEqual(out, pts);
});

test('offsetPolyline shifts a straight horizontal line perpendicularly', () => {
  const out = offsetPolyline(
    [
      [0, 0],
      [10, 0],
    ],
    4,
  );
  // perpendicular to +x is ±y; magnitude 4
  assert.ok(Math.abs(Math.abs(out[0][1]) - 4) < 1e-6);
  assert.ok(Math.abs(out[0][0]) < 1e-6); // x unchanged
});
