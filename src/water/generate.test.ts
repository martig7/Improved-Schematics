import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWaterFromIndex } from './generate';
import type { OceanIndex } from './types';

test('generateWaterFromIndex makes a geographic polygon within bbox', () => {
  // a 4x4 block of water in a 6x6 grid so DP keeps >=3 points
  const cells: number[][] = [];
  for (let c = 1; c <= 4; c++) for (let r = 1; r <= 4; r++) cells.push([c, r]);
  const idx: OceanIndex = { cs: 1, bbox: [-74, 40, -72, 42], grid: [6, 6], cells, depths: [], stats: {} };
  const wc = generateWaterFromIndex(idx);
  assert.equal(wc.type, 'FeatureCollection');
  assert.ok(wc.features.length >= 1);
  for (const f of wc.features) {
    for (const ring of f.geometry.coordinates) {
      for (const [lng, lat] of ring) {
        assert.ok(lng >= -74 - 1e-9 && lng <= -72 + 1e-9);
        assert.ok(lat >= 40 - 1e-9 && lat <= 42 + 1e-9);
      }
    }
  }
});

test('generateWaterFromIndex returns empty collection for no water', () => {
  const idx: OceanIndex = { cs: 1, bbox: [0, 0, 1, 1], grid: [2, 2], cells: [], depths: [], stats: {} };
  const wc = generateWaterFromIndex(idx);
  assert.equal(wc.features.length, 0);
});
