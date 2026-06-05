import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTransferPairs, DEFAULT_TRANSFER_METERS, routedGroupsOnly } from './transfers';
import type { StationGroup, TransitGraph, GraphNode } from './layout/types';

const groups: StationGroup[] = [
  { id: 'a', name: 'A', center: [-74.0, 40.75], stationIds: ['s1'] },
  { id: 'b', name: 'B', center: [-74.001, 40.7503], stationIds: ['s2'] }, // ~100m away
  { id: 'c', name: 'C', center: [-74.1, 40.75], stationIds: ['s3'] }, // ~8km away
];

test('findTransferPairs returns nearby groups under the threshold', () => {
  const p = findTransferPairs(groups);
  assert.equal(p.length, 1);
  assert.equal(p[0].fromId, 'a');
  assert.equal(p[0].toId, 'b');
  assert.ok(p[0].meters < 200);
});

test('findTransferPairs honours a custom threshold', () => {
  const p = findTransferPairs(groups, 50);
  assert.equal(p.length, 0);
});

test('default threshold is around two NYC blocks', () => {
  assert.ok(DEFAULT_TRANSFER_METERS >= 200 && DEFAULT_TRANSFER_METERS <= 800);
});

test('routedGroupsOnly drops groups not present as graph nodes', () => {
  const node = (id: string): GraphNode => ({ id, label: id, pos: [0, 0], lngLat: [0, 0] });
  const graph: TransitGraph = {
    nodes: new Map([['a', node('a')]]), // only "a" is on a route
    edges: [],
    adj: new Map(),
    lineTraversals: new Map(),
  };
  const filtered = routedGroupsOnly(groups, graph);
  assert.deepEqual(
    filtered.map((g) => g.id),
    ['a'],
  );
  // And no transfer pair is produced when 'b' has no route.
  assert.equal(findTransferPairs(filtered).length, 0);
});
