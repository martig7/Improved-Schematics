import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octiConnect } from '../octiConnect';

const R = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h });

test('vertical gap (x-ranges overlap) -> single vertical segment', () => {
  const c = octiConnect(R(0, 0), R(0, 30));       // stacked, same x
  assert.equal(c.points.length, 2);
  assert.equal(c.points[0][0], c.points[1][0]);   // vertical: equal x
  assert.deepEqual(c.points[0], [5, 10]);         // bottom edge of A (center x)
  assert.deepEqual(c.points[1], [5, 30]);         // top edge of B
});

test('horizontal gap (y-ranges overlap) -> single horizontal segment', () => {
  const c = octiConnect(R(0, 0), R(30, 0));       // side by side, same y
  assert.equal(c.points.length, 2);
  assert.equal(c.points[0][1], c.points[1][1]);   // horizontal: equal y
});

test('pure diagonal offset -> single 45 segment (corner to corner)', () => {
  const c = octiConnect(R(0, 0), R(30, 30));      // down-right by equal amounts
  assert.equal(c.points.length, 2);
  const dx = c.points[1][0] - c.points[0][0], dy = c.points[1][1] - c.points[0][1];
  assert.equal(Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6, true); // 45 degrees
});

test('dead zone (all projections disjoint) -> two-segment octilinear path', () => {
  // A unit-ish box at origin, B far right + slightly up: 5x,2y offset, small boxes
  const c = octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4));
  assert.equal(c.points.length, 3);               // one bend
  // every leg is octilinear (dx==0, dy==0, or |dx|==|dy|)
  for (let i = 1; i < c.points.length; i++) {
    const dx = Math.abs(c.points[i][0] - c.points[i - 1][0]);
    const dy = Math.abs(c.points[i][1] - c.points[i - 1][1]);
    assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, `leg ${i} octilinear`);
  }
});

test('deterministic: same input -> identical output', () => {
  assert.deepEqual(octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4)),
                   octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4)));
});
