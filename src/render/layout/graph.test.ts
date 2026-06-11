import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStationGroups, buildTransitGraph, getOrBuildStationGroups, buildGroupMaps } from './graph';
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

test('parallel forward/back tracks in one API station group attach one corridor geo', () => {
  const platformA = {
    id: 's1', name: 'Hub', coords: [-122.0, 47.0], trackIds: ['fwd', 'back'], trackGroupId: 'tg1',
    buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [],
  };
  const platformB = {
    id: 's2', name: 'End', coords: [-122.1, 47.0], trackIds: ['t2'], trackGroupId: 'tg2',
    buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1'], createdAt: 0, nearbyStations: [],
  };
  const st = [platformA, platformB] as unknown as Station[];
  const apiGroups = [
    { id: 'hub', name: 'Hub', stationIds: ['s1'], center: [-122.0, 47.0] },
    { id: 'end', name: 'End', stationIds: ['s2'], center: [-122.1, 47.0] },
  ];
  const groups = getOrBuildStationGroups(st, apiGroups);
  const { trackToGroup } = buildGroupMaps(st, groups);
  assert.equal(trackToGroup.get('fwd'), 'hub');
  assert.equal(trackToGroup.get('back'), 'hub');

  const tracks = [
    { id: 'fwd', coords: [[-122.0, 47.0], [-122.1, 47.0]], buildType: 'constructed' },
    { id: 'back', coords: [[-122.1, 47.0001], [-122.0, 47.0001]], buildType: 'constructed' },
    { id: 't2', coords: [[-122.1, 47.0], [-122.15, 47.0]], buildType: 'constructed' },
  ] as unknown as Track[];
  const routes = [{
    id: 'r1', color: '#f00', stCombos: [{
      startStNodeId: 'n1', endStNodeId: 'n2',
      path: [
        { trackId: 'fwd', reversed: false, length: 1, signals: [] },
        { trackId: 'back', reversed: true, length: 1, signals: [] },
      ],
      distance: 1,
    }],
  }] as unknown as Route[];

  const graph = buildTransitGraph(st, routes, groups, tracks);
  const edge = graph.edges.find((e) => e.from === 'hub' && e.to === 'end')!;
  assert.ok(edge?.geo);
  assert.equal(edge.geo!.length, 2, 'parallel same-group tracks should not zigzag geo');
});

test('parallel unmapped corridor tracks contribute one centerline', () => {
  const platformA = {
    id: 's1', name: 'Hub', coords: [-122.0, 47.0], trackIds: [], trackGroupId: 'tg1',
    buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [],
  };
  const platformB = {
    id: 's2', name: 'End', coords: [-122.1, 47.0], trackIds: [], trackGroupId: 'tg2',
    buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1'], createdAt: 0, nearbyStations: [],
  };
  const st = [platformA, platformB] as unknown as Station[];
  const apiGroups = [
    { id: 'hub', name: 'Hub', stationIds: ['s1'], center: [-122.0, 47.0] },
    { id: 'end', name: 'End', stationIds: ['s2'], center: [-122.1, 47.0] },
  ];
  const groups = getOrBuildStationGroups(st, apiGroups);
  const tracks = [
    { id: 'fwd', coords: [[-122.0, 47.0], [-122.1, 47.0]], buildType: 'constructed' },
    { id: 'back', coords: [[-122.1, 47.0001], [-122.0, 47.0001]], buildType: 'constructed' },
  ] as unknown as Track[];
  const routes = [{
    id: 'r1', color: '#f00', stCombos: [{
      startStNodeId: 'n1', endStNodeId: 'n2',
      path: [
        { trackId: 'fwd', reversed: false, length: 1, signals: [] },
        { trackId: 'back', reversed: true, length: 1, signals: [] },
      ],
      distance: 1,
    }],
  }] as unknown as Route[];

  const graph = buildTransitGraph(st, routes, groups, tracks);
  const edge = graph.edges.find((e) => e.from === 'hub' && e.to === 'end')!;
  assert.ok(edge?.geo);
  assert.equal(edge.geo!.length, 2, 'parallel corridor tracks should not double-draw geo');
});

test('walkRouteVisits suppresses loop-closure deadhead legs', () => {
  // route: A->B, B->A (symmetric 1km legs), then a 60km closing leg A->C
  // with no reverse counterpart - the closing leg must paint nothing and
  // leave a service break instead.
  const routes = [
    {
      id: 'r9',
      bullet: '9',
      color: '#662483',
      stCombos: [
        { startStNodeId: 'n1', endStNodeId: 'n2', path: [], distance: 1000 },
        { startStNodeId: 'n2', endStNodeId: 'n1', path: [], distance: 1000 },
        { startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 60000 },
      ],
      stComboTimings: [],
    },
  ] as unknown as Route[];
  const graph = buildTransitGraph(stations, routes, buildStationGroups(stations));
  // only the g1<->g1 self pair (skipped) and the closing g1->g2 (suppressed):
  // no edge between g1 and g2 may exist
  assert.equal(graph.edges.length, 0);
  // the traversal still exists for the symmetric part (n1/n2 share group g1,
  // so no edges at all here - the point is the 60km leg did NOT create one)
});

test('walkRouteVisits keeps symmetric long legs (express)', () => {
  const routes = [
    {
      id: 'rX',
      bullet: 'X',
      color: '#112233',
      stCombos: [
        { startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 15000 },
        { startStNodeId: 'n3', endStNodeId: 'n1', path: [], distance: 15000 },
      ],
      stComboTimings: [],
    },
  ] as unknown as Route[];
  const graph = buildTransitGraph(stations, routes, buildStationGroups(stations));
  assert.equal(graph.edges.length, 1); // g1<->g2 survives: symmetric legs
});
