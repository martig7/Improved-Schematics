import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaneCurve } from './chainPlace';
import { solveRows } from './rowPlace';
import type { Pixel } from './types';

const PITCH = 5.5;
const MINGAP = 2 * 2.45 - 0.05;
const OPTS = { minGap: MINGAP, arcLimit: 24, extCap: 6 * PITCH };

// build a through-curve from one long polyline (same pattern as
// chainPlace.test.ts: both incident sides derived from one geometry)
const through = (pts: Pixel[], anchor: Pixel) =>
  buildLaneCurve([pts, [...pts].reverse()], anchor, 24);
// horizontal lane at height y, stop anchor at (anchorX, y)
const lane = (y: number, anchorX: number) => through([[-60, y], [60, y]], [anchorX, y]);

test('perpendicular rest: parallel lanes give a zero-slide, zero-rotation row', () => {
  // three horizontal lanes at pitch, anchors staggered ±3px: the rest axis is
  // vertical (perpendicular snap) and s=0 is feasible, so the optimum is the
  // unslid perpendicular row through the carrier anchor
  const curves = [lane(0, -3), lane(PITCH, 0), lane(2 * PITCH, 3)];
  const sol = solveRows(curves, [[0, 1, 2]], OPTS);
  assert.ok(sol, 'rest row must be feasible');
  const xs = sol.pos.map((p) => p[0]);
  assert.ok(Math.abs(xs[0] - xs[1]) <= 0.51 && Math.abs(xs[1] - xs[2]) <= 0.51,
    `dots not vertical: ${xs}`);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(sol.pos[k][1] - k * PITCH) < 0.01, `dot off its lane: ${sol.pos[k]}`);
  }
  // zero rotation: a 45°-rotated row would cross pitch-spaced lanes at
  // pitch/sin45 ≈ 7.78 — gaps ≈ pitch prove the perpendicular rest pose
  for (let k = 1; k < 3; k++) {
    const d = Math.hypot(sol.pos[k][0] - sol.pos[k - 1][0], sol.pos[k][1] - sol.pos[k - 1][1]);
    assert.ok(Math.abs(d - PITCH) < 0.6, `pair gap ${d} — row is rotated`);
  }
  assert.equal(sol.cornerAfter.size, 0);
  assert.ok(sol.cost <= 0.05 + 1e-9, `rest solve should cost ~0: ${sol.cost}`);
});

test('OCTI_PLACE_DEBUG classifies a pinched box (lanes seated below minGap)', () => {
  // two horizontal lanes only 2px apart (< minGap 4.85): every vertical/45° row
  // crosses them below the floor and the horizontal row misses the far lane, so
  // the bundle has zero feasible states → mega box. The classifier must report
  // PINCHED (fixable upstream), not NO-CROSSING or MASKED.
  const curves = [lane(0, 0), lane(2, 0)];
  const prev = process.env.OCTI_PLACE_DEBUG;
  process.env.OCTI_PLACE_DEBUG = '1';
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  let sol;
  try {
    sol = solveRows(curves, [[0, 1]], { ...OPTS, dbgLabel: 'TESTNODE' });
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.OCTI_PLACE_DEBUG;
    else process.env.OCTI_PLACE_DEBUG = prev;
  }
  assert.equal(sol, null, 'pinched bundle must box (null)');
  const box = logs.find((l) => /\[rowPlace\] BOX TESTNODE/.test(l));
  assert.ok(box, 'classifier logged a BOX line; got: ' + JSON.stringify(logs));
  assert.match(box!, /PINCHED/, 'classified PINCHED; got: ' + box);
});

test('V-not-T: corner extends beyond both rows, never pokes a side', () => {
  // two bundles meeting at 90°: horizontal lanes (row vertical) + vertical
  // lanes (row horizontal); anchors offset so the natural corner lies beyond
  // both rows' facing ends
  const curves = [
    through([[-60, 0], [60, 0]], [-15, 0]),
    through([[-60, PITCH], [60, PITCH]], [-15, PITCH]),
    through([[0, -60], [0, 60]], [0, -15]),
    through([[PITCH, -60], [PITCH, 60]], [PITCH, -15]),
  ];
  const sol = solveRows(curves, [[0, 1], [2, 3]], OPTS);
  assert.ok(sol, 'V configuration must be feasible');
  assert.equal(sol.cornerAfter.size, 1);
  const [k, corner] = [...sol.cornerAfter.entries()][0];
  const r1 = sol.order.slice(0, k + 1);
  const r2 = sol.order.slice(k + 1);
  assert.equal(r1.length, 2);
  assert.equal(r2.length, 2);
  const unit = (v: Pixel): Pixel => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  // row 1: facing end = last dot before the corner; outward = away from row body
  const e1 = sol.pos[r1[1]];
  const o1 = unit([e1[0] - sol.pos[r1[0]][0], e1[1] - sol.pos[r1[0]][1]]);
  const d1 = (corner[0] - e1[0]) * o1[0] + (corner[1] - e1[1]) * o1[1];
  assert.ok(d1 > 1, `corner does not extend row 1 (dot ${d1})`);
  // row 2: facing end = first dot after the corner
  const e2 = sol.pos[r2[0]];
  const o2 = unit([e2[0] - sol.pos[r2[1]][0], e2[1] - sol.pos[r2[1]][1]]);
  const d2 = (corner[0] - e2[0]) * o2[0] + (corner[1] - e2[1]) * o2[1];
  assert.ok(d2 > 1, `corner does not extend row 2 (dot ${d2})`);
});

test('45-degree pair: cross-row dot floor holds at pair level (no false mega)', () => {
  // vertical rest row (horizontal lanes) meets a 135° rest row (45° lanes) at
  // a 45° corner. Minimizing extension alone pulls the facing ends to
  // ext≈minGap each, where the facing DOTS sit ~0.77*minGap apart — closer
  // than the floor while the corner still clears both. The pair-level
  // cross-row dot floor must veto those states so the DP lands on a slid-out
  // feasible configuration instead of nulling at the station post-check
  // (review finding: spurious mega fallbacks on every multi-bundle save)
  const H = PITCH / Math.SQRT2; // perpendicular pitch projected onto 45° lanes
  const curves = [
    lane(0, 0),
    lane(PITCH, 0),
    through([[12 - 50, -50], [12 + 50, 50]], [12, 0]),
    through([[12 - H - 50, H - 50], [12 - H + 50, H + 50]], [12 - H, H]),
  ];
  const sol = solveRows(curves, [[0, 1], [2, 3]], OPTS);
  assert.ok(sol, 'a feasible configuration exists — must not signal mega');
  assert.equal(sol.cornerAfter.size, 1);
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = Math.hypot(sol.pos[i][0] - sol.pos[j][0], sol.pos[i][1] - sol.pos[j][1]);
      assert.ok(d >= MINGAP - 1e-6, `dot floor violated across rows: ${i}-${j} at ${d}`);
    }
  }
});

test('parallel-collinear: same-line bundles join end-to-end at the gap midpoint', () => {
  // two single-lane bundles on the SAME horizontal line, anchors 20px apart.
  // arcLimit/extCap pinched so the collinear join is the only feasible
  // pairing: with free sliding a rotated chevron (45/135) or L (90/135)
  // undercuts the join on rot economics — those need ext > 10 here
  const a = through([[-60, 0], [60, 0]], [-10, 0]);
  const b = through([[-60, 0], [60, 0]], [10, 0]);
  const sol = solveRows([a, b], [[0], [1]], { minGap: MINGAP, arcLimit: 2, extCap: 10 });
  assert.ok(sol, 'collinear join must be feasible');
  assert.equal(sol.cornerAfter.size, 1);
  const corner = sol.cornerAfter.get(0)!;
  const p0 = sol.pos[0];
  const p1 = sol.pos[1];
  assert.ok(Math.abs(p0[1]) < 0.01 && Math.abs(p1[1]) < 0.01, 'dots stay on the shared line');
  assert.ok(
    Math.abs(corner[0] - (p0[0] + p1[0]) / 2) < 0.01 && Math.abs(corner[1]) < 0.01,
    `corner not at the facing-end midpoint: ${corner}`,
  );
  const e0 = Math.hypot(corner[0] - p0[0], corner[1] - p0[1]);
  const e1 = Math.hypot(corner[0] - p1[0], corner[1] - p1[1]);
  assert.ok(e0 <= 10 + 1e-9 && e1 <= 10 + 1e-9, `ext > 10: ${e0}, ${e1}`);
});

test('coincident lanes admit no configuration: null (mega signal)', () => {
  // identical 4px-long lanes: every reachable cross-bundle dot pair is closer
  // than minGap, so no pairing/orientation is feasible — the caller megas
  const a = through([[-2, 0], [2, 0]], [0, 0]);
  const b = through([[-2, 0], [2, 0]], [0, 0]);
  assert.equal(solveRows([a, b], [[0], [1]], OPTS), null);
});

test('blocked mask forces a slide off the rest position, never a violation', () => {
  // rest row sits at x=0; the mask vetoes |x|<3, so the solver must slide —
  // dots end up outside the band with floors intact (mask never dropped)
  const curves = [lane(0, 0), lane(PITCH, 0), lane(2 * PITCH, 0)];
  const blocked = (p: Pixel) => Math.abs(p[0]) < 3;
  const sol = solveRows(curves, [[0, 1, 2]], { ...OPTS, blocked });
  assert.ok(sol, 'a slid row must be feasible');
  for (const p of sol.pos) assert.ok(!blocked(p), `dot inside the masked band: ${p}`);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(sol.pos[k][1] - k * PITCH) < 0.01, `dot off its lane: ${sol.pos[k]}`);
  }
  for (let k = 1; k < 3; k++) {
    const d = Math.hypot(sol.pos[k][0] - sol.pos[k - 1][0], sol.pos[k][1] - sol.pos[k - 1][1]);
    assert.ok(d >= MINGAP - 1e-6, `floor violated: ${d}`);
  }
});

test('deterministic: identical runs give identical output', () => {
  const mk = () => [
    through([[-60, 0], [60, 0]], [-15, 0]),
    through([[-60, PITCH], [60, PITCH]], [-15, PITCH]),
    through([[0, -60], [0, 60]], [0, -15]),
    through([[PITCH, -60], [PITCH, 60]], [PITCH, -15]),
  ];
  const s1 = solveRows(mk(), [[0, 1], [2, 3]], OPTS);
  const s2 = solveRows(mk(), [[0, 1], [2, 3]], OPTS);
  assert.deepEqual(s1, s2);
});
