import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGeographic } from '../renderGeographic';
import type { Route, Track } from '../../types/game-state';

// The plain geographic path must canonicalize input ORDER by id so the offline
// dump and the game's live data (iterated in a different order) render byte-
// identical SVG from the same network. Node draw order (Map insertion order) and
// route line paint order both otherwise follow the raw input array order.

const mkStation = (id: string, name: string, node: string, lng: number, lat: number) => ({
  id,
  name,
  coords: [lng, lat] as [number, number],
  trackIds: [] as string[],
  trackGroupId: 'tg_' + id,
  buildType: 'constructed',
  stNodeIds: [node],
  routeIds: [],
  createdAt: 0,
  nearbyStations: [],
});

const stations = [
  mkStation('sA', 'Alpha', 'nA', -122.0, 47.0),
  mkStation('sB', 'Bravo', 'nB', -122.02, 47.01),
  mkStation('sC', 'Charlie', 'nC', -122.04, 47.0),
];

const tracks = [
  { id: 'tAB', coords: [[-122.0, 47.0], [-122.02, 47.01]] },
  { id: 'tBC', coords: [[-122.02, 47.01], [-122.04, 47.0]] },
] as unknown as Track[];

const combo = (a: string, b: string, trackId: string, reversed: boolean) =>
  ({ startStNodeId: a, endStNodeId: b, path: [{ trackId, reversed }], distance: 1 });

const routes = [
  { id: 'r1', bullet: '1', color: '#cc0000', stComboTimings: [],
    stCombos: [combo('nA', 'nB', 'tAB', false), combo('nB', 'nC', 'tBC', false)] },
  { id: 'r2', bullet: '2', color: '#0066cc', stComboTimings: [],
    stCombos: [combo('nC', 'nB', 'tBC', true), combo('nB', 'nA', 'tAB', true)] },
] as unknown as Route[];

const stationGroups = [
  { id: 'tg_sA', name: 'Alpha', stationIds: ['sA'], center: [-122.0, 47.0] },
  { id: 'tg_sB', name: 'Bravo', stationIds: ['sB'], center: [-122.02, 47.01] },
  { id: 'tg_sC', name: 'Charlie', stationIds: ['sC'], center: [-122.04, 47.0] },
];

const pick = <T>(arr: T[], order: number[]): T[] => order.map((i) => arr[i]);

const render = (sOrder: number[], rOrder: number[], tOrder: number[], gOrder: number[]): string =>
  renderGeographic({
    routes: pick(routes, rOrder) as never,
    tracks: pick(tracks, tOrder) as never,
    stations: pick(stations, sOrder) as never,
    stationGroups: pick(stationGroups, gOrder),
    options: { showStations: true, showLabels: true, width: 600, height: 600 },
  });

test('plain geographic render is byte-identical under shuffled input arrays', () => {
  const canonical = render([0, 1, 2], [0, 1], [0, 1], [0, 1, 2]);
  // Guard against a vacuous pass: markers and at least one route line are drawn.
  assert.match(canonical, /stations-dots/, 'expected station markers in the output');
  assert.match(canonical, /<path d=/, 'expected at least one route line in the output');

  const reversed = render([2, 1, 0], [1, 0], [1, 0], [2, 1, 0]);
  const mixed = render([1, 2, 0], [1, 0], [0, 1], [1, 0, 2]);
  assert.equal(reversed, canonical, 'reversed input arrays must render identical SVG');
  assert.equal(mixed, canonical, 'arbitrarily permuted input arrays must render identical SVG');
});
