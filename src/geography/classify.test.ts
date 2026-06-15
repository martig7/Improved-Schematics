import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFeature, bucketFeatures } from './classify';
import type { TaggedFeature } from './types';

test('classifyFeature: water source-layer is always water', () => {
  assert.equal(classifyFeature('water', {}, 'openmaptiles'), 'water');
});

test('classifyFeature: green land-cover/use values map to green', () => {
  assert.equal(classifyFeature('landcover', { class: 'wood' }, 'openmaptiles'), 'green');
  assert.equal(classifyFeature('natural', { 'pmap:kind': 'forest' }, 'protomaps'), 'green');
  assert.equal(classifyFeature('landuse', { class: 'park' }, 'mapbox'), 'green');
  assert.equal(classifyFeature('park', {}, 'openmaptiles'), 'green');
});

test('classifyFeature: non-green land-use is dropped', () => {
  assert.equal(classifyFeature('landuse', { class: 'residential' }, 'mapbox'), null);
  assert.equal(classifyFeature('transportation', {}, 'openmaptiles'), null);
});

test('bucketFeatures: splits + normalizes into water/green polygon sets', () => {
  const feats: TaggedFeature[] = [
    { sourceLayer: 'water', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { sourceLayer: 'landuse', properties: { class: 'grass' }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
    { sourceLayer: 'landuse', properties: { class: 'industrial' }, geometry: { type: 'Polygon', coordinates: [[[4, 4], [5, 4], [5, 5], [4, 4]]] } },
  ];
  const { water, green } = bucketFeatures(feats, 'openmaptiles');
  assert.equal(water.length, 1);
  assert.equal(green.length, 1);
  assert.deepEqual(green[0].geometry.coordinates[0][0], [2, 2]);
});
