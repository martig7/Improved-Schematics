import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCachedPre, writeCachedPre, clearCachedPre, readSelections, writeSelections, type KVStore } from './mapCache';

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

test('mapCache: selections round-trip only when the fingerprint matches', () => {
  const s = fakeStore();
  const areas = [{ id: 'sel-0', box: { x0: 1, y0: 2, x1: 3, y1: 4 }, color: '#f00', name: 'A', locked: false }];
  writeSelections('nyc', 'fpA', areas, s);
  assert.deepEqual(readSelections('nyc', 'fpA', s), areas);
  assert.equal(readSelections('nyc', 'fpB', s), null, 'fp mismatch → no restore (boxes belong to another layout)');
  assert.equal(readSelections('chi', 'fpA', s), null, 'other city → null');
  assert.equal(readSelections('sea', 'fpA', s), null, 'absent → null');
});

test('mapCache: a new fingerprint orphans the old selections', () => {
  const s = fakeStore();
  writeSelections('nyc', 'fp1', [{ id: 'sel-0' }], s);
  writeSelections('nyc', 'fp2', [{ id: 'sel-1' }], s);
  assert.deepEqual(readSelections('nyc', 'fp2', s), [{ id: 'sel-1' }]);
  assert.equal(readSelections('nyc', 'fp1', s), null);
});

test('mapCache: clearing a city drops its selections too', () => {
  const s = fakeStore();
  writeCachedPre('nyc', 'f', 'N', s);
  writeSelections('nyc', 'f', [{ id: 'sel-0' }], s);
  clearCachedPre('nyc', s);
  assert.equal(readSelections('nyc', 'f', s), null);
});

test('mapCache: a pre quota-eviction keeps the same city\'s selections', () => {
  const m = new Map<string, string>();
  const cap = 3;
  const capped: KVStore = {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { if (!m.has(k) && m.size >= cap) throw new Error('quota'); m.set(k, v); },
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
  writeCachedPre('chi', 'f', 'C', capped); // chi fp+pre (2 keys)
  writeSelections('nyc', 'g', [{ id: 'sel-0' }], capped); // +nyc sel = 3 (cap)
  writeCachedPre('nyc', 'g', 'N', capped); // quota → evict chi, keep nyc sel, retry
  assert.equal(readCachedPre('nyc', 'g', capped), 'N');
  assert.deepEqual(readSelections('nyc', 'g', capped), [{ id: 'sel-0' }], 'own selections survive the eviction');
  assert.equal(readCachedPre('chi', 'f', capped), null, 'other city evicted');
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
