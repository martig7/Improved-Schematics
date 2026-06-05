import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTransferPairs,
  DEFAULT_TRANSFER_METERS,
  routedGroupsOnly,
  bracketTransferPath,
  renderTransferConnectors,
  BRACKET_LEG_EXTRA,
} from './transfers';
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

test('bracketTransferPath forms a downward staple for horizontally separated dots', () => {
  const r = 3.5;
  const path = bracketTransferPath([0, 0], [10, 1], r);
  const yCross = 1 + r + BRACKET_LEG_EXTRA;
  assert.deepEqual(path, [
    [0, 0],
    [0, yCross],
    [10, yCross],
    [10, 1],
  ]);
});

test('bracketTransferPath forms a rightward staple for vertically separated dots', () => {
  const r = 3.5;
  const path = bracketTransferPath([0, 0], [1, 10], r);
  const xCross = 1 + r + BRACKET_LEG_EXTRA;
  assert.deepEqual(path, [
    [0, 0],
    [xCross, 0],
    [xCross, 10],
    [1, 10],
  ]);
});

test('bracketTransferPath uses only axis-aligned segments', () => {
  const path = bracketTransferPath([4, 8], [18, 11], 3.5);
  for (let i = 1; i < path.length; i++) {
    const axisAligned =
      path[i][0] === path[i - 1][0] || path[i][1] === path[i - 1][1];
    assert.ok(axisAligned);
  }
});

test('bracketTransferPath endpoints sit at the dot centers', () => {
  const from: [number, number] = [50, 50];
  const to: [number, number] = [62, 51];
  const path = bracketTransferPath(from, to, 3.5);
  assert.deepEqual(path[0], from);
  assert.deepEqual(path[path.length - 1], to);
});

test('bracketTransferPath crossbar clears both overlapping dots', () => {
  const r = 3.5;
  // Heavily overlapping, vertically stacked dots.
  const path = bracketTransferPath([100, 100], [101, 106], r);
  const xCross = path[1][0];
  // Crossbar must sit at least `r` to the side of both dot centers.
  assert.ok(Math.abs(xCross - 100) >= r);
  assert.ok(Math.abs(xCross - 101) >= r);
});

test('renderTransferConnectors emits path staples, not straight lines', () => {
  const pairs = findTransferPairs(groups);
  const svg = renderTransferConnectors(
    pairs,
    () => ({ from: [0, 0], to: [12, 0], radius: 3 }),
    new Set(),
    { dark: false, strokeWidth: 2 },
  );
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /<line /);
  assert.match(svg, /class="transfers"/);
});

test('renderTransferConnectors skips direct route edges', () => {
  const pairs = findTransferPairs(groups);
  const svg = renderTransferConnectors(
    pairs,
    () => ({ from: [0, 0], to: [12, 0], radius: 3 }),
    new Set(['a|b']),
    { dark: false, strokeWidth: 2 },
  );
  assert.equal(svg, '');
});

test('renderTransferConnectors skips pairs that fail to resolve', () => {
  const pairs = findTransferPairs(groups);
  const svg = renderTransferConnectors(pairs, () => null, new Set(), {
    dark: false,
    strokeWidth: 2,
  });
  assert.equal(svg, '');
});
