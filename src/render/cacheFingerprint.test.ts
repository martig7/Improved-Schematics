import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintInputs, type FingerprintInput } from './cacheFingerprint';

const base = (): FingerprintInput => ({
  stations: [
    { id: 's1', name: 'A', coords: [-122.0, 47.0], trackGroupId: 'g1', buildType: 'constructed', stNodeIds: ['n1'], trackIds: ['t1'] },
    { id: 's2', name: 'B', coords: [-122.05, 47.02], trackGroupId: 'g2', buildType: 'constructed', stNodeIds: ['n2'], trackIds: ['t2'] },
  ] as never,
  tracks: [
    { id: 't1', coords: [[-122.0, 47.0], [-122.05, 47.02]] },
    { id: 't2', coords: [[-122.05, 47.02], [-122.1, 47.0]] },
  ] as never,
  routes: [
    { id: 'r1', bullet: '1', color: '#cc0000', stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n2', distance: 1, path: [{ trackId: 't1', reversed: false }] }] },
  ] as never,
  stationGroups: undefined,
  geography: { bbox: [0, 0, 1, 1], water: [{}], green: [] } as never,
  options: { padding: 0.06, warpAlpha: 0.8, geographicAffinity: 0.05, boxExpand: 4, boxGrowth: 1.2, dark: false, theme: { lineWidth: 4 } },
});

test('fingerprint is deterministic (same input → same fp), order-independent', () => {
  const a = fingerprintInputs(base());
  const b = fingerprintInputs(base());
  assert.equal(a.fp, b.fp);
  // reordering routes/stations must not change the fp (we sort by id)
  const shuffled = base();
  shuffled.stations = [shuffled.stations[1], shuffled.stations[0]] as never;
  assert.equal(fingerprintInputs(shuffled).fp, a.fp);
});

test('fingerprint changes on each layout-affecting input', () => {
  const fp = (m: (i: FingerprintInput) => void) => { const i = base(); m(i); return fingerprintInputs(i).fp; };
  const ref = fingerprintInputs(base()).fp;
  assert.notEqual(fp((i) => ((i.routes[0] as { id: string }).id = 'rX')), ref, 'route id');
  assert.notEqual(fp((i) => ((i.routes[0] as { color: string }).color = '#0000ff')), ref, 'route color');
  assert.notEqual(fp((i) => ((i.stations[0] as { coords: number[] }).coords = [0, 0])), ref, 'station coords');
  assert.notEqual(fp((i) => ((i.stations[0] as { id: string }).id = 'sX')), ref, 'station id');
  assert.notEqual(fp((i) => ((i.tracks[0] as { coords: number[][] }).coords = [[9, 9], [8, 8]])), ref, 'track coords');
  assert.notEqual(fp((i) => (i.options!.warpAlpha = 0.2)), ref, 'warp option');
  assert.notEqual(fp((i) => (i.options!.boxFrac = 0.6)), ref, 'boxFrac (box density cutoff)');
  assert.notEqual(fp((i) => (i.options!.theme!.lineWidth = 8)), ref, 'lineWidth (feeds dHat)');
  assert.notEqual(fp((i) => (i.options!.dark = true)), ref, 'dark');
  assert.notEqual(fp((i) => (i.geography = undefined)), ref, 'geography presence (bug-1 token)');
});

test('fingerprint ignores draw-only changes (none of station name... wait, name IS in it)', () => {
  // Draw-time toggles are NOT in FingerprintInput at all (showLabels/labelScale/
  // stationRadius), so they cannot affect the fp by construction. Confirm a pure
  // geography-bbox drift (same feature counts) does NOT change the fp — bbox is
  // intentionally excluded as it drifts with demand.
  const ref = fingerprintInputs(base()).fp;
  const drift = base();
  drift.geography = { bbox: [9, 9, 10, 10], water: [{}], green: [] } as never;
  assert.equal(fingerprintInputs(drift).fp, ref, 'bbox drift (same counts) must not invalidate');
});
