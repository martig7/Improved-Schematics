import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPolyFeatures } from './normalize';

test('toPolyFeatures: keeps a Polygon as one feature', () => {
  const out = toPolyFeatures([
    { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].geometry.type, 'Polygon');
  assert.deepEqual(out[0].geometry.coordinates[0][1], [1, 0]);
});

test('toPolyFeatures: splits a MultiPolygon into one feature per polygon', () => {
  const out = toPolyFeatures([
    {
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[2, 2], [3, 2], [3, 3], [2, 2]]],
        ],
      },
    },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].geometry.coordinates[0][0], [2, 2]);
});

test('toPolyFeatures: drops non-polygon geometry', () => {
  const out = toPolyFeatures([
    { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ]);
  assert.equal(out.length, 0);
});
