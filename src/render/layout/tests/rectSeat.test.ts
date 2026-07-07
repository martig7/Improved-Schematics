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
