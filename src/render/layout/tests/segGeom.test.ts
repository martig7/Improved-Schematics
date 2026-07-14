import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestPointOnSegment, segmentIntersection, segmentsClosest, segmentAngle, polylinesClosest } from '../segGeom';
import type { Pixel } from '../types';

const near = (a: Pixel, b: Pixel, tol = 1e-6) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

test('closestPointOnSegment projects and clamps to the endpoints', () => {
  assert.ok(near(closestPointOnSegment([5, 4], [0, 0], [10, 0]), [5, 0]));
  assert.ok(near(closestPointOnSegment([-5, 4], [0, 0], [10, 0]), [0, 0]), 'clamps before start');
  assert.ok(near(closestPointOnSegment([15, 4], [0, 0], [10, 0]), [10, 0]), 'clamps past end');
});

test('segmentIntersection returns the crossing point, or null when they do not cross', () => {
  assert.ok(near(segmentIntersection([-5, 0], [5, 0], [0, -5], [0, 5])!, [0, 0]));
  assert.equal(segmentIntersection([0, 0], [10, 0], [0, 2], [10, 2]), null, 'parallel');
  assert.equal(segmentIntersection([0, 0], [4, 0], [6, -5], [6, 5]), null, 'lines cross but segments do not reach');
});

test('segmentsClosest: gap 0 at a true crossing, else the perpendicular gap', () => {
  assert.equal(segmentsClosest([-5, 0], [5, 0], [0, -5], [0, 5]).gap, 0);
  const par = segmentsClosest([0, 0], [10, 0], [0, 3], [10, 3]);
  assert.ok(Math.abs(par.gap - 3) < 1e-6, 'parallel offset gap');
});

test('segmentAngle is pi/2 for perpendicular, ~0 for parallel (direction-agnostic)', () => {
  assert.ok(Math.abs(segmentAngle([0, 0], [1, 0], [0, 0], [0, 1]) - Math.PI / 2) < 1e-9);
  assert.ok(segmentAngle([0, 0], [1, 0], [5, 5], [-5, 5]) < 1e-9, 'antiparallel reads as 0');
});

test('polylinesClosest finds the least-gap segment pair with its angle', () => {
  const A: Pixel[][] = [[[-10, 0], [10, 0]]];
  const B: Pixel[][] = [[[0, -10], [0, 10]]];
  const r = polylinesClosest(A, B)!;
  assert.equal(r.gap, 0);
  assert.ok(near(r.mid, [0, 0]));
  assert.ok(Math.abs(r.angle - Math.PI / 2) < 1e-9);
  assert.equal(polylinesClosest([], B), null);
});
