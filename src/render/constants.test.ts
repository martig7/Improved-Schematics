import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OCT_DIRS, OCT_UNIT, STEP_SIZE, TARGET_EDGE_CELLS, ITERATIONS } from './constants';

test('OCT_DIRS has 8 directions', () => {
  assert.equal(OCT_DIRS.length, 8);
});

test('OCT_UNIT normalizes diagonals to length 1', () => {
  for (const [x, y] of OCT_UNIT) {
    assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
  }
  // diagonal components equal SQRT1_2
  assert.ok(Math.abs(OCT_UNIT[1][0] - Math.SQRT1_2) < 1e-9);
});

test('scalar constants match the game', () => {
  assert.equal(STEP_SIZE, 3);
  assert.equal(TARGET_EDGE_CELLS, 2.2);
  assert.equal(ITERATIONS, 80);
});
