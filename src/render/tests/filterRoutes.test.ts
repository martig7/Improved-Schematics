import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRoutesByEnabled } from '../filterRoutes';

const net = () => ({
  routes: [
    { id: 'rA', stNodes: [{ id: 's1' }, { id: 's2' }] },
    { id: 'rB', stNodes: [{ id: 's2' }, { id: 's3' }] },
  ],
  stations: [
    { id: 'stA', stNodeIds: ['s1'], trackIds: ['t1'] },      // only rA
    { id: 'stShared', stNodeIds: ['s2'], trackIds: ['t2'] }, // rA and rB
    { id: 'stB', stNodeIds: ['s3'], trackIds: ['t3'] },      // only rB
  ],
  tracks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  stationGroups: [{ stationIds: ['stA'] }, { stationIds: ['stShared', 'stB'] }],
});

test('empty disabled set returns the input unchanged (same references)', () => {
  const n = net();
  const out = filterRoutesByEnabled(n, []);
  assert.equal(out, n);
  assert.equal(out.routes, n.routes);
});

test('disabling a route drops it and its exclusively-owned stNodes/stations/tracks', () => {
  const out = filterRoutesByEnabled(net(), ['rA']);
  assert.deepEqual(out.routes.map((r) => r.id), ['rB']);
  assert.deepEqual(out.stations.map((s) => s.id).sort(), ['stB', 'stShared']);
  assert.deepEqual(out.tracks.map((t) => t.id).sort(), ['t2', 't3']);
});

test('a station shared by a disabled and a surviving route is kept with its tracks', () => {
  const out = filterRoutesByEnabled(net(), ['rA']);
  assert.ok(out.stations.some((s) => s.id === 'stShared'));
  assert.ok(out.tracks.some((t) => t.id === 't2'));
});

test('station groups are filtered to surviving stations', () => {
  const out = filterRoutesByEnabled(net(), ['rA']);
  assert.equal(out.stationGroups!.length, 1);
  assert.deepEqual(out.stationGroups![0].stationIds, ['stShared', 'stB']);
});

test('disabling every route yields empty arrays', () => {
  const out = filterRoutesByEnabled(net(), ['rA', 'rB']);
  assert.deepEqual(out.routes, []);
  assert.deepEqual(out.stations, []);
  assert.deepEqual(out.tracks, []);
  assert.deepEqual(out.stationGroups, []);
});
