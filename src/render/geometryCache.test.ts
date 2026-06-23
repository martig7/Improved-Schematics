// The geometry-on-pre cache: drawSmoothed computes the expensive toggle-independent
// ribbon geometry (lane bundles + marker placement) ONCE, memoizes it on `pre`, and
// serializes it with the precompute. A draw from a restored pre must skip the solver
// and reproduce byte-identical svg + Scene. Guards the cache-read perf win
// (docs/cache-read-perf.md) against future renderRibbons changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precomputeSmoothed, drawSmoothed } from './renderGeographic';
import { serializePre, deserializePre } from './persist';
import type { SmoothedPrecomputed } from './schematic';
import type { SceneOut } from './renderOctilinear';
import type { GeographyData } from '../geography/types';

const STATIONS = [
  { id: 's1', name: 'Alpha', coords: [-122.0, 47.0], trackIds: ['t1'], trackGroupId: 'g1', buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's2', name: 'Beta & Co', coords: [-122.05, 47.02], trackIds: ['t2'], trackGroupId: 'g2', buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1', 'r2'], createdAt: 0, nearbyStations: [] },
  { id: 's3', name: 'Gamma', coords: [-122.1, 47.0], trackIds: ['t3'], trackGroupId: 'g3', buildType: 'constructed', stNodeIds: ['n3'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's4', name: 'Delta', coords: [-122.05, 46.97], trackIds: ['t4'], trackGroupId: 'g4', buildType: 'constructed', stNodeIds: ['n4'], routeIds: ['r2'], createdAt: 0, nearbyStations: [] },
];
const TRACKS = [
  { id: 't1', coords: [[-122.0, 47.0], [-122.05, 47.02]] },
  { id: 't2', coords: [[-122.05, 47.02], [-122.1, 47.0]] },
  { id: 't3', coords: [[-122.05, 47.02], [-122.05, 46.97]] },
];
const ROUTES = [
  { id: 'r1', bullet: '1', color: '#cc0000', stComboTimings: [], stCombos: [
    { startStNodeId: 'n1', endStNodeId: 'n2', path: [{ trackId: 't1', reversed: false }], distance: 1 },
    { startStNodeId: 'n2', endStNodeId: 'n3', path: [{ trackId: 't2', reversed: false }], distance: 1 } ] },
  { id: 'r2', bullet: '2', color: '#0000cc', stComboTimings: [], stCombos: [
    { startStNodeId: 'n2', endStNodeId: 'n4', path: [{ trackId: 't3', reversed: false }], distance: 1 } ] },
];
const GEO: GeographyData = {
  bbox: [-122.12, 46.95, -121.98, 47.05],
  water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-122.1, 47.0], [-122.05, 47.0], [-122.05, 47.03], [-122.1, 47.03], [-122.1, 47.0]]] } }],
  green: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-122.02, 46.98], [-122.0, 46.98], [-122.0, 47.0], [-122.02, 47.0], [-122.02, 46.98]]] } }],
};

function fresh(): SmoothedPrecomputed {
  const pre = precomputeSmoothed({
    routes: ROUTES as never,
    tracks: TRACKS as never,
    stations: STATIONS as never,
    geography: GEO,
    options: { mode: 'smoothed', showLabels: true, showStations: true, width: 600, height: 600 },
  });
  assert.notEqual(typeof pre, 'string', 'fixture must precompute a real layout');
  if (typeof pre === 'string') throw new Error('unreachable');
  return pre;
}
const opts = { showLabels: true, showStations: true };

test('precompute is geometry-free; first draw memoizes it on pre', () => {
  const pre = fresh();
  assert.equal(pre.geometry, undefined, 'precompute does not eagerly build geometry');
  drawSmoothed(pre, opts);
  assert.ok(pre.geometry, 'first draw memoizes geometry on pre');
});

test('serialized geometry round-trips; restored draw is byte-identical (svg + scene)', () => {
  const pre = fresh();
  const out1: SceneOut = { scene: null };
  const svg1 = drawSmoothed(pre, opts, out1); // memoizes geometry
  assert.ok(pre.geometry, 'geometry memoized before serialize');

  const restored = deserializePre(serializePre(pre));
  assert.notEqual(typeof restored, 'string');
  if (typeof restored === 'string') throw new Error('unreachable');
  assert.ok(restored.geometry, 'geometry survives serialize/deserialize');

  const out2: SceneOut = { scene: null };
  const svg2 = drawSmoothed(restored, opts, out2);
  assert.equal(svg2, svg1, 'restored draw produces identical svg (placement reused, not recomputed)');
  assert.deepEqual(out2.scene, out1.scene, 'restored draw produces identical Scene IR');
});

test('memoized geometry is reused across toggle changes (same object, not recomputed)', () => {
  const pre = fresh();
  drawSmoothed(pre, { showLabels: false, showStations: false });
  const g = pre.geometry;
  assert.ok(g);
  drawSmoothed(pre, { showLabels: true, showStations: true });
  assert.equal(pre.geometry, g, 'toggles reuse the same geometry object');
});
