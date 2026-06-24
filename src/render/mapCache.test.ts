import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCachedPre, writeCachedPre, clearCachedPre, readSelections, writeSelections, readSettings, writeSettings, readModeSettings, writeModeSettings, readSubPre, writeSubPre, pruneSubPres, type KVStore } from './mapCache';

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

test('mapCache: an empty write does not clobber a DIFFERENT layout\'s areas', () => {
  const s = fakeStore();
  writeSelections('nyc', 'fpA', [{ id: 'sel-0' }], s); // areas on layout A
  // A transient generate under a different fp (e.g. before geography loaded) clears the
  // live selections → empty write under fpB. It must NOT destroy layout A's areas.
  writeSelections('nyc', 'fpB', [], s);
  assert.deepEqual(readSelections('nyc', 'fpA', s), [{ id: 'sel-0' }], 'layout A areas survive');
  // An empty write under the SAME fp DOES persist (the user genuinely cleared them).
  writeSelections('nyc', 'fpA', [], s);
  assert.deepEqual(readSelections('nyc', 'fpA', s), [], 'same-fp clear persists');
  // A non-empty write under a different fp wins (user actively drew on that layout).
  writeSelections('nyc', 'fpC', [{ id: 'sel-1' }], s);
  assert.deepEqual(readSelections('nyc', 'fpC', s), [{ id: 'sel-1' }]);
  assert.equal(readSelections('nyc', 'fpA', s), null, 'fpA replaced by the non-empty fpC write');
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

// Sub-layout cache: a string `pre` round-trips through serialize/deserialize like the main
// pre, so it stands in for a real SmoothedPrecomputed here.
const FR = { x: 1, y: 2, w: 3, h: 4 };

test('mapCache: sub-pre round-trips only when the fingerprint AND box match', () => {
  const s = fakeStore();
  writeSubPre('nyc', 'fpA', '1,2,3,4', 'SUB', FR, s);
  assert.deepEqual(readSubPre('nyc', 'fpA', '1,2,3,4', s), { pre: 'SUB', selFrame: FR });
  assert.equal(readSubPre('nyc', 'fpB', '1,2,3,4', s), null, 'fp mismatch → miss');
  assert.equal(readSubPre('nyc', 'fpA', '9,9,9,9', s), null, 'different box → miss');
  assert.equal(readSubPre('chi', 'fpA', '1,2,3,4', s), null, 'other city → miss');
});

test('mapCache: multiple boxes coexist under one fingerprint', () => {
  const s = fakeStore();
  writeSubPre('nyc', 'f', 'A', 'PA', null, s);
  writeSubPre('nyc', 'f', 'B', 'PB', FR, s);
  assert.deepEqual(readSubPre('nyc', 'f', 'A', s), { pre: 'PA', selFrame: null });
  assert.deepEqual(readSubPre('nyc', 'f', 'B', s), { pre: 'PB', selFrame: FR });
});

test('mapCache: a new fingerprint resets the sub-pre map (old regions are stale)', () => {
  const s = fakeStore();
  writeSubPre('nyc', 'f1', 'A', 'PA', null, s);
  writeSubPre('nyc', 'f2', 'B', 'PB', null, s); // different fp → fresh map
  assert.equal(readSubPre('nyc', 'f1', 'A', s), null, 'old-fp region gone');
  assert.deepEqual(readSubPre('nyc', 'f2', 'B', s), { pre: 'PB', selFrame: null });
});

test('mapCache: prune drops sub-pres whose box is not in the keep set', () => {
  const s = fakeStore();
  writeSubPre('nyc', 'f', 'A', 'PA', null, s);
  writeSubPre('nyc', 'f', 'B', 'PB', null, s);
  pruneSubPres('nyc', 'f', ['A'], s); // 'B' deleted/edited away
  assert.deepEqual(readSubPre('nyc', 'f', 'A', s), { pre: 'PA', selFrame: null });
  assert.equal(readSubPre('nyc', 'f', 'B', s), null);
  // A prune under a DIFFERENT fp leaves the stored (other-fp) map untouched.
  pruneSubPres('nyc', 'other', [], s);
  assert.deepEqual(readSubPre('nyc', 'f', 'A', s), { pre: 'PA', selFrame: null });
});

test('mapCache: clearing a city drops its sub-pres too', () => {
  const s = fakeStore();
  writeSubPre('nyc', 'f', 'A', 'PA', null, s);
  clearCachedPre('nyc', s);
  assert.equal(readSubPre('nyc', 'f', 'A', s), null);
});

test('mapCache: per-mode settings round-trip independently per (city, mode)', () => {
  const s = fakeStore();
  writeModeSettings('nyc', 'geographic', { showLabels: true }, s);
  writeModeSettings('nyc', 'smoothed', { showLabels: false }, s);
  assert.deepEqual(readModeSettings('nyc', 'geographic', s), { showLabels: true });
  assert.deepEqual(readModeSettings('nyc', 'smoothed', s), { showLabels: false }, 'modes are independent');
  assert.equal(readModeSettings('nyc', 'schematic', s), null, 'unset mode → null');
  assert.equal(readModeSettings('chi', 'geographic', s), null, 'other city → null');
});

test('mapCache: per-mode settings are separate from the shared (export) settings', () => {
  const s = fakeStore();
  writeSettings('nyc', { exportFormat: 'png' }, s);
  writeModeSettings('nyc', 'smoothed', { showLabels: true }, s);
  assert.deepEqual(readSettings('nyc', s), { exportFormat: 'png' }, 'shared settings untouched');
  assert.deepEqual(readModeSettings('nyc', 'smoothed', s), { showLabels: true });
  // The panel falls back to the shared blob when a mode has no entry yet (migration).
  assert.equal(readModeSettings('nyc', 'geographic', s), null);
});

test('mapCache: clearing a city drops its per-mode settings too', () => {
  const s = fakeStore();
  writeSettings('nyc', { exportFormat: 'png' }, s);
  writeModeSettings('nyc', 'geographic', { showLabels: true }, s);
  writeModeSettings('nyc', 'smoothed', { showLabels: false }, s);
  writeModeSettings('chi', 'smoothed', { showLabels: true }, s); // a different city survives
  clearCachedPre('nyc', s);
  assert.equal(readSettings('nyc', s), null);
  assert.equal(readModeSettings('nyc', 'geographic', s), null);
  assert.equal(readModeSettings('nyc', 'smoothed', s), null);
  assert.deepEqual(readModeSettings('chi', 'smoothed', s), { showLabels: true }, 'other city untouched');
});

test('mapCache: settings round-trip per city, unconditional (no fingerprint)', () => {
  const s = fakeStore();
  const settings = { showStations: false, showLabels: true, applied: { lineWidth: 9, warpPos: 0.5 }, labelScale: 1.5 };
  writeSettings('nyc', settings, s);
  assert.deepEqual(readSettings('nyc', s), settings);
  assert.equal(readSettings('chi', s), null, 'other city → null');
  assert.equal(readSettings('sea', s), null, 'absent → null');
});

test('mapCache: clearing a city drops its settings; quota eviction keeps the written city\'s settings', () => {
  const s = fakeStore();
  writeSettings('nyc', { applied: { lineWidth: 9 } }, s);
  clearCachedPre('nyc', s);
  assert.equal(readSettings('nyc', s), null);

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
  writeSettings('nyc', { applied: { lineWidth: 9 } }, capped); // +nyc set = 3 (cap)
  writeCachedPre('nyc', 'g', 'N', capped); // quota → evict chi, keep nyc set, retry
  assert.equal(readCachedPre('nyc', 'g', capped), 'N');
  assert.deepEqual(readSettings('nyc', capped), { applied: { lineWidth: 9 } }, 'own settings survive the eviction');
  assert.equal(readCachedPre('chi', 'f', capped), null, 'other city evicted');
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
