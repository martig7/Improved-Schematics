import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideConvex, rotatedRectCorners, snapAngle } from '../cropFrame';
import type { Coordinate } from '../../types/core';

const square: Coordinate[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];

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
