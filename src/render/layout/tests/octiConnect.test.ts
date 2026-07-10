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

test('both axes disjoint -> single straight corner-to-corner segment facing B', () => {
  // A box at origin, B far right + down: offset on both axes -> a diagonal
  // connector from A's facing corner to B's facing corner (no L-bend).
  const A = R(0, 0, 4, 4), B = R(50, 20, 4, 4);
  const c = octiConnect(A, B);
  assert.equal(c.points.length, 2);               // one straight segment
  assert.deepEqual(c.points[0], [4, 4]);           // A's bottom-right corner (toward B)
  assert.deepEqual(c.points[1], [50, 20]);         // B's top-left corner (toward A)
});

test('deterministic: same input -> identical output', () => {
  assert.deepEqual(octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4)),
                   octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4)));
});

// A point is strictly interior to a rect iff it lies inside on BOTH axes
// (touching the boundary does not count).
const strictlyInside = (p: number[], r: { x: number; y: number; w: number; h: number }, eps = 1e-6) =>
  p[0] > r.x + eps && p[0] < r.x + r.w - eps && p[1] > r.y + eps && p[1] < r.y + r.h - eps;

const onBoundary = (p: number[], r: { x: number; y: number; w: number; h: number }, eps = 1e-6) => {
  const onX = Math.abs(p[0] - r.x) < eps || Math.abs(p[0] - (r.x + r.w)) < eps;
  const onY = Math.abs(p[1] - r.y) < eps || Math.abs(p[1] - (r.y + r.h)) < eps;
  const inX = p[0] > r.x - eps && p[0] < r.x + r.w + eps;
  const inY = p[1] > r.y - eps && p[1] < r.y + r.h + eps;
  return (onX && inY) || (onY && inX);
};

test('offset-both-axes connector lands on the facing corner of each rect', () => {
  const A = R(0, 0, 20, 4), B = R(30, 30, 4, 20);
  const c = octiConnect(A, B);
  assert.equal(c.points.length, 2);
  const [p0, p1] = c.points;
  // The true facing direction (not forced to 45): A's bottom-right corner to
  // B's top-left corner.
  assert.deepEqual(p0, [20, 4]);
  assert.deepEqual(p1, [30, 30]);
  assert.ok(onBoundary(p0, A), 'p0 on boundary of A');
  assert.ok(onBoundary(p1, B), 'p1 on boundary of B');
});

test('touching rects -> no point strictly interior to either rect', () => {
  const A = R(0, 0, 10, 10), B = R(10, 0, 10, 10);
  const c = octiConnect(A, B);
  for (const p of c.points) {
    assert.ok(!strictlyInside(p, A), `point ${p} inside A`);
    assert.ok(!strictlyInside(p, B), `point ${p} inside B`);
  }
});

test('identical rects -> no point strictly interior to either rect', () => {
  const A = R(0, 0, 10, 10), B = R(0, 0, 10, 10);
  const c = octiConnect(A, B);
  for (const p of c.points) {
    assert.ok(!strictlyInside(p, A), `point ${p} inside A`);
    assert.ok(!strictlyInside(p, B), `point ${p} inside B`);
  }
});
