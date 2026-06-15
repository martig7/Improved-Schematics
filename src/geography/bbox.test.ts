import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featuresBbox } from './bbox';
import type { GeoPolyFeature } from './types';
import type { Coordinate } from '../types/core';

const poly = (ring: Coordinate[]): GeoPolyFeature => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } });

test('featuresBbox: unions every coordinate across features', () => {
  const bbox = featuresBbox([
    poly([[0, 0], [1, 0], [1, 1], [0, 0]]),
    poly([[2, 2], [3, 2], [3, 3], [2, 2]]),
  ]);
  assert.deepEqual(bbox, [0, 0, 3, 3]);
});

test('featuresBbox: returns null when there are no features', () => {
  assert.equal(featuresBbox([]), null);
});
