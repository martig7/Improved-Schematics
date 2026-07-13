import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFeature, bucketFeatures, extractPlaces } from '../classify';
import type { TaggedFeature } from '../types';

test('classifyFeature: water source-layer is always water', () => {
  assert.equal(classifyFeature('water', {}, 'openmaptiles'), 'water');
});

test('classifyFeature: green land-cover/use values map to green', () => {
  assert.equal(classifyFeature('landcover', { class: 'wood' }, 'openmaptiles'), 'green');
  assert.equal(classifyFeature('natural', { 'pmap:kind': 'forest' }, 'protomaps'), 'green');
  assert.equal(classifyFeature('landuse', { class: 'park' }, 'mapbox'), 'green');
  assert.equal(classifyFeature('park', {}, 'openmaptiles'), 'green');
});

test('classifyFeature: Subway Builder parks + ocean_foundations layers', () => {
  assert.equal(classifyFeature('parks', {}, 'subwaybuilder'), 'green');
  assert.equal(classifyFeature('ocean_foundations', {}, 'subwaybuilder'), 'water');
  assert.equal(classifyFeature('buildings', {}, 'subwaybuilder'), null);
});

test('classifyFeature: modded landuse classified by kind (green kept, rest dropped)', () => {
  assert.equal(classifyFeature('landuse', { kind: 'park' }, 'subwaybuilder'), 'green');
  assert.equal(classifyFeature('landuse', { kind: 'grass' }, 'subwaybuilder'), 'green');
  assert.equal(classifyFeature('landuse', { kind: 'forest' }, 'subwaybuilder'), 'green');
  assert.equal(classifyFeature('landuse', { kind: 'apron' }, 'subwaybuilder'), null);
  assert.equal(classifyFeature('landuse', { kind: 'other' }, 'subwaybuilder'), null);
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

test('extractPlaces keeps named neighborhood-class points, dedupes tile repeats', () => {
  const feats = [
    { sourceLayer: 'place', properties: { class: 'neighbourhood', name: 'Ballard' }, geometry: { type: 'Point', coordinates: [-122.38, 47.66] } },
    // tile repeat of the same label -> deduped
    { sourceLayer: 'place', properties: { class: 'neighbourhood', name: 'Ballard' }, geometry: { type: 'Point', coordinates: [-122.381, 47.661] } },
    // suburb kept; name:en preferred over name
    { sourceLayer: 'place', properties: { class: 'suburb', 'name:en': 'Fremont', name: 'フリーモント' }, geometry: { type: 'Point', coordinates: [-122.35, 47.65] } },
    // city-scale places dropped
    { sourceLayer: 'place', properties: { class: 'city', name: 'Seattle' }, geometry: { type: 'Point', coordinates: [-122.33, 47.6] } },
    // wrong layer dropped
    { sourceLayer: 'water', properties: { class: 'neighbourhood', name: 'Nope' }, geometry: { type: 'Point', coordinates: [0, 0] } },
    // unnamed dropped
    { sourceLayer: 'place', properties: { class: 'quarter' }, geometry: { type: 'Point', coordinates: [1, 1] } },
    // non-finite dropped
    { sourceLayer: 'place', properties: { class: 'quarter', name: 'Bad' }, geometry: { type: 'Point', coordinates: [NaN, 1] } },
    // MultiPoint takes its first point
    { sourceLayer: 'place', properties: { kind: 'district', name: 'Downtown' }, geometry: { type: 'MultiPoint', coordinates: [[-122.34, 47.61], [-122.33, 47.6]] } },
  ] as never[];
  const places = extractPlaces(feats);
  assert.deepEqual(
    places.map((p) => p.name).sort(),
    ['Ballard', 'Downtown', 'Fremont'],
  );
  const ballard = places.find((p) => p.name === 'Ballard')!;
  assert.deepEqual(ballard.coord, [-122.38, 47.66], 'first occurrence wins');
  assert.equal(places.find((p) => p.name === 'Downtown')!.kind, 'district');
});

test('extractPlaces derives the kind from per-kind label layers without a kind property', () => {
  const feats = [
    { sourceLayer: 'neighborhood_labels', properties: { name: 'Five Points' }, geometry: { type: 'Point', coordinates: [-104.97, 39.75] } },
    { sourceLayer: 'suburb_labels', properties: { name: 'Aurora' }, geometry: { type: 'Point', coordinates: [-104.83, 39.71] } },
    // an explicit recognized kind on a per-kind layer still wins
    { sourceLayer: 'neighborhood_labels', properties: { kind: 'quarter', name: 'LoDo' }, geometry: { type: 'Point', coordinates: [-105.0, 39.75] } },
    // a generic layer without a recognized kind stays dropped
    { sourceLayer: 'place', properties: { name: 'Anonymous' }, geometry: { type: 'Point', coordinates: [1, 1] } },
  ] as never[];
  const places = extractPlaces(feats);
  assert.deepEqual(
    places.map((p) => [p.name, p.kind]).sort(),
    [['Aurora', 'suburb'], ['Five Points', 'neighbourhood'], ['LoDo', 'quarter']],
  );
});
