import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeParisByNode } from '../parisCapsules';
import { BADGE_R } from '../dcStations';
import type { StopMark } from '../types';
import { LINE_WIDTH, MARKER_SCALE, MARK_R0 } from '../../constants';
import { capsuleStrokeWidths } from '../../stations/primitives';

const mark = (
  lineId: string,
  pos: [number, number],
  axis: number,
  terminus = false,
): StopMark => ({ lineId, color: '#000000', pos, axis, terminus });

test('a direct two-axis intersection collapses to one round bubble', () => {
  const stations = computeParisByNode(new Map([
    ['n', [mark('a', [0, 0], 0), mark('b', [0, 0], 2)]],
  ]), 4);
  const station = stations.get('n')!;
  assert.equal(station.cells.length, 1);
  assert.deepEqual(station.cells[0].lineIds, ['a', 'b']);
  assert.equal(station.cells[0].shape, 'round');
  assert.equal(station.groups.length, 1);
});

test('equivalent parallel axes never collapse to one bubble', () => {
  const station = computeParisByNode(new Map([
    ['n', [mark('a', [0, 0], 0), mark('b', [0, 0], 4)]],
  ]), LINE_WIDTH).get('n')!;
  assert.equal(station.cells.length, 2);
  assert.deepEqual(station.cells.map((cell) => cell.lineIds), [['a'], ['b']]);
});

test('a Paris cell uses the NYC capsule interior width', () => {
  const station = computeParisByNode(new Map([
    ['n', [mark('a', [0, 0], 0), mark('b', [0, 0], 2)]],
  ]), LINE_WIDTH).get('n')!;
  const nyc = capsuleStrokeWidths(MARK_R0 * MARKER_SCALE);
  assert.equal(station.radius * 2, nyc.fill);
});

test('a diagonal row uses one 45 degree capsule', () => {
  const stations = computeParisByNode(new Map([
    ['n', [mark('a', [0, 0], 0), mark('b', [4, 4], 0), mark('c', [8, 8], 0)]],
  ]), 4);
  const station = stations.get('n')!;
  assert.equal(station.groups.length, 1);
  assert.equal(station.groups[0].axis, 1);
  assert.equal(station.groups[0].points.length, 3);
  assert.equal(station.cells[1].shape, 'square');
  assert.equal(station.cells[0].shape, 'round');
  assert.equal(station.cells[2].shape, 'round');
});

test('coincident termini share one split-color endpoint cell', () => {
  const stations = computeParisByNode(new Map([
    ['n', [mark('a', [5, 5], 0, true), mark('b', [5, 5], 2, true)]],
  ]), 4);
  const cell = stations.get('n')!.cells[0];
  assert.deepEqual(cell.endpointLineIds, ['a', 'b']);
  assert.equal(cell.shape, 'round');
});

test('endpoint geometry follows a seated capsule cell', () => {
  const stops = new Map<string, StopMark[]>([
    ['n', [{ ...mark('a', [0, 0], 0, true), end: [-1, 0] }, mark('b', [12, 12], 0)]],
  ]);
  const station = computeParisByNode(stops, 4).get('n')!;
  assert.equal(station.ends.length, 1);
  const endpointCell = station.cells.find((cell) => cell.lineIds.includes('a'))!;
  assert.deepEqual(station.ends[0].cut[1], endpointCell.at[1]);
  assert.ok(station.ends[0].cut[0] < endpointCell.at[0]);
  const badgeDistance = Math.sqrt(
    (station.ends[0].at[0] - endpointCell.at[0]) ** 2 +
    (station.ends[0].at[1] - endpointCell.at[1]) ** 2,
  );
  assert.ok(badgeDistance >= station.radius + BADGE_R, 'badge clears the endpoint bubble');
});

test('the solve is deterministic', () => {
  const stops = new Map([
    ['n', [
      mark('a', [0, 0], 0),
      mark('b', [9, 9], 1),
      mark('c', [18, 0], 2, true),
      mark('d', [9, -9], 3),
    ]],
  ]);
  assert.deepEqual(computeParisByNode(stops, 4), computeParisByNode(stops, 4));
});

test('a large hub uses the bounded grouping path', () => {
  const marks = Array.from({ length: 12 }, (_, i) => mark(`l${i}`, [i * 10, (i % 3) * 10], i % 4));
  const station = computeParisByNode(new Map([['n', marks]]), 4).get('n')!;
  assert.equal(station.cells.length, 12);
  assert.ok(station.groups.length > 0 && station.groups.length <= 12);
  assert.equal(station.groups.reduce((sum, group) => sum + group.cellIndexes.length, 0), 12);
});

test('separate capsule groups receive an octilinear connector', () => {
  const marks = [
    mark('a', [0, 0], 0), mark('b', [12, 0], 0),
    mark('c', [100, 70], 0), mark('d', [112, 70], 0),
  ];
  const station = computeParisByNode(new Map([['n', marks]]), 4).get('n')!;
  assert.equal(station.groups.length, 2);
  assert.equal(station.connectors.length, 1);
  const points = station.connectors[0].points;
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i][0] - points[i - 1][0]);
    const dy = Math.abs(points[i][1] - points[i - 1][1]);
    assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, 'every connector leg is octilinear');
  }
});
