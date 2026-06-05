import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStationGroups, buildTransitGraph } from './graph';
import type { Station, Route, Track } from '../../types/game-state';

const stations = [
  { id: 's1', name: 'A', coords: [-122.0, 47.0], trackIds: ['t1'], trackGroupId: 'g1',
    buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's2', name: 'B', coords: [-122.0, 47.01], trackIds: ['t2'], trackGroupId: 'g1',
    buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's3', name: 'C', coords: [-122.1, 47.0], trackIds: ['t3'], trackGroupId: 'g2',
    buildType: 'constructed', stNodeIds: ['n3'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
] as unknown as Station[];

test('buildStationGroups collapses by trackGroupId', () => {
  const groups = buildStationGroups(stations);
  assert.equal(groups.length, 2);
  const g1 = groups.find((g) => g.id === 'g1')!;
  assert.deepEqual(g1.stationIds.sort(), ['s1', 's2']);
  // center is the mean of members
  assert.ok(Math.abs(g1.center[1] - 47.005) < 1e-9);
});

test('buildTransitGraph builds edges between consecutive distinct groups', () => {
  const routes = [
    {
      id: 'r1',
      bullet: '1',
      color: '#ff0000',
      stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 0 }],
      stComboTimings: [],
    },
  ] as unknown as Route[];
  const _tracks = [] as unknown as Track[];
  void _tracks;
  const graph = buildTransitGraph(stations, routes, buildStationGroups(stations));
  assert.equal(graph.nodes.size, 2); // g1, g2
  assert.equal(graph.edges.length, 1); // g1<->g2
  assert.deepEqual([...graph.lineTraversals.keys()], ['r1']);
});
