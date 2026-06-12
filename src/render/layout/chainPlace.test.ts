import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaneCurve, curvePoint, curveTangent, rdpSimplify, solveChain,
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

const PITCH = 5.5;
const MINGAP = 2 * 2.45 - 0.05;
const OPTS = { pitch: PITCH, minGap: MINGAP, anchorW: 0.05, linkW: 0.25 };
const through = (pts: Pixel[], anchor: Pixel) => {
  // build a through-curve from one long polyline by splitting at the anchor
  // (test convenience: both "incident sides" derived from one geometry)
  return buildLaneCurve([pts, [...pts].reverse()], anchor, 24);
};

test('P1: parallel lanes yield the exact perpendicular straight row', () => {
  // three horizontal lanes at pitch, anchors staggered in x
  const curves = [
    through([[-60, 0], [60, 0]], [-3, 0]),
    through([[-60, PITCH], [60, PITCH]], [0, PITCH]),
    through([[-60, 2 * PITCH], [60, 2 * PITCH]], [3, 2 * PITCH]),
  ];
  const sol = solveChain(curves, [[0, 1, 2]], OPTS);
  const xs = sol.pos.map((p) => p[0]);
  assert.ok(Math.abs(xs[0] - xs[1]) <= 0.51 && Math.abs(xs[1] - xs[2]) <= 0.51,
    `not perpendicular: ${xs}`);
  for (let k = 1; k < 3; k++) {
    const d = Math.hypot(sol.pos[k][0] - sol.pos[k - 1][0], sol.pos[k][1] - sol.pos[k - 1][1]);
    assert.ok(Math.abs(d - PITCH) < 0.6, `pair dist ${d}`);
  }
});

test('P2/clean-track: chain escapes a kinked region', () => {
  // lane B kinks away at x>0; clean parallel track exists at x<0
  const a = through([[-60, 0], [60, 0]], [6, 0]);
  const b = through([[-60, PITCH], [0, PITCH], [40, PITCH + 40]], [6, PITCH + 6]);
  const sol = solveChain([a, b], [[0, 1]], OPTS);
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(Math.abs(d - PITCH) < 0.8, `gap ${d} — should sit on clean track`);
  assert.ok(sol.pos[1][0] < 1, `lane-B dot at x=${sol.pos[1][0]} — should escape the kink`);
});

test('links pull group ends together (one-sided)', () => {
  // two colinear terminus lanes facing each other with a 20px gap
  const a = buildLaneCurve([[[-10, 0], [-50, 0]]], [-30, 0], 24); // tip at x=-10
  const b = buildLaneCurve([[[10, 0], [50, 0]]], [30, 0], 24);    // tip at x=+10
  const sol = solveChain([a, b], [[0], [1]], OPTS);
  assert.ok(sol.pos[0][0] > -10.6 && sol.pos[1][0] < 10.6,
    `tips not pulled together: ${sol.pos[0][0]}, ${sol.pos[1][0]}`);
});

test('hard floor: crossing lanes never violate min gap', () => {
  const a = through([[-40, -40], [40, 40]], [0, 0]);
  const b = through([[-40, 40], [40, -40]], [0.5, -0.5]);
  const sol = solveChain([a, b], [[0, 1]], OPTS);
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(d >= MINGAP - 1e-6, `floor violated: ${d}`);
});

test('deterministic: identical runs give identical output', () => {
  const curves = [
    through([[-60, 0], [60, 0]], [-3, 0]),
    through([[-60, PITCH], [60, PITCH]], [2, PITCH]),
  ];
  const s1 = solveChain(curves, [[0, 1]], OPTS);
  const s2 = solveChain(curves, [[0, 1]], OPTS);
  assert.deepEqual(s1, s2);
});
