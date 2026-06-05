import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, edgeKey, octilinearDistance, routeEdge } from './grid';
import type { Cell } from './types';

test('octilinearDistance: diagonal then straight (Chebyshev with SQRT2)', () => {
  // dx=3, dy=1 -> min=1 diagonal (SQRT2) + 2 straight
  assert.ok(Math.abs(octilinearDistance([0, 0], [3, 1]) - (Math.SQRT2 + 2)) < 1e-9);
});

test('edgeKey is order-independent', () => {
  assert.equal(edgeKey([1, 2], [3, 4]), edgeKey([3, 4], [1, 2]));
});

test('routeEdge returns an octilinear path from start to goal', () => {
  const occupied = new Set<string>();
  const sharedSegs = new Map<string, Set<string>>();
  const path = routeEdge([0, 0], [3, 0], new Set(['L1']), occupied, sharedSegs);
  assert.equal(cellKey(path[0]), cellKey([0, 0] as Cell));
  assert.equal(cellKey(path[path.length - 1]), cellKey([3, 0] as Cell));
  // every step moves to an 8-neighbour
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i][0] - path[i - 1][0]);
    const dy = Math.abs(path[i][1] - path[i - 1][1]);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0);
  }
});
