import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFeatures } from './clean';
import type { GeoPolyFeature } from './types';
import type { Coordinate } from '../types/core';

const BBOX = [0, 0, 1, 1] as [number, number, number, number];
const poly = (ring: Coordinate[]): GeoPolyFeature => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } });

// ~0.01° square ≈ 1113 m on a side ≈ 1.24e6 m²; ~0.0005° square ≈ 56 m ≈ 3100 m².
const big = poly([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]);
const tiny = poly([[0, 0], [0.0005, 0], [0.0005, 0.0005], [0, 0.0005], [0, 0]]);

test('cleanFeatures: drops polygons below the area threshold', () => {
  const out = cleanFeatures([big, tiny], BBOX, { minAreaM2: 30_000, simplifyM: 0, smoothIters: 0 });
  assert.equal(out.length, 1); // tiny (~3100 m²) dropped, big kept
});

test('cleanFeatures: returns [] when every polygon is sub-threshold', () => {
  const out = cleanFeatures([tiny], BBOX, { minAreaM2: 30_000, simplifyM: 0, smoothIters: 0 });
  assert.equal(out.length, 0);
});

test('cleanFeatures: Douglas–Peucker drops collinear edge midpoints', () => {
  const withMidpoints = poly([
    [0, 0], [0.005, 0], [0.01, 0], [0.01, 0.005], [0.01, 0.01],
    [0.005, 0.01], [0, 0.01], [0, 0.005], [0, 0],
  ]); // 8 distinct points, 4 of them collinear midpoints
  const out = cleanFeatures([withMidpoints], BBOX, { minAreaM2: 0, simplifyM: 10, smoothIters: 0 });
  assert.equal(out.length, 1);
  assert.ok(out[0].geometry.coordinates[0].length < 8, 'midpoints removed');
});

test('cleanFeatures: dropHoles keeps only the exterior ring', () => {
  const withHole: GeoPolyFeature = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]], // exterior
        [[0.003, 0.003], [0.006, 0.003], [0.006, 0.006], [0.003, 0.006], [0.003, 0.003]], // hole
      ],
    },
  };
  const kept = cleanFeatures([withHole], BBOX, { minAreaM2: 0, simplifyM: 0, smoothIters: 0 });
  assert.equal(kept[0].geometry.coordinates.length, 2, 'hole kept by default');
  const filled = cleanFeatures([withHole], BBOX, { minAreaM2: 0, simplifyM: 0, smoothIters: 0, dropHoles: true });
  assert.equal(filled[0].geometry.coordinates.length, 1, 'hole dropped');
});

test('cleanFeatures: Chaikin smoothing rounds corners (adds points)', () => {
  const out = cleanFeatures([big], BBOX, { minAreaM2: 0, simplifyM: 0, smoothIters: 2 });
  assert.equal(out.length, 1);
  assert.ok(out[0].geometry.coordinates[0].length > 4, 'corners rounded into more points');
});
