import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaneCurve, curvePoint, curveTangent, rdpSimplify, octOff,
} from './chainPlace';
import type { Pixel } from './types';

test('buildLaneCurve chains two incident sides through the node', () => {
  // both sides oriented AWAY from the node at (0,0): east and west
  const east: Pixel[] = [[0, 0], [50, 0]];
  const west: Pixel[] = [[0, 0], [-50, 0]];
  const c = buildLaneCurve([east, west], [0, 0], 24);
  const total = c.cum[c.cum.length - 1];
  assert.ok(Math.abs(total - 48) < 0.01);          // windowed to ±24
  assert.ok(Math.abs(c.anchorT - 24) < 0.01);      // anchor mid-curve
  const p = curvePoint(c, c.anchorT);
  assert.ok(Math.hypot(p[0], p[1]) < 0.01);        // anchor point = node
});

test('buildLaneCurve terminus (one side) ends at the node', () => {
  const only: Pixel[] = [[0, 0], [50, 0]];
  const c = buildLaneCurve([only], [0, 0], 24);
  const total = c.cum[c.cum.length - 1];
  assert.ok(Math.abs(total - 24) < 0.01);          // one side, windowed
  assert.ok(Math.abs(c.anchorT - total) < 0.01);   // anchor at the tip end
});

test('curvePoint clamps and interpolates', () => {
  const c = buildLaneCurve([[[0, 0], [10, 0]], [[0, 0], [-10, 0]]], [0, 0], 24);
  assert.deepEqual(curvePoint(c, -5), curvePoint(c, 0));
  const mid = curvePoint(c, c.anchorT + 5);
  assert.ok(Math.abs(mid[0] - 5) < 0.01 && Math.abs(mid[1]) < 0.01);
});

test('curveTangent is unit and follows the polyline', () => {
  const c = buildLaneCurve([[[0, 0], [0, 30]], [[0, 0], [0, -30]]], [0, 0], 24);
  const tg = curveTangent(c, c.anchorT);
  assert.ok(Math.abs(Math.abs(tg[1]) - 1) < 1e-6 && Math.abs(tg[0]) < 1e-6);
});

test('curveTangent skips a degenerate sub-pixel micro-segment', () => {
  // a vertical lane with an 8e-6 px horizontal jog at the anchored vertex —
  // join-bridge/clip noise that must NOT read as a horizontal tangent (this
  // was boxing Central Park: the noise tangent corrupted group ordering)
  const c = {
    pts: [[10, 0], [10, 8], [10.000008, 8], [10, 16]] as Pixel[],
    cum: [0, 8, 8.000008, 16.000008],
    anchorT: 8,
  };
  const tg = curveTangent(c, c.anchorT);
  assert.ok(Math.abs(tg[0]) < 0.01 && Math.abs(Math.abs(tg[1]) - 1) < 0.01,
    `tangent should be vertical, got ${tg}`);
});

test('rdpSimplify collapses near-collinear chains, keeps corners', () => {
  const wiggle: Pixel[] = [[0, 0], [5, 0.3], [10, -0.2], [15, 0.1], [20, 0]];
  assert.equal(rdpSimplify(wiggle, 0.75).length, 2);
  const corner: Pixel[] = [[0, 0], [10, 0], [10, 10]];
  assert.equal(rdpSimplify(corner, 0.75).length, 3);
});

test('buildLaneCurve degenerate empty incident list returns valid curve', () => {
  const c = buildLaneCurve([], [3, 7], 24);
  assert.ok(c.pts.length >= 2);
  assert.ok(c.cum.length === c.pts.length);
  assert.ok(isFinite(c.anchorT) && c.anchorT >= 0);
  const p = curvePoint(c, c.anchorT);
  // synthetic curve: point is at or very near the anchor
  assert.ok(Math.hypot(p[0] - 3, p[1] - 7) < 0.01);
});

test('octOff measures distance to the nearest 45-degree multiple', () => {
  const deg = Math.PI / 180;
  assert.ok(Math.abs(octOff(0)) < 1e-9, `0° → ${octOff(0)}`);
  assert.ok(Math.abs(octOff(22.5 * deg) - 22.5 * deg) < 1e-9, '22.5° → 22.5°');
  assert.ok(Math.abs(octOff(50 * deg) - 5 * deg) < 1e-9, '50° → 5°');
  assert.ok(Math.abs(octOff(-50 * deg) - 5 * deg) < 1e-9, '−50° → 5°');
  assert.ok(Math.abs(octOff(90.5 * deg) - 0.5 * deg) < 1e-9, '90.5° → 0.5°');
});
