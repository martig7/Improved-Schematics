import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OCT_DIRS, OCT_UNIT, STEP_SIZE, TARGET_EDGE_CELLS, ITERATIONS, regimeDivisor } from '../constants';

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

test('regimeDivisor picks the finer grid at and below the 800-edge boundary', () => {
  assert.equal(regimeDivisor(0), 1.6);
  assert.equal(regimeDivisor(799), 1.6);
  // Boundary is exclusive: exactly 800 edges is still the metro-scale regime.
  assert.equal(regimeDivisor(800), 1.6);
});

test('regimeDivisor picks the coarser grid above the 800-edge boundary', () => {
  assert.equal(regimeDivisor(801), 1.2);
  assert.equal(regimeDivisor(5000), 1.2);
});

test('regimeDivisor: OCTI_DIVISOR overrides both regimes', () => {
  const prev = process.env.OCTI_DIVISOR;
  process.env.OCTI_DIVISOR = '1.4';
  try {
    assert.equal(regimeDivisor(0), 1.4);
    assert.equal(regimeDivisor(9999), 1.4);
  } finally {
    if (prev === undefined) delete process.env.OCTI_DIVISOR;
    else process.env.OCTI_DIVISOR = prev;
  }
});
