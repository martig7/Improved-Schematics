import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestInscribedRect, insideConvex, rotatedRectCorners, snapAngle } from '../cropFrame';
import type { Coordinate } from '../../types/core';

const square: Coordinate[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];

/** The unit square turned by `deg`, which is the shape a rotated harvest rect
 *  presents in the render frame. */
const turned = (deg: number, r = 10): Coordinate[] => {
  const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  return ([[-r, -r], [r, -r], [r, r], [-r, r]] as Coordinate[])
    .map(([x, y]) => [x * c - y * s, x * s + y * c] as Coordinate);
};

test('an upright square inscribes itself', () => {
  const r = largestInscribedRect(square, 1);
  assert.ok(r);
  for (const v of r) assert.ok(Math.abs(Math.abs(v) - 10) < 1e-6, `got ${v}`);
});

test('a turned square inscribes a strictly smaller upright square', () => {
  const r = largestInscribedRect(turned(23), 1);
  assert.ok(r);
  const half = (r[2] - r[0]) / 2;
  // Half-width of the largest upright square in a square turned by t is
  // r / (|cos t| + |sin t|).
  const rad = (23 * Math.PI) / 180;
  const want = 10 / (Math.cos(rad) + Math.sin(rad));
  assert.ok(Math.abs(half - want) < 1e-3, `half ${half} want ${want}`);
  assert.ok(half < 10, 'must be a real trim');
});

test('every corner of the result lies inside the hull', () => {
  for (const deg of [0, 10, 23, 45, 60, 90]) {
    const hull = turned(deg);
    const r = largestInscribedRect(hull, 16 / 9);
    assert.ok(r, `deg ${deg}`);
    for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]) {
      assert.ok(insideConvex(hull, x, y), `deg ${deg} corner ${x},${y}`);
    }
  }
});

test('the aspect is honoured, in metric units', () => {
  const r = largestInscribedRect(turned(23), 16 / 9, 0.75);
  assert.ok(r);
  const got = ((r[2] - r[0]) * 0.75) / (r[3] - r[1]);
  assert.ok(Math.abs(got - 16 / 9) < 1e-6, `aspect ${got}`);
});

test('a wider aspect inscribes less height than a square one', () => {
  const a = largestInscribedRect(turned(23), 1);
  const b = largestInscribedRect(turned(23), 16 / 9);
  assert.ok(a && b);
  assert.ok(b[3] - b[1] < a[3] - a[1]);
});

test('degenerate rings yield nothing', () => {
  assert.equal(largestInscribedRect([[0, 0], [1, 1]] as Coordinate[], 1), null);
  assert.equal(largestInscribedRect(square, 0), null);
});

test('the solver is deterministic', () => {
  const a = largestInscribedRect(turned(23), 16 / 9, 0.75);
  const b = largestInscribedRect(turned(23), 16 / 9, 0.75);
  assert.deepEqual(a, b);
});

test('insideConvex reads either winding', () => {
  const ccw = [...square].reverse();
  for (const ring of [square, ccw]) {
    assert.ok(insideConvex(ring, 0, 0));
    assert.ok(insideConvex(ring, 10, 10), 'a vertex counts as inside');
    assert.ok(!insideConvex(ring, 11, 0));
  }
});

test('rotatedRectCorners turns about the centre', () => {
  const c = rotatedRectCorners(5, 5, 2, 1, Math.PI / 2);
  // A quarter turn swaps the axes: the top-left corner (-2, -1) lands at (+1, -2).
  assert.ok(Math.abs(c[0][0] - 6) < 1e-9 && Math.abs(c[0][1] - 3) < 1e-9, JSON.stringify(c[0]));
  let sx = 0, sy = 0;
  for (const p of c) { sx += p[0]; sy += p[1]; }
  assert.ok(Math.abs(sx / 4 - 5) < 1e-9 && Math.abs(sy / 4 - 5) < 1e-9, 'centre preserved');
});

test('snapAngle catches the octilinear axes and any extra target', () => {
  assert.equal(snapAngle(2), 0);
  assert.equal(snapAngle(43.5), 45);
  assert.equal(snapAngle(20, [23]), 23, 'the city bearing is a target too');
  assert.equal(snapAngle(30, [23]), 30, 'outside the tolerance, untouched');
});

test('snapAngle crosses the wrap without jumping a turn', () => {
  assert.equal(snapAngle(359), 360, 'stays adjacent to the input, not 0');
  assert.equal(snapAngle(-1), 0);
  assert.equal(snapAngle(722, [], 4), 720);
});
