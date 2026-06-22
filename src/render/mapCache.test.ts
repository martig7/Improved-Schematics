import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCachedPre, writeCachedPre, clearCachedPre, type KVStore } from './mapCache';

// A precompute serializes via serializePre; a string `pre` (the degenerate
// no-layout case) round-trips trivially, which is enough to exercise the cache.
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

test('mapCache: read hits only when the fingerprint matches', () => {
  const s = fakeStore();
  writeCachedPre('nyc', 'fpA', 'PRE', s);
  assert.equal(readCachedPre('nyc', 'fpA', s), 'PRE');
  assert.equal(readCachedPre('nyc', 'fpB', s), null, 'fp mismatch → miss');
  assert.equal(readCachedPre('chi', 'fpA', s), null, 'other city → miss');
});

test('mapCache: a new fingerprint overwrites; the old one no longer hits', () => {
  const s = fakeStore();
  writeCachedPre('nyc', 'fp1', 'P1', s);
  writeCachedPre('nyc', 'fp2', 'P2', s);
  assert.equal(readCachedPre('nyc', 'fp2', s), 'P2');
  assert.equal(readCachedPre('nyc', 'fp1', s), null);
});

test('mapCache: clear removes one city, or all', () => {
  const s = fakeStore();
  writeCachedPre('nyc', 'f', 'N', s);
  writeCachedPre('chi', 'f', 'C', s);
  clearCachedPre('nyc', s);
  assert.equal(readCachedPre('nyc', 'f', s), null);
  assert.equal(readCachedPre('chi', 'f', s), 'C');
  clearCachedPre(undefined, s);
  assert.equal(readCachedPre('chi', 'f', s), null);
});

test('mapCache: on quota it evicts other cities and retries', () => {
  // cap = 2 keys = room for exactly one city's {pre, fp}.
  const m = new Map<string, string>();
  const cap = 2;
  const capped: KVStore = {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { if (!m.has(k) && m.size >= cap) throw new Error('quota'); m.set(k, v); },
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
  writeCachedPre('old', 'f', 'OLD', capped); // fills both slots
  const ok = writeCachedPre('new', 'g', 'NEW', capped); // quota → evict old → retry
  assert.equal(ok, true);
  assert.equal(readCachedPre('new', 'g', capped), 'NEW');
  assert.equal(readCachedPre('old', 'f', capped), null, 'old city evicted');
});
