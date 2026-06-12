import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaneCurve, curvePoint, curveTangent, rdpSimplify, solveChain,
  octOff, OCT_TOL, ELBOW_MIN_F,
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
  // also exercises terminus domain clipping: DP states end at the drawn tips
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

test('octOff measures distance to the nearest 45-degree multiple', () => {
  const deg = Math.PI / 180;
  assert.ok(Math.abs(octOff(0)) < 1e-9, `0° → ${octOff(0)}`);
  assert.ok(Math.abs(octOff(22.5 * deg) - 22.5 * deg) < 1e-9, '22.5° → 22.5°');
  assert.ok(Math.abs(octOff(50 * deg) - 5 * deg) < 1e-9, '50° → 5°');
  assert.ok(Math.abs(octOff(-50 * deg) - 5 * deg) < 1e-9, '−50° → 5°');
  assert.ok(Math.abs(octOff(90.5 * deg) - 0.5 * deg) < 1e-9, '90.5° → 0.5°');
});

test('P5: skewed anchors still yield an octilinear row', () => {
  // parallel lanes, anchors deliberately skewed — without the constraint the
  // minimizer may keep small stagger; with it every near pair must be octilinear
  const curves = [
    through([[-60, 0], [60, 0]], [-4, 0]),
    through([[-60, PITCH], [60, PITCH]], [4, PITCH]),
  ];
  const sol = solveChain(curves, [[0, 1]], OPTS);
  const dx = sol.pos[1][0] - sol.pos[0][0];
  const dy = sol.pos[1][1] - sol.pos[0][1];
  const d = Math.hypot(dx, dy);
  if (d < ELBOW_MIN_F * PITCH) {
    assert.ok(octOff(Math.atan2(dy, dx)) <= OCT_TOL + 1e-9,
      `off-axis near pair: ${(octOff(Math.atan2(dy, dx)) * 180 / Math.PI).toFixed(1)}°`);
  }
});

test('P5: a pair that cannot align octilinearly stretches into elbow range', () => {
  // a horizontal lane and a parallel lane offset by (ρ·0.6, ρ): the 0.5px
  // state grids are offset, so the exact perpendicular pair is unreachable.
  // The constraint admits two outcomes only: a near pair within OCT_TOL of a
  // 45° multiple, or a stretch past ELBOW_MIN (rendered as an elbow). Verify
  // the disjunction — which branch wins is the solver's choice.
  const a = through([[-60, 0], [60, 0]], [0, 0]);
  const b = through([[-60 + 0.6 * PITCH, PITCH], [60 + 0.6 * PITCH, PITCH]], [0.6 * PITCH, PITCH]);
  const sol = solveChain([a, b], [[0, 1]], OPTS);
  const dx = sol.pos[1][0] - sol.pos[0][0];
  const dy = sol.pos[1][1] - sol.pos[0][1];
  const d = Math.hypot(dx, dy);
  const ok = (d < ELBOW_MIN_F * PITCH && octOff(Math.atan2(dy, dx)) <= OCT_TOL + 1e-9)
    || d >= ELBOW_MIN_F * PITCH - 1e-9;
  assert.ok(ok, `near AND off-axis: d=${d.toFixed(2)} off=${(octOff(Math.atan2(dy, dx)) * 180 / Math.PI).toFixed(1)}°`);
});

test('P5 degradation: infeasible octilinear chain relaxes, never stacks', () => {
  // two stubby lanes whose EVERY candidate pair is near-pitch (d < 1.5ρ) and
  // 17-22° off-axis: no octilinear chain exists in the window. The solver
  // must fall back to the unconstrained chain (floor holds, dots stay on
  // lanes), NOT to raw anchors — anchors ignore floors and vetoes.
  const a = through([[-0.25, 0], [0.25, 0]], [0, 0]);
  const b = through([[2, PITCH], [2.5, PITCH]], [2.25, PITCH]);
  const sol = solveChain([a, b], [[0, 1]], OPTS);
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(d >= MINGAP - 1e-6, `floor violated in fallback: ${d}`);
  // the relaxed-DP optimum is dx=1.75 (a at x=0.25, b at x=2); the anchor
  // fallback would sit at (0, 2.25) — reaching the optimum proves the
  // relaxed re-solve ran instead of degrading straight to anchors
  assert.ok(Math.abs(sol.pos[0][0] - 0.25) < 0.01 && Math.abs(sol.pos[1][0] - 2) < 0.01,
    `expected relaxed optimum, got x=${sol.pos[0][0]}, ${sol.pos[1][0]}`);
});

test('degradation ladder: blocked-out window falls back to unmasked solve, not anchors', () => {
  // crossing lanes with near-coincident anchors; blocked vetoes EVERY state,
  // so rung 1 (P5 + mask) is infeasible. Rung 2 (mask dropped FIRST, shape +
  // floor kept) must still produce a floored chain. Without the unmasked
  // rungs the anchor fallback stacks the dots ~0.28px apart (verified
  // pre-fix: d=0.2828), so this test discriminates.
  const a = through([[-40, -40], [40, 40]], [0.2, 0.2]);
  const b = through([[-40, 40], [40, -40]], [0, 0]);
  const sol = solveChain([a, b], [[0, 1]], { ...OPTS, blocked: () => true });
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(d >= MINGAP - 1e-6, `floor violated after ladder: ${d}`);
  assert.ok(!sol.degraded, 'unmasked rungs should solve — not the anchor fallback');
});

test('fully masked window degrades to unmasked chain, not stacked anchors', () => {
  // COINCIDENT lanes, identical anchors: the anchor fallback would stack
  // both dots at distance 0. blocked vetoes everything, so the masked rungs
  // are infeasible; the unmasked rungs must separate the dots along the
  // shared line to >= minGap (mn32-class mask starvation, spec §6).
  const curves = [
    through([[-60, 0], [60, 0]], [0, 0]),
    through([[-60, 0], [60, 0]], [0, 0]),
  ];
  const sol = solveChain(curves, [[0, 1]], { ...OPTS, blocked: () => true });
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(d >= MINGAP - 1e-6, `mask starvation must not stack dots: d=${d}`);
  assert.ok(!sol.degraded, 'unmasked rung should solve — not the anchor fallback');
});

test('hardBlocked survives every degradation rung', () => {
  // §6 mask blankets everything (forces unmasked rungs); hardBlocked vetoes
  // a disc around the anchors — the solve must place AWAY from it, proving
  // repair vetoes are honored even after the mask is dropped
  const curves = [
    through([[-60, 0], [60, 0]], [0, 0]),
    through([[-60, PITCH], [60, PITCH]], [0, PITCH]),
  ];
  const sol = solveChain(curves, [[0, 1]], {
    ...OPTS,
    blocked: () => true,
    hardBlocked: (p) => Math.hypot(p[0], p[1]) < 8,
  });
  assert.ok(Math.hypot(sol.pos[0][0], sol.pos[0][1]) >= 8 - 1e-6,
    `dot 0 inside hard veto: ${sol.pos[0]}`);
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(d >= MINGAP - 1e-6, 'floor must hold');
});
