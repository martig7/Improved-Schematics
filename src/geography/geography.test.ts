import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeography } from './geography';
import type { GeographyDeps } from './geography';
import type { TaggedFeature, HarvestView } from './types';
import type { ProbeResult } from './schemaProbe';

const VIEW: HarvestView = { center: [-2.99, 53.41], zoom: 9.5 };

const PROBE: ProbeResult = { sourceId: 'osm', source: {}, schema: 'openmaptiles', sourceLayers: ['water', 'landuse'] };

const RAW: TaggedFeature[] = [
  { sourceLayer: 'water', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  { sourceLayer: 'landuse', properties: { class: 'park' }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
];

test('buildGeography: returns null when there is no map', async () => {
  const deps: GeographyDeps = { getMap: () => null, probe: () => PROBE, harvest: async () => RAW };
  assert.equal(await buildGeography(VIEW, deps), null);
});

test('buildGeography: returns null when the probe finds no usable source', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => null, harvest: async () => RAW };
  assert.equal(await buildGeography(VIEW, deps), null);
});

test('buildGeography: buckets harvested features and frames on their extent', async () => {
  const deps: GeographyDeps = {
    getMap: () => ({ getStyle: () => ({}) }) as never,
    probe: () => PROBE,
    harvest: async () => RAW,
  };
  const geo = await buildGeography(VIEW, deps);
  assert.ok(geo);
  assert.equal(geo!.water.length, 1);
  assert.equal(geo!.green.length, 1);
  assert.deepEqual(geo!.bbox, [0, 0, 3, 3]); // derived from the harvested features, not VIEW
});

test('buildGeography: returns null when nothing was harvested', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => PROBE, harvest: async () => [] };
  assert.equal(await buildGeography(VIEW, deps), null);
});
