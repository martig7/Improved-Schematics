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

test('probeVectorSchema: recognizes the Subway Builder general-tiles schema', () => {
  // Real shape captured from a running game (map://SEA/tiles/{z}/{x}/{y}.mvt).
  const style = {
    sources: {
      'general-tiles': { type: 'vector', tiles: ['map://SEA/tiles/{z}/{x}/{y}.mvt'] },
      'roads-source': { type: 'geojson' },
    },
    layers: [
      { type: 'background' },
      { source: 'general-tiles', 'source-layer': 'buildings' },
      { source: 'general-tiles', 'source-layer': 'water' },
      { source: 'general-tiles', 'source-layer': 'parks' },
      { source: 'general-tiles', 'source-layer': 'ocean_foundations' },
      { source: 'general-tiles', 'source-layer': 'airports' },
    ],
  };
  const r = probeVectorSchema(style);
  assert.ok(r);
  assert.equal(r!.sourceId, 'general-tiles');
  assert.equal(r!.schema, 'subwaybuilder');
  assert.ok(r!.sourceLayers.includes('water'));
  assert.ok(r!.sourceLayers.includes('ocean_foundations'));
  assert.ok(r!.sourceLayers.includes('parks'));
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
