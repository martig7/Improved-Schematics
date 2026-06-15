import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeVectorSchema } from './schemaProbe';

test('probeVectorSchema: recognizes an OpenMapTiles-style source', () => {
  const style = {
    sources: { osm: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      { source: 'osm', 'source-layer': 'water' },
      { source: 'osm', 'source-layer': 'landcover' },
      { source: 'osm', 'source-layer': 'landuse' },
    ],
  };
  const r = probeVectorSchema(style);
  assert.ok(r);
  assert.equal(r!.sourceId, 'osm');
  assert.equal(r!.schema, 'openmaptiles');
  assert.ok(r!.sourceLayers.includes('water'));
  assert.ok(r!.sourceLayers.includes('landcover'));
});

test('probeVectorSchema: recognizes a Protomaps-style source by its natural layer', () => {
  const style = {
    sources: { proto: { type: 'vector', url: 'pmtiles://x' } },
    layers: [
      { source: 'proto', 'source-layer': 'water' },
      { source: 'proto', 'source-layer': 'natural' },
    ],
  };
  const r = probeVectorSchema(style);
  assert.ok(r);
  assert.equal(r!.schema, 'protomaps');
  assert.ok(r!.sourceLayers.includes('natural'));
});

test('probeVectorSchema: returns null for a raster-only style', () => {
  const style = {
    sources: { sat: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'] } },
    layers: [{ source: 'sat' }],
  };
  assert.equal(probeVectorSchema(style), null);
});

test('probeVectorSchema: returns null when a vector source lacks water', () => {
  const style = {
    sources: { v: { type: 'vector', tiles: ['x'] } },
    layers: [{ source: 'v', 'source-layer': 'transportation' }],
  };
  assert.equal(probeVectorSchema(style), null);
});
