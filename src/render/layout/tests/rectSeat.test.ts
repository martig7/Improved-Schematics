import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectSeat } from '../rectSeat';

const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

test('two horizontally-aligned members -> one row, one group, no connector', () => {
  const out = rectSeat(
    [{ lineId: 'A', home: [0, 0], axis: 0 }, { lineId: 'B', home: [40, 0], axis: 0 }],
    30, 4,
  );
  assert.equal(out.groups.length, 1);
  assert.equal(out.connectors.length, 0);
  const a = out.centers.get('A')!, b = out.centers.get('B')!;
  assert.ok(near(a[1], b[1]));                 // same y (one horizontal row)
  assert.ok(near(Math.abs(b[0] - a[0]), 34));  // pitch = box+gap
});

test('members split into two rows are joined by exactly one connector', () => {
  // three tight left + one far up-right -> a split is cheaper than one long row
  const out = rectSeat([
    { lineId: 'A', home: [0, 0], axis: 0 },
    { lineId: 'B', home: [34, 0], axis: 0 },
    { lineId: 'C', home: [68, 0], axis: 0 },
    { lineId: 'D', home: [34, 120], axis: 0 },
  ], 30, 4);
  assert.equal(out.groups.length, 2);
  assert.equal(out.connectors.length, 1);
  assert.ok(out.connectors[0].points.length >= 2);
});

test('deterministic: identical output on repeat', () => {
  const args = () => rectSeat(
    [{ lineId: 'A', home: [0, 0], axis: 2 }, { lineId: 'B', home: [3, 60], axis: 2 }], 30, 4);
  assert.deepEqual(args(), args());
});

test('single member -> one box at its home, no connector', () => {
  const out = rectSeat([{ lineId: 'A', home: [10, 10], axis: 0 }], 30, 4);
  assert.equal(out.centers.get('A')!.length, 2);
  assert.equal(out.connectors.length, 0);
});

// Two upright boxes of side `box` centered at c1,c2 overlap iff their footprints
// overlap on BOTH axes. A legible layout must never stack boxes.
const boxesOverlap = (c1: number[], c2: number[], box: number, eps = 1e-6) =>
  Math.abs(c1[0] - c2[0]) < box - eps && Math.abs(c1[1] - c2[1]) < box - eps;

test('identical homes -> boxes spread, no two output centers overlap', () => {
  const box = 30;
  const out = rectSeat([
    { lineId: 'A', home: [100, 100], axis: 0 },
    { lineId: 'B', home: [100, 100], axis: 0 },
    { lineId: 'C', home: [100, 100], axis: 0 },
  ], box, 4);
  const cs = [...out.centers.values()];
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++)
      assert.ok(!boxesOverlap(cs[i], cs[j], box), `centers ${i},${j} overlap`);
});

test('homes closer than box footprint -> centers spread into a row', () => {
  const box = 30;
  const out = rectSeat([
    { lineId: 'A', home: [0, 0], axis: 0 },
    { lineId: 'B', home: [6, 0], axis: 0 },
  ], box, 4);
  const a = out.centers.get('A')!, b = out.centers.get('B')!;
  // Separated by at least a full box side on some axis (not left overlapping).
  assert.ok(Math.abs(a[0] - b[0]) >= box - 1e-6 || Math.abs(a[1] - b[1]) >= box - 1e-6);
});
