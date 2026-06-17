import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjection, frameRect, projectedBounds } from './projection';
import type { BoundingBox, Coordinate } from '../types/core';

// Equator-centered bounds keep cos(centerLat) = 1 (k = 1), so the projection
// math is exact and hand-checkable. 1000×1000 canvas, 10% padding → content is
// centered in an 800×800 box (100px margin on every side).
const BOUNDS: BoundingBox = [-5, -5, 5, 5];
const proj = createProjection(BOUNDS, 1000, 1000, 0.1);

// Framing the WHOLE projection bounds yields the inset content rectangle — i.e.
// the projected bbox WITHOUT the padding margin. This is the core promise: fit
// to the demand bbox, not the padded canvas.
test('frameRect of full bounds = the padding-free content rect', () => {
  const f = frameRect(proj, BOUNDS);
  assert.deepEqual(f, { x: 100, y: 100, w: 800, h: 800 });
});

// A sub-bbox (a demand extent smaller than the framing bounds) projects to a
// proportional inner rectangle, centered the same way.
test('frameRect of a centered half-size bbox = the centered inner rect', () => {
  const f = frameRect(proj, [-2.5, -2.5, 2.5, 2.5]);
  assert.deepEqual(f, { x: 300, y: 300, w: 400, h: 400 });
});

// A bbox that projects beyond the canvas is clamped to the drawn area, so the
// frame never reaches into blank space outside the SVG viewport.
test('frameRect clamps a bbox that overflows the canvas', () => {
  const f = frameRect(proj, [-100, -100, 100, 100]);
  assert.deepEqual(f, { x: 0, y: 0, w: 1000, h: 1000 });
});

// projectedBounds frames the EXTENT of an arbitrary point set (e.g. every
// water/green vertex), projecting each point — correct even under a non-axis-
// aligned (warped) projection, unlike frameRect's corner-only assumption.
test('projectedBounds = pixel bbox of the projected points', () => {
  const f = projectedBounds(proj, [
    [-2.5, -2.5],
    [2.5, 2.5],
  ]);
  assert.deepEqual(f, { x: 300, y: 300, w: 400, h: 400 });
});

// The single furthest point dictates each edge of the frame ("furthest water or
// green"): adding a point further east widens the box to reach it.
test('projectedBounds is driven by the furthest point on each axis', () => {
  const f = projectedBounds(proj, [
    [-2.5, -2.5],
    [2.5, 2.5],
    [4, 0],
  ]);
  // [4,0] → x = 100 + 9*80 = 820, so maxX extends from 700 to 820.
  assert.deepEqual(f, { x: 300, y: 300, w: 520, h: 400 });
});

test('projectedBounds clamps to the canvas and returns null for no points', () => {
  assert.deepEqual(projectedBounds(proj, [[-100, -100], [100, 100]]), { x: 0, y: 0, w: 1000, h: 1000 });
  assert.equal(projectedBounds(proj, [] as Coordinate[]), null);
});
