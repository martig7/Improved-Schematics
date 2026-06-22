import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeography, generateGeography } from './geography';
import type { GeographyDeps } from './geography';
import type { TaggedFeature } from './types';
import type { ProbeResult } from './schemaProbe';

// The harvest bbox the panel would pass (demand extent); the test's fake harvest
// ignores it, so any value works — the framing bbox comes from the features.
const HARVEST: [number, number, number, number] = [-3.25, 53.22, -2.48, 53.58];

const PROBE: ProbeResult = { sourceId: 'osm', source: {}, schema: 'openmaptiles', sourceLayers: ['water', 'landuse'] };

const RAW: TaggedFeature[] = [
  { sourceLayer: 'water', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  { sourceLayer: 'landuse', properties: { class: 'park' }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
];

test('buildGeography: returns null when there is no map', async () => {
  const deps: GeographyDeps = { getMap: () => null, probe: () => PROBE, harvest: async () => RAW };
  assert.equal(await buildGeography(HARVEST, deps), null);
});

test('buildGeography: returns null when the probe finds no usable source', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => null, harvest: async () => RAW };
  assert.equal(await buildGeography(HARVEST, deps), null);
});

test('buildGeography: buckets harvested features and frames on their extent', async () => {
  const deps: GeographyDeps = {
    getMap: () => ({ getStyle: () => ({}) }) as never,
    probe: () => PROBE,
    harvest: async () => RAW,
  };
  const geo = await buildGeography(HARVEST, deps);
  assert.ok(geo);
  assert.equal(geo!.water.length, 1);
  assert.equal(geo!.green.length, 1);
  assert.deepEqual(geo!.bbox, [0, 0, 3, 3]); // derived from the harvested features, not VIEW
});

test('buildGeography: returns null when nothing was harvested', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => PROBE, harvest: async () => [] };
  assert.equal(await buildGeography(HARVEST, deps), null);
});

test('generateGeography: a null (not-ready) harvest is NOT cached, a success IS', async () => {
  // The first-game-load race: the basemap isn't ready, so the harvest returns
  // null. That null must NOT be cached, or it would poison the city for the whole
  // session and the panel's retry could never recover.
  let mapReady = false;
  let harvestCalls = 0;
  const deps: GeographyDeps = {
    getMap: () => (mapReady ? ({ getStyle: () => ({}) }) as never : null),
    probe: () => PROBE,
    harvest: async () => { harvestCalls++; return RAW; },
  };
  const city = 'race-test-city';
  assert.equal(await generateGeography(city, HARVEST, deps), null, 'early attempt: map not ready → null');
  mapReady = true;
  const geo = await generateGeography(city, HARVEST, deps);
  assert.ok(geo, 'retry succeeds — the earlier null was not cached');
  const callsAfterSuccess = harvestCalls;
  const geo2 = await generateGeography(city, HARVEST, deps);
  assert.equal(geo2, geo, 'success is cached (same object back)');
  assert.equal(harvestCalls, callsAfterSuccess, 'no re-harvest on a cache hit');
});
