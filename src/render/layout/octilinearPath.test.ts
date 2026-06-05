import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octilinearPath } from './octilinearPath';
import type { Pixel } from './types';

function isOctilinearSegment(a: Pixel, b: Pixel): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return true;
  // angle in [0, 2π)
  const ang = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
  // Each segment should be at k·45°.
  for (let k = 0; k < 8; k++) {
    if (Math.abs(ang - (k * Math.PI) / 4) < 1e-4) return true;
  }
  return false;
}

test('octilinearPath ends exactly at the target', () => {
  const path = octilinearPath([0, 0], [100, 42], 2);
  const end = path[path.length - 1];
  assert.deepEqual(end, [100, 42]);
});

test('every segment is in one of the 8 octilinear directions', () => {
  const cases: [Pixel, Pixel][] = [
    [[0, 0], [100, 42]],
    [[0, 0], [-30, 80]],
    [[5, 5], [-50, -23]],
    [[0, 0], [10, 100]],
  ];
  for (const [from, to] of cases) {
    const path = octilinearPath(from, to, 2);
    for (let i = 1; i < path.length; i++) {
      assert.ok(
        isOctilinearSegment(path[i - 1], path[i]),
        `segment ${i - 1}→${i} not octilinear for ${JSON.stringify([from, to])}: ${JSON.stringify([path[i - 1], path[i]])}`,
      );
    }
  }
});

test('exact octilinear displacement → single straight segment', () => {
  // 45° NE
  const path = octilinearPath([0, 0], [50, 50], 2);
  assert.equal(path.length, 2);
});

test('segments=1 produces a simple L (1 bend, 2 segments)', () => {
  const path = octilinearPath([0, 0], [100, 42], 1);
  assert.equal(path.length, 3); // start + bend + end
});

test('segments=2 produces 3 bends (4 segments)', () => {
  const path = octilinearPath([0, 0], [100, 42], 2);
  assert.equal(path.length, 5);
});
