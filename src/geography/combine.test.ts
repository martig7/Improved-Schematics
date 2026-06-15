import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineCloseParks } from './combine';
import type { GeoPolyFeature } from './types';

const sq = (x0: number, y0: number, x1: number, y1: number): GeoPolyFeature => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
});

test('combineCloseParks: merges two parks within the gap into one', () => {
  // ~222 m apart at this latitude; gap budget 300 m → bridged.
  const out = combineCloseParks([sq(0.005, 0.005, 0.015, 0.015), sq(0.017, 0.005, 0.027, 0.015)], { gapM: 300 });
  assert.equal(out.length, 1);
});

test('combineCloseParks: leaves far-apart parks separate', () => {
  const out = combineCloseParks([sq(0.005, 0.005, 0.012, 0.012), sq(0.040, 0.040, 0.047, 0.047)], { gapM: 300 });
  assert.equal(out.length, 2);
});

test('combineCloseParks: empty input → empty output', () => {
  assert.deepEqual(combineCloseParks([], { gapM: 300 }), []);
});

test('combineCloseParks: gapM <= 0 returns the input unchanged', () => {
  const input = [sq(0.005, 0.005, 0.012, 0.012)];
  assert.equal(combineCloseParks(input, { gapM: 0 }), input);
});
