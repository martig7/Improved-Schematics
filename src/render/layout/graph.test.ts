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

test('buildTransitGraph collapses same-bullet+colour routes (loop directions) into one line', () => {
  // A loop the game models as two routes: clockwise + counter-clockwise, same bullet+colour
  // (colour case differs to exercise the case-insensitive match).
  const cw = { id: 'rCW', bullet: 'A', color: '#ee352e', stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 0 }], stComboTimings: [] };
  const ccw = { id: 'rCCW', bullet: 'A', color: '#EE352E', stCombos: [{ startStNodeId: 'n3', endStNodeId: 'n1', path: [], distance: 0 }], stComboTimings: [] };
  const graph = buildTransitGraph(stations, [cw, ccw] as unknown as Route[], buildStationGroups(stations));
  assert.equal(graph.edges.length, 1, 'one shared edge g1<->g2');
  assert.equal(graph.edges[0].lines.length, 1, 'both directions bundle as ONE line');
  assert.equal(graph.edges[0].lines[0].id, 'rCW', 'collapsed onto the first route id');
  assert.deepEqual([...graph.lineTraversals.keys()], ['rCW'], 'one traversal under the canonical id');
});

test('buildTransitGraph keeps same-bullet DIFFERENT-colour routes separate', () => {
  const red = { id: 'rRed', bullet: 'A', color: '#ee352e', stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 0 }], stComboTimings: [] };
  const blue = { id: 'rBlue', bullet: 'A', color: '#0000ff', stCombos: [{ startStNodeId: 'n3', endStNodeId: 'n1', path: [], distance: 0 }], stComboTimings: [] };
  const graph = buildTransitGraph(stations, [red, blue] as unknown as Route[], buildStationGroups(stations));
  assert.equal(graph.edges[0].lines.length, 2, 'different colours are different lines');
});

test('buildTransitGraph does not collapse blank-bullet routes together', () => {
  const a = { id: 'rA', bullet: '', color: '#888888', stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 0 }], stComboTimings: [] };
  const b = { id: 'rB', bullet: '  ', color: '#888888', stCombos: [{ startStNodeId: 'n3', endStNodeId: 'n1', path: [], distance: 0 }], stComboTimings: [] };
  const graph = buildTransitGraph(stations, [a, b] as unknown as Route[], buildStationGroups(stations));
  assert.equal(graph.edges[0].lines.length, 2, 'blank bullets are not a meaningful name → never merged');
});

test('buildTransitGraph keeps a BRANCH (same bullet+colour, DIVERGENT edges) as distinct lines', () => {
  // A trunk T→J that diverges to two terminals A and B, modelled (like the game does) as two
  // same-bullet+colour routes. Their edge sets differ, so they must NOT collapse — else one arm
  // would be dropped (the DAL "Ross Av" bug). True loop directions (equal edge sets) still collapse.
  const mk = (id: string, tg: string, node: string, lng: number, lat: number) =>
    ({ id, name: id, coords: [lng, lat], trackIds: ['tk-' + id], trackGroupId: tg, buildType: 'constructed', stNodeIds: [node], routeIds: [], createdAt: 0, nearbyStations: [] });
  const brStations = [mk('sT', 'gT', 'nT', -96.0, 32.0), mk('sJ', 'gJ', 'nJ', -96.1, 32.0), mk('sA', 'gA', 'nA', -96.2, 32.1), mk('sB', 'gB', 'nB', -96.2, 31.9)] as unknown as Station[];
  const combo = (a: string, b: string) => ({ startStNodeId: a, endStNodeId: b, path: [], distance: 0 });
  const r1 = { id: 'br1', bullet: 'X', color: '#123456', stCombos: [combo('nT', 'nJ'), combo('nJ', 'nA')], stComboTimings: [] };
  const r2 = { id: 'br2', bullet: 'X', color: '#123456', stCombos: [combo('nT', 'nJ'), combo('nJ', 'nB')], stComboTimings: [] };
  const graph = buildTransitGraph(brStations, [r1, r2] as unknown as Route[], buildStationGroups(brStations));
  assert.equal(graph.lineTraversals.size, 2, 'divergent branch arms stay distinct lines (no collapse)');
  const edge = (x: string, y: string) => graph.edges.find((e) => (e.from === x && e.to === y) || (e.from === y && e.to === x))!;
  assert.equal(edge('gT', 'gJ').lines.length, 2, 'the shared trunk edge carries BOTH line ids (for the Y-split)');
  assert.equal(edge('gJ', 'gA').lines.length, 1, 'branch A edge carries one line');
  assert.equal(edge('gJ', 'gB').lines.length, 1, 'branch B edge carries one line');
  assert.notEqual(edge('gJ', 'gA').lines[0].id, edge('gJ', 'gB').lines[0].id, 'the two arms are different lines');
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

const positioningStations = [
  { id: 'px', name: 'X', coords: [-122.0, 47.0], trackIds: ['tx'], trackGroupId: 'gx',
    buildType: 'constructed', stNodeIds: ['nx'], routeIds: ['rp'], createdAt: 0, nearbyStations: [] },
  { id: 'py', name: 'Y', coords: [-122.0, 47.05], trackIds: ['ty'], trackGroupId: 'gy',
    buildType: 'constructed', stNodeIds: ['ny'], routeIds: ['rp'], createdAt: 0, nearbyStations: [] },
  { id: 'pz', name: 'Z', coords: [-122.1, 47.0], trackIds: ['tz'], trackGroupId: 'gz',
    buildType: 'constructed', stNodeIds: ['nz'], routeIds: ['rp'], createdAt: 0, nearbyStations: [] },
] as unknown as Station[];

test('walkRouteVisits suppresses redundant positioning legs', () => {
  // X<->Y<->Z all served by symmetric 1km legs; a 60km Z->X hop with no
  // reverse closes the cycle. Removing it keeps every group served and the
  // route connected, so it must paint nothing (service break instead).
  const routes = [
    {
      id: 'rp',
      bullet: 'P',
      color: '#662483',
      stCombos: [
        { startStNodeId: 'nx', endStNodeId: 'ny', path: [], distance: 1000 },
        { startStNodeId: 'ny', endStNodeId: 'nz', path: [], distance: 1000 },
        { startStNodeId: 'nz', endStNodeId: 'ny', path: [], distance: 1000 },
        { startStNodeId: 'ny', endStNodeId: 'nx', path: [], distance: 1000 },
        { startStNodeId: 'nz', endStNodeId: 'nx', path: [], distance: 60000 },
      ],
      stComboTimings: [],
    },
  ] as unknown as Route[];
  const graph = buildTransitGraph(positioningStations, routes, buildStationGroups(positioningStations));
  // X-Y and Y-Z survive; the 60km Z-X hop must NOT create an edge
  assert.equal(graph.edges.length, 2);
  assert.ok(!graph.edges.some((e) =>
    (e.from === 'gx' && e.to === 'gz') || (e.from === 'gz' && e.to === 'gx')));
});

test('walkRouteVisits keeps a long leg that is the sole link (safety guard)', () => {
  // Y->Z is 60km with no reverse, but it is the ONLY leg serving Z —
  // suppressing it would lose the station, so it must be kept.
  const routes = [
    {
      id: 'rp',
      bullet: 'P',
      color: '#662483',
      stCombos: [
        { startStNodeId: 'nx', endStNodeId: 'ny', path: [], distance: 1000 },
        { startStNodeId: 'ny', endStNodeId: 'nx', path: [], distance: 1000 },
        { startStNodeId: 'ny', endStNodeId: 'nz', path: [], distance: 60000 },
      ],
      stComboTimings: [],
    },
  ] as unknown as Route[];
  const graph = buildTransitGraph(positioningStations, routes, buildStationGroups(positioningStations));
  assert.equal(graph.edges.length, 2); // X-Y AND Y-Z both drawn
  assert.ok(graph.edges.some((e) =>
    (e.from === 'gy' && e.to === 'gz') || (e.from === 'gz' && e.to === 'gy')));
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
