import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeography } from './geography';
import type { GeographyDeps } from './geography';
import type { TaggedFeature } from './types';
import type { ProbeResult } from './schemaProbe';

const BBOX = [-3.25, 53.22, -2.48, 53.58] as [number, number, number, number];

const PROBE: ProbeResult = { sourceId: 'osm', source: {}, schema: 'openmaptiles', sourceLayers: ['water', 'landuse'] };

const RAW: TaggedFeature[] = [
  { sourceLayer: 'water', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  { sourceLayer: 'landuse', properties: { class: 'park' }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
];

test('buildGeography: returns null when there is no map', async () => {
  const deps: GeographyDeps = { getMap: () => null, probe: () => PROBE, harvest: async () => RAW };
  assert.equal(await buildGeography(BBOX, deps), null);
});

test('buildGeography: returns null when the probe finds no usable source', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => null, harvest: async () => RAW };
  assert.equal(await buildGeography(BBOX, deps), null);
});

test('buildGeography: buckets harvested features into water + green', async () => {
  const deps: GeographyDeps = {
    getMap: () => ({ getStyle: () => ({}) }) as never,
    probe: () => PROBE,
    harvest: async () => RAW,
  };
  const geo = await buildGeography(BBOX, deps);
  assert.ok(geo);
  assert.equal(geo!.water.length, 1);
  assert.equal(geo!.green.length, 1);
  assert.deepEqual(geo!.bbox, BBOX);
});

test('buildGeography: returns null when nothing was harvested', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => PROBE, harvest: async () => [] };
  assert.equal(await buildGeography(BBOX, deps), null);
});
