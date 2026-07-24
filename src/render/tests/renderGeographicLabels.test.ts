import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geoLabelStops } from '../renderGeographic';
import { buildTransitGraph } from '../layout/graph';
import type { Pixel } from '../layout/types';
import type { Route } from '../../types/game-state';

// Geographic mode feeds the label placer the SAME route-sequenced stop marks the
// smoothed renderer does (one mark per line through a node, carrying lineId and the
// 1-based station number). This is what lets placeLabels order a line's stations by
// route sequence and keep their labels on a consistent side. These tests lock that
// contract, plus the fallback that an unrouted node still gets a mark (so it keeps
// its label).

const mkStation = (id: string, name: string, node: string, lng: number, lat: number) => ({
  id, name, coords: [lng, lat] as [number, number], trackIds: [] as string[],
  trackGroupId: 'tg_' + id, buildType: 'constructed', stNodeIds: [node],
  routeIds: [], createdAt: 0, nearbyStations: [],
});

const stations = [
  mkStation('sA', 'Alpha', 'nA', -122.0, 47.0),
  mkStation('sB', 'Bravo', 'nB', -122.02, 47.01),
  mkStation('sC', 'Charlie', 'nC', -122.04, 47.0),
];

const combo = (a: string, b: string, trackId: string, reversed: boolean) =>
  ({ startStNodeId: a, endStNodeId: b, path: [{ trackId, reversed }], distance: 1 });

const routes = [
  { id: 'r1', bullet: '1', color: '#cc0000', stComboTimings: [],
    stCombos: [combo('nA', 'nB', 'tAB', false), combo('nB', 'nC', 'tBC', false)] },
] as unknown as Route[];

const groups = [
  { id: 'tg_sA', name: 'Alpha', stationIds: ['sA'], center: [-122.0, 47.0] },
  { id: 'tg_sB', name: 'Bravo', stationIds: ['sB'], center: [-122.02, 47.01] },
  { id: 'tg_sC', name: 'Charlie', stationIds: ['sC'], center: [-122.04, 47.0] },
];

const nodePxOf = (graph: ReturnType<typeof buildTransitGraph>): Map<string, Pixel> => {
  const m = new Map<string, Pixel>();
  for (const n of graph.nodes.values()) m.set(n.id, n.pos);
  return m;
};

test('geoLabelStops carries lineId and route sequence for each routed node', () => {
  const graph = buildTransitGraph(stations as never, routes, groups as never);
  const stops = geoLabelStops(graph, nodePxOf(graph));

  for (const id of ['tg_sA', 'tg_sB', 'tg_sC']) {
    const marks = stops.get(id);
    assert.ok(marks && marks.length >= 1, `node ${id} has a mark`);
    const m = marks![0];
    assert.equal(m.lineId, 'r1', `node ${id} mark names its line`);
    assert.ok(typeof m.seq === 'number', `node ${id} mark carries a route sequence`);
  }
  // The sequence increases along the route so the placer can chain neighbours.
  assert.equal(stops.get('tg_sA')![0].seq, 1);
  assert.equal(stops.get('tg_sB')![0].seq, 2);
  assert.equal(stops.get('tg_sC')![0].seq, 3);
});

test('geoLabelStops gives an unrouted node a fallback mark so it still gets a label', () => {
  const graph = buildTransitGraph(stations as never, routes, groups as never);
  const nodePx = nodePxOf(graph);
  // A drawn node no line passes through (a synthetic extra point).
  nodePx.set('ghost', [10, 20] as Pixel);
  const stops = geoLabelStops(graph, nodePx);
  const marks = stops.get('ghost');
  assert.ok(marks && marks.length === 1, 'unrouted node still gets one mark');
  assert.deepEqual(marks![0].pos, [10, 20]);
  assert.equal(marks![0].seq, undefined, 'fallback mark carries no sequence');
});
