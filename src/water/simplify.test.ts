import { test } from 'node:test';
import assert from 'node:assert/strict';
import { douglasPeucker, chaikin, type Pt } from './simplify';

test('douglasPeucker drops a collinear midpoint', () => {
  const pts: Pt[] = [[0, 0], [1, 0], [2, 0]];
  assert.deepEqual(douglasPeucker(pts, 0.01), [[0, 0], [2, 0]]);
});

test('douglasPeucker keeps a sharp corner', () => {
  const pts: Pt[] = [[0, 0], [1, 1], [2, 0]];
  assert.equal(douglasPeucker(pts, 0.5).length, 3);
});

test('chaikin rounds a corner and keeps endpoints of an open path', () => {
  const pts: Pt[] = [[0, 0], [1, 0], [1, 1]];
  const out = chaikin(pts, 1, false);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [1, 1]);
  assert.ok(out.length > pts.length);
});

test('chaikin closed loop has no fixed endpoints and grows', () => {
  const square: Pt[] = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const out = chaikin(square, 1, true);
  assert.equal(out.length, square.length * 2);
});
