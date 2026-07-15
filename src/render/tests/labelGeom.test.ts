import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trig, obbFromLocalBox, obbOverlap, segmentIntersectsObb, tilt } from '../labelGeom';
import { boxesOverlap } from '../labels';

const boxObb = (b: { x: number; y: number; w: number; h: number }) =>
  obbFromLocalBox([b.x, b.y], 0, 0, b.w, b.h, 0);

test('trig gives exact literals for the renderable angles', () => {
  assert.deepEqual(trig(0), { c: 1, s: 0 });
  assert.deepEqual(trig(90), { c: 0, s: 1 });
  assert.deepEqual(trig(-90), { c: 0, s: -1 });
  assert.equal(trig(45).c, 0.7071067811865476);
  assert.equal(trig(-45).s, -0.7071067811865476);
});

test('obbOverlap on axis-aligned boxes agrees with boxesOverlap (incl. touching = clear)', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const over = { x: 5, y: 5, w: 10, h: 10 };
  const apart = { x: 20, y: 20, w: 5, h: 5 };
  const touch = { x: 10, y: 0, w: 5, h: 10 };
  for (const b of [over, apart, touch]) {
    assert.equal(obbOverlap(boxObb(a), boxObb(b)), boxesOverlap(a, b));
  }
});

test('a 90-degree box is the flat box with width/height swapped', () => {
  const flatWide = obbFromLocalBox([0, 0], -20, -5, 20, 5, 0); // 40 x 10
  // a small box directly above the flat wide box: the flat (short) version misses it
  const above = obbFromLocalBox([0, -18], -5, -3, 5, 3, 0);
  assert.equal(obbOverlap(flatWide, above), false);
  // rotating the wide box -90 about its center makes it tall (10 x 40) and now reaches up
  const rotated = obbFromLocalBox([0, 0], -20, -5, 20, 5, -90);
  assert.equal(obbOverlap(rotated, above), true);
});

test('segmentIntersectsObb hits a rotated box a flat test would miss', () => {
  const obb = obbFromLocalBox([0, 0], 0, -4, 40, 4, 45); // diagonal band
  assert.equal(segmentIntersectsObb([10, 10], [20, 20], obb), true); // along the diagonal
  assert.equal(segmentIntersectsObb([40, -40], [50, -50], obb), false); // well off it
});

test('tilt: flat free, 45 cheap, 90 a strong last resort', () => {
  assert.equal(tilt(0), 0);
  assert.equal(tilt(45), 4);
  assert.equal(tilt(-45), 4);
  assert.equal(tilt(90), 35);
  assert.equal(tilt(-90), 35);
});
