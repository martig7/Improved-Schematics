import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAreaAction } from './areaLifecycle';

// Areas are modelled as opaque {id} objects here — the decision is type-agnostic.
type Sel = { id: string };
const A: Sel = { id: 'sel-0' };
const B: Sel = { id: 'sel-1' };

const decide = (i: Partial<Parameters<typeof decideAreaAction<Sel>>[0]>) =>
  decideAreaAction<Sel>({
    queuedRestore: null,
    prevKey: undefined,
    nextKey: 's:fpX',
    isSmoothed: true,
    snapshot: [],
    ...i,
  });

test('areaLifecycle: a queued restore (fresh generate / file load) always wins', () => {
  assert.deepEqual(decide({ queuedRestore: [A], nextKey: 's:fpX', prevKey: 'm:geographic' }), { kind: 'restore', selections: [A] });
  // Even when the key is unchanged (a same-fp regenerate that re-read saved areas).
  assert.deepEqual(decide({ queuedRestore: [A, B], nextKey: 's:fpX', prevKey: 's:fpX' }), { kind: 'restore', selections: [A, B] });
});

test('areaLifecycle: the very first paint keeps (never clears on mount)', () => {
  assert.deepEqual(decide({ prevKey: undefined, nextKey: 'm:geographic', snapshot: [A] }), { kind: 'keep' });
});

test('areaLifecycle: same key keeps — a spurious re-render / same-fp regenerate', () => {
  // The reported root cause: the cache OBJECT churns but the fp is identical → must KEEP.
  assert.deepEqual(decide({ prevKey: 's:fpX', nextKey: 's:fpX', snapshot: [A] }), { kind: 'keep' });
});

test('areaLifecycle: smoothed → geographic clears the on-screen boxes', () => {
  assert.deepEqual(decide({ prevKey: 's:fpX', nextKey: 'm:geographic', isSmoothed: false, snapshot: [A] }), { kind: 'clear' });
});

test('areaLifecycle: geographic → smoothed (same layout) RESTORES from the snapshot', () => {
  // The reported bug: returning to the still-cached smoothed layout must reinstate areas.
  assert.deepEqual(decide({ prevKey: 'm:geographic', nextKey: 's:fpX', isSmoothed: true, snapshot: [A] }), { kind: 'restore', selections: [A] });
});

test('areaLifecycle: file-load round-trip restores via snapshot even with a null fp (key "s:")', () => {
  // A file-loaded layout has currentFpRef=null → areaKey "s:". The adversaries' hole:
  // store-only restore fails (fp null), so the snapshot must carry the file areas.
  assert.deepEqual(decide({ prevKey: 'm:geographic', nextKey: 's:', isSmoothed: true, snapshot: [A, B] }), { kind: 'restore', selections: [A, B] });
});

test('areaLifecycle: delete-all then round-trip does NOT resurrect (empty snapshot → clear)', () => {
  assert.deepEqual(decide({ prevKey: 'm:geographic', nextKey: 's:fpX', isSmoothed: true, snapshot: [] }), { kind: 'clear' });
});

test('areaLifecycle: a genuinely different smoothed fp clears (stale boxes, even if snapshot non-empty)', () => {
  // Regenerate with changed inputs: fpX → fpY. The snapshot holds fpX areas, but the
  // layout changed, so they must NOT be resurrected onto fpY.
  assert.deepEqual(decide({ prevKey: 's:fpX', nextKey: 's:fpY', isSmoothed: true, snapshot: [A] }), { kind: 'clear' });
});

test('areaLifecycle: snapshot is only trusted on a round-trip, never on a smoothed→smoothed change', () => {
  // Same as above but make the distinction explicit: cameFromOtherMode requires prevKey "m:".
  const fromSmoothed = decide({ prevKey: 's:fpX', nextKey: 's:fpY', isSmoothed: true, snapshot: [A, B] });
  const fromGeographic = decide({ prevKey: 'm:geographic', nextKey: 's:fpY', isSmoothed: true, snapshot: [A, B] });
  assert.deepEqual(fromSmoothed, { kind: 'clear' });
  assert.deepEqual(fromGeographic, { kind: 'restore', selections: [A, B] });
});

test('areaLifecycle: returning from a non-geographic non-smoothed mode also restores (m:* prefix)', () => {
  assert.deepEqual(decide({ prevKey: 'm:schematic', nextKey: 's:fpX', isSmoothed: true, snapshot: [A] }), { kind: 'restore', selections: [A] });
});
