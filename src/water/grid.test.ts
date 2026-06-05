import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterMask } from './grid';
import type { OceanIndex } from './types';

const idx: OceanIndex = {
  cs: 1,
  bbox: [-74, 40, -73, 41], // 1°x1°
  grid: [2, 2],
  cells: [[0, 0], [1, 0]], // bottom row water
  depths: [],
  stats: {},
};

test('buildWaterMask marks listed cells as water', () => {
  const g = buildWaterMask(idx);
  assert.equal(g.W, 2);
  assert.equal(g.H, 2);
  assert.equal(g.mask[0 * 2 + 0], 1);
  assert.equal(g.mask[0 * 2 + 1], 1);
  assert.equal(g.mask[1 * 2 + 0], 0);
});

test('cornerToGeo maps grid corners to bbox corners (row 0 = south)', () => {
  const g = buildWaterMask(idx);
  assert.deepEqual(g.cornerToGeo(0, 0), [-74, 40]); // SW
  assert.deepEqual(g.cornerToGeo(2, 2), [-73, 41]); // NE
});
