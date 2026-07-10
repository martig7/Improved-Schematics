import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropLaneToBox } from '../laneCrop';

type P = [number, number];

// The square boundary for center [0,0], side 20 is x,y in [-10,10]. Helpers
// below assert a point sits ON that boundary (within float tolerance).
const onBoundary = (p: P, c: P, side: number, tol = 1e-6) => {
  const h = side / 2;
  const dx = Math.abs(Math.abs(p[0] - c[0]) - h);
  const dy = Math.abs(Math.abs(p[1] - c[1]) - h);
  const onVert = dx < tol && Math.abs(p[1] - c[1]) <= h + tol;
  const onHoriz = dy < tol && Math.abs(p[0] - c[0]) <= h + tol;
  return onVert || onHoriz;
};
const inside = (p: P, c: P, side: number, tol = 1e-6) => {
  const h = side / 2;
  return Math.abs(p[0] - c[0]) <= h + tol && Math.abs(p[1] - c[1]) <= h + tol;
};

test('CUT: a lane running through the box starts at the boundary', () => {
  // Node end at [-30,0] outside, running +x straight through the box to [30,0].
  const poly: P[] = [[-30, 0], [30, 0]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  assert.ok(out.length >= 2);
  // First (node-end) vertex now sits on the left wall x=-10.
  assert.deepEqual(out[0], [-10, 0]);
  assert.ok(onBoundary(out[0], [0, 0], 20));
  // The far end past the box is preserved.
  assert.deepEqual(out[out.length - 1], [30, 0]);
});

test('CUT: lane enters box after a bend keeps the outward vertices', () => {
  // Node end at [-30,-30] (outside), bends at [-30,0], then runs +x through box.
  const poly: P[] = [[-30, -30], [-30, 0], [30, 0]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  // First crossing walking from node-end outward is on the left wall at [-10,0].
  assert.deepEqual(out[0], [-10, 0]);
  assert.deepEqual(out[out.length - 1], [30, 0]);
  // The pre-box bend [-30,0] and node end [-30,-30] are dropped.
  assert.equal(out.length, 2);
});

test('NO-EXTEND: a lane that never reaches the box is left unchanged', () => {
  // Node end at [-20,0] (outside), running further away to [-30,0]. It never
  // reaches the box, so the crop leaves it untouched (never fabricates geometry).
  const poly: P[] = [[-20, 0], [-30, 0]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  assert.deepEqual(out, [[-20, 0], [-30, 0]]);
});

test('NO-EXTEND: a short diagonal lane that never reaches the box is unchanged', () => {
  // Diagonal lane pointing away from the box; nothing to cut, nothing extended.
  const poly: P[] = [[-20, -20], [-30, -30]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  assert.deepEqual(out, [[-20, -20], [-30, -30]]);
});

test('inside-start: leading inside vertices are dropped, cut at first exit', () => {
  // Node end at [0,0] INSIDE the box, running +x out through the right wall.
  const poly: P[] = [[0, 0], [30, 0]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  // New node-end is the exit crossing on the right wall x=10.
  assert.deepEqual(out[0], [10, 0]);
  assert.deepEqual(out[out.length - 1], [30, 0]);
});

test('inside-start: an interior bend is dropped up to the exit', () => {
  // Node end [0,0] inside, bends at [5,5] still inside, exits through top y=10.
  const poly: P[] = [[0, 0], [5, 5], [5, 30]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  // Exits the box through the top wall y=10 on the x=5 leg.
  assert.deepEqual(out[0], [5, 10]);
  assert.deepEqual(out[out.length - 1], [5, 30]);
});

test('determinism: identical input yields identical output', () => {
  const poly: P[] = [[-30, -30], [-30, 0], [30, 0]];
  const a = cropLaneToBox(poly, [0, 0], 20);
  const b = cropLaneToBox(poly, [0, 0], 20);
  assert.deepEqual(a, b);
  // input is not mutated
  assert.deepEqual(poly, [[-30, -30], [-30, 0], [30, 0]]);
});

test('determinism: box-edge scan order is fixed (corner crossing picks left wall)', () => {
  // A lane hitting exactly the top-left corner: left is scanned before top,
  // so the crossing resolves on the left wall deterministically.
  const poly: P[] = [[-30, -30], [30, 30]]; // through the box diagonally
  const out = cropLaneToBox(poly, [0, 0], 20);
  // Diagonal enters at the bottom-left corner [-10,-10]; left wall scanned first.
  assert.deepEqual(out[0], [-10, -10]);
});

test('degenerate: a lane with fewer than two points is returned unchanged', () => {
  const poly: P[] = [[5, 5]];
  const out = cropLaneToBox(poly, [0, 0], 20);
  assert.deepEqual(out, [[5, 5]]);
});
