import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneSeat, type LaneItem } from '../laneSeat';
import type { LaneCurve } from '../chainPlace';

const BOX = 10;
const GAP = 1.4;
const PAD = BOX * 0.16;

// Straight horizontal lane through y=cy spanning x in [x0, x1]; anchor at x=ax.
const hLane = (cy: number, ax: number, x0 = -200, x1 = 200): LaneCurve => ({
  pts: [[x0, cy], [x1, cy]],
  cum: [0, x1 - x0],
  anchorT: ax - x0,
});

const item = (lineId: string, curve: LaneCurve): LaneItem => ({ lineId, curve, t0: curve.anchorT });

// Every group rect must hug its member boxes exactly: bbox of the member centers
// grown by BOX/2 + PAD on all four sides. Members are assigned to the group
// containing their center (groups are non-overlapping by construction).
function assertFlush(out: ReturnType<typeof laneSeat>): void {
  const centers = [...out.centers.values()];
  for (const g of out.groups) {
    const members = centers.filter(
      (c) => c[0] >= g.x && c[0] <= g.x + g.w && c[1] >= g.y && c[1] <= g.y + g.h,
    );
    assert.ok(members.length > 0, 'every capsule contains at least one box');
    const minX = Math.min(...members.map((c) => c[0]));
    const maxX = Math.max(...members.map((c) => c[0]));
    const minY = Math.min(...members.map((c) => c[1]));
    const maxY = Math.max(...members.map((c) => c[1]));
    const h = BOX / 2 + PAD;
    assert.ok(Math.abs(g.x - (minX - h)) < 1e-6, 'flush left');
    assert.ok(Math.abs(g.y - (minY - h)) < 1e-6, 'flush top');
    assert.ok(Math.abs(g.x + g.w - (maxX + h)) < 1e-6, 'flush right');
    assert.ok(Math.abs(g.y + g.h - (maxY + h)) < 1e-6, 'flush bottom');
  }
  // total membership covers every box exactly once (groups do not overlap)
  const covered = out.groups.reduce((s, g) => s +
    centers.filter((c) => c[0] >= g.x && c[0] <= g.x + g.w && c[1] >= g.y && c[1] <= g.y + g.h).length, 0);
  assert.equal(covered, centers.length, 'each box lies in exactly one capsule');
}

function assertNoBoxOverlap(out: ReturnType<typeof laneSeat>): void {
  const c = [...out.centers.values()];
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      const ox = Math.abs(c[i][0] - c[j][0]);
      const oy = Math.abs(c[i][1] - c[j][1]);
      assert.ok(ox >= BOX - 1e-6 || oy >= BOX - 1e-6, `boxes ${i},${j} overlap`);
    }
  }
}

test('parallel trunk lanes merge into ONE flush packed row (float off lane)', () => {
  // Two horizontal lanes offset by 0.75*BOX cross, anchors 12 apart along (past
  // the overlap clearance, within the cluster radius), so the per-lane deconflict
  // leaves them separated and banding snaps them into a single row: shared y
  // (the mean), packed at exact pitch.
  const out = laneSeat([item('A', hLane(0, 0)), item('B', hLane(7.5, 12))], BOX, GAP);
  assert.equal(out.groups.length, 1);
  const ys = [...out.centers.values()].map((c) => c[1]);
  assert.ok(Math.abs(ys[0] - ys[1]) < 1e-6, 'snapped to one cross coordinate');
  assert.ok(Math.abs(out.groups[0].h - (BOX + 2 * PAD)) < 1e-6, 'capsule height hugs the row');
  assertFlush(out);
  assertNoBoxOverlap(out);
});

test('nearby crossing boxes MERGE into one row within the float cap', () => {
  // Offset by 12 on both axes: merging into one row floats each box 6px off its
  // lane, within the cap, so the station renders ONE capsule and no connector.
  const out = laneSeat([item('A', hLane(0, 0)), item('B', hLane(12, 12))], BOX, GAP);
  assert.equal(out.groups.length, 1, 'merged into a single capsule');
  assert.equal(out.connectors.length, 0);
  assertFlush(out);
  assertNoBoxOverlap(out);
});

test('far-offset boxes SPLIT into flush parts joined by a connector', () => {
  // Offset by 26 on both axes: a merged row would float each box ~13px off its
  // lane, beyond the cap, so two flush singleton capsules with one connector.
  const out = laneSeat([item('A', hLane(0, 0)), item('B', hLane(26, 26))], BOX, GAP);
  assert.equal(out.groups.length, 2);
  assert.equal(out.connectors.length, 1);
  for (const g of out.groups) {
    assert.ok(Math.abs(g.w - (BOX + 2 * PAD)) < 1e-6, 'singleton capsule width flush');
    assert.ok(Math.abs(g.h - (BOX + 2 * PAD)) < 1e-6, 'singleton capsule height flush');
  }
  assertFlush(out);
});

test('coincident anchors on parallel lanes deconflict then stay flush', () => {
  // Same along anchor on three parallel lanes: the per-lane deconflict must
  // slide them apart, and whatever parts result must be flush with no box
  // overlap.
  const out = laneSeat(
    [item('A', hLane(0, 0)), item('B', hLane(7.5, 0)), item('C', hLane(15, 0))],
    BOX, GAP,
  );
  assertFlush(out);
  assertNoBoxOverlap(out);
});

test('merged row centers EXACTLY on crossing lanes, terminus tip included', () => {
  // Lane A: slope +1 through the origin. Lane B: slope -1 through (0, 20),
  // ending at a TERMINUS tip at (6, 14) just past the junction. A merged
  // vertical column has an exact both-on-line solution (x = (20 - pitch) / 2),
  // and B's solution point lies on its drawn extent. The centering must find
  // it even though B's nearest-point foot CLAMPS at the tip early in the
  // iteration (the radial residual, not a segment-normal phantom).
  const laneA: LaneCurve = {
    pts: [[-200, -200], [200, 200]],
    cum: [0, Math.sqrt(2) * 400],
    anchorT: Math.sqrt(2) * 400 * (216 / 400), // anchor at (16, 16)
  };
  const lenB = Math.sqrt(2) * 36; // from (-30, 50) to the tip (6, 14)
  const laneB: LaneCurve = {
    pts: [[-30, 50], [6, 14]],
    cum: [0, lenB],
    anchorT: lenB, // anchor at the tip
  };
  const out = laneSeat(
    [{ lineId: 'A', curve: laneA, t0: laneA.anchorT }, { lineId: 'B', curve: laneB, t0: laneB.anchorT }],
    BOX, GAP,
  );
  assert.equal(out.groups.length, 1, 'merged into one capsule');
  const segDist = (p: [number, number], pts: Array<[number, number]>): number => {
    let best = Infinity;
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1][0], ay = pts[k - 1][1];
      const dx = pts[k][0] - ax, dy = pts[k][1] - ay;
      const l2 = dx * dx + dy * dy;
      const u = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(p[0] - (ax + dx * u), p[1] - (ay + dy * u)));
    }
    return best;
  };
  const a = out.centers.get('A')!;
  const b = out.centers.get('B')!;
  assert.ok(segDist([a[0], a[1]], laneA.pts as Array<[number, number]>) < 0.2, 'A box centered on its lane');
  assert.ok(segDist([b[0], b[1]], laneB.pts as Array<[number, number]>) < 0.2, 'B box centered on its lane');
});

test('terminus column stays at its route ends beside a slightly tilted through lane', () => {
  // Two lanes END at x=100 (anchors at the tip) and one nearly parallel lane
  // runs through with a slight tilt. The perpendicular residuals barely
  // determine the along direction here, so an exact normal-equation solve
  // would trade a large along-lane drift for a marginal perpendicular gain
  // and drag the merged column far off the route ends. The anchor pull must
  // hold the column at the ends.
  const tilted: LaneCurve = {
    pts: [[-100, -8], [300, 8]],
    cum: [0, Math.sqrt(400 * 400 + 16 * 16)],
    anchorT: Math.sqrt(200 * 200 + 8 * 8), // anchor near (100, 0)
  };
  const out = laneSeat(
    [
      { lineId: 'T', curve: tilted, t0: tilted.anchorT },
      item('A', hLane(6, 100, -100, 100)),   // terminus: anchor at the lane end
      item('B', hLane(12, 100, -100, 100)),  // terminus: anchor at the lane end
    ],
    BOX, GAP,
  );
  for (const [id, c] of out.centers) {
    assert.ok(Math.abs(c[0] - 100) < 3, `${id} drifted along its lane: x=${c[0].toFixed(1)}`);
  }
  assertNoBoxOverlap(out);
});

test('deterministic: identical input yields identical output', () => {
  const mk = () => [item('A', hLane(0, 0)), item('B', hLane(7.5, 0)), item('C', hLane(15, 6))];
  const a = laneSeat(mk(), BOX, GAP);
  const b = laneSeat(mk(), BOX, GAP);
  assert.deepEqual(
    { c: [...a.centers], g: a.groups, k: a.connectors },
    { c: [...b.centers], g: b.groups, k: b.connectors },
  );
});
