import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGeoCache, writeGeoCache, clearGeoCache } from './geoCache';
import type { KVStore } from '../render/mapCache';
import type { GeographyData } from './types';
import type { BoundingBox } from '../types/core';

const fakeStore = (): KVStore => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
};

const GEO: GeographyData = { bbox: [0, 0, 1, 1], water: [], green: [] };
const BBOX: BoundingBox = [10, 20, 30, 40]; // the demand HARVEST extent (distinct from GEO.bbox)

test('geoCache: round-trips geography + its harvest extent per city', () => {
  const s = fakeStore();
  writeGeoCache('nyc', BBOX, GEO, s);
  assert.deepEqual(readGeoCache('nyc', s), { bbox: BBOX, geography: GEO });
  assert.equal(readGeoCache('chi', s), null, 'other city → null');
  assert.equal(readGeoCache('sea', s), null, 'absent → null');
});

test('geoCache: clear removes one city, or all', () => {
  const s = fakeStore();
  writeGeoCache('nyc', BBOX, GEO, s);
  writeGeoCache('chi', BBOX, GEO, s);
  clearGeoCache('nyc', s);
  assert.equal(readGeoCache('nyc', s), null);
  assert.deepEqual(readGeoCache('chi', s), { bbox: BBOX, geography: GEO });
  clearGeoCache(undefined, s);
  assert.equal(readGeoCache('chi', s), null);
});

test('geoCache: a version mismatch (or a legacy entry without a bbox) reads as a miss', () => {
  const s = fakeStore();
  s.setItem('improvedschematics:geocache:nyc', JSON.stringify({ v: 0, bbox: BBOX, geography: GEO }));
  assert.equal(readGeoCache('nyc', s), null, 'old version → miss');
  s.setItem('improvedschematics:geocache:chi', JSON.stringify({ v: 1, geography: GEO }));
  assert.equal(readGeoCache('chi', s), null, 'no bbox (pre-extent format) → miss');
});

test('geoCache: on quota it evicts other cities and retries', () => {
  const m = new Map<string, string>();
  const cap = 1; // room for exactly one city
  const capped: KVStore = {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { if (!m.has(k) && m.size >= cap) throw new Error('quota'); m.set(k, v); },
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
  writeGeoCache('old', BBOX, GEO, capped);
  writeGeoCache('new', BBOX, GEO, capped); // quota → evict old → retry
  assert.deepEqual(readGeoCache('new', capped), { bbox: BBOX, geography: GEO });
  assert.equal(readGeoCache('old', capped), null, 'old city evicted');
});
