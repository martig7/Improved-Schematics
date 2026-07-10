import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectSeat } from '../rectSeat';

const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

test('two horizontally-aligned members -> one row, one group, no connector', () => {
  const out = rectSeat(
    [{ lineId: 'A', home: [0, 0], axis: 0 }, { lineId: 'B', home: [40, 0], axis: 0 }],
    30, 4,
  );
  assert.equal(out.groups.length, 1);
  assert.equal(out.connectors.length, 0);
  const a = out.centers.get('A')!, b = out.centers.get('B')!;
  assert.ok(near(a[1], b[1]));                 // same y (one horizontal row)
  assert.ok(near(Math.abs(b[0] - a[0]), 34));  // pitch = box+gap
});

test('members split into two rows are joined by exactly one connector', () => {
  // three tight left + one far up-right -> a split is cheaper than one long row
  const out = rectSeat([
    { lineId: 'A', home: [0, 0], axis: 0 },
    { lineId: 'B', home: [34, 0], axis: 0 },
    { lineId: 'C', home: [68, 0], axis: 0 },
    { lineId: 'D', home: [34, 120], axis: 0 },
  ], 30, 4);
  assert.equal(out.groups.length, 2);
  assert.equal(out.connectors.length, 1);
  assert.ok(out.connectors[0].points.length >= 2);
});

test('deterministic: identical output on repeat', () => {
  const args = () => rectSeat(
    [{ lineId: 'A', home: [0, 0], axis: 2 }, { lineId: 'B', home: [3, 60], axis: 2 }], 30, 4);
  assert.deepEqual(args(), args());
});

test('single member -> one box at its home, no connector', () => {
  const out = rectSeat([{ lineId: 'A', home: [10, 10], axis: 0 }], 30, 4);
  assert.equal(out.centers.get('A')!.length, 2);
  assert.equal(out.connectors.length, 0);
});

// Two upright boxes of side `box` centered at c1,c2 overlap iff their footprints
// overlap on BOTH axes. A legible layout must never stack boxes.
const boxesOverlap = (c1: number[], c2: number[], box: number, eps = 1e-6) =>
  Math.abs(c1[0] - c2[0]) < box - eps && Math.abs(c1[1] - c2[1]) < box - eps;

test('identical homes -> boxes spread, no two output centers overlap', () => {
  const box = 30;
  const out = rectSeat([
    { lineId: 'A', home: [100, 100], axis: 0 },
    { lineId: 'B', home: [100, 100], axis: 0 },
    { lineId: 'C', home: [100, 100], axis: 0 },
  ], box, 4);
  const cs = [...out.centers.values()];
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++)
      assert.ok(!boxesOverlap(cs[i], cs[j], box), `centers ${i},${j} overlap`);
});

test('homes closer than box footprint -> centers spread into a row', () => {
  const box = 30;
  const out = rectSeat([
    { lineId: 'A', home: [0, 0], axis: 0 },
    { lineId: 'B', home: [6, 0], axis: 0 },
  ], box, 4);
  const a = out.centers.get('A')!, b = out.centers.get('B')!;
  // Separated by at least a full box side on some axis (not left overlapping).
  assert.ok(Math.abs(a[0] - b[0]) >= box - 1e-6 || Math.abs(a[1] - b[1]) >= box - 1e-6);
});

// The rendered capsule rect for a group is the bbox of its box centers expanded
// by box/2 + pad on each side (pad = box*0.16); mirror that here so the test
// measures the same rect the solver draws.
const CAP_GAP_FRAC = 0.12;
const capsuleRect = (group: { x: number; y: number; w: number; h: number }) => ({
  x0: group.x, y0: group.y, x1: group.x + group.w, y1: group.y + group.h,
});
// Signed clearance between two AABBs along the tighter axis: >= 0 means the rects
// are clear of each other (no overlap) by that many px on at least one axis.
const rectClearance = (
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
) => {
  const gapX = Math.max(a.x0 - b.x1, b.x0 - a.x1);
  const gapY = Math.max(a.y0 - b.y1, b.y0 - a.y1);
  return Math.max(gapX, gapY);
};

test('close but non-axis-aligned homes -> capsules clear of overlap and touch', () => {
  const box = 30;
  const out = rectSeat([
    { lineId: 'A', home: [0, 0], axis: 0 },
    { lineId: 'B', home: [8, 10], axis: 2 },
  ], box, 4);
  const rects = out.groups.map(capsuleRect);
  const capGap = box * CAP_GAP_FRAC;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      assert.ok(
        rectClearance(rects[i], rects[j]) >= capGap - 1e-6,
        `capsules ${i},${j} closer than capGap`,
      );
});

test('three coincident homes -> capsules clear of overlap and touch', () => {
  const box = 30;
  const out = rectSeat([
    { lineId: 'A', home: [50, 50], axis: 0 },
    { lineId: 'B', home: [50, 50], axis: 0 },
    { lineId: 'C', home: [50, 50], axis: 0 },
  ], box, 4);
  const rects = out.groups.map(capsuleRect);
  const capGap = box * CAP_GAP_FRAC;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      assert.ok(
        rectClearance(rects[i], rects[j]) >= capGap - 1e-6,
        `capsules ${i},${j} closer than capGap`,
      );
});

test('large hub (n > 6) all on one line -> greedy merges into few rows', () => {
  // Twelve members strung along a common line. Above the enumeration limit the
  // greedy seater merges collinear boxes into shared rows, so a 12-line hub is a
  // handful of rows rather than one box per line.
  const box = 30;
  const n = 12;
  const members = Array.from({ length: n }, (_, i) => ({
    lineId: `L${String.fromCharCode(97 + i)}`,
    home: [i * 40, 0] as [number, number],
    axis: 0,
  }));
  const out = rectSeat(members, box, 4);
  assert.equal(out.centers.size, n);
  // Fewer groups than a per-box split (collinear lines share rows).
  assert.ok(out.groups.length < n, 'expected shared rows, not one box per group');
  // No two output boxes overlap.
  const cs = [...out.centers.values()];
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++)
      assert.ok(!boxesOverlap(cs[i], cs[j], box), `centers ${i},${j} overlap`);
});

test('large hub greedy seat is deterministic on repeat', () => {
  const box = 30;
  const members = Array.from({ length: 10 }, (_, i) => ({
    lineId: `L${i}`, home: [i * 37, (i % 3) * 11] as [number, number], axis: (i % 4),
  }));
  assert.deepEqual(rectSeat(members, box, 4), rectSeat(members, box, 4));
});

test('7-member hub -> collinear lines share rows, far lines stay separate', () => {
  // Above the enumeration limit (n > 6) so the greedy seater runs. Four members
  // share one axis and sit near-collinear along one line (they pack into one row
  // cheaply); three sit far away in distinct directions, so the greedy merge folds
  // the collinear lines together but does not collapse the whole hub into one row.
  const box = 7.35;
  const gap = box * 0.14;
  const members = [
    // Four near-collinear along the x axis, common axis 0.
    { lineId: 'A', home: [0, 0] as [number, number], axis: 0 },
    { lineId: 'B', home: [9, 0] as [number, number], axis: 0 },
    { lineId: 'C', home: [18, 0] as [number, number], axis: 0 },
    { lineId: 'D', home: [27, 0] as [number, number], axis: 0 },
    // Three far away in distinct directions/distances.
    { lineId: 'E', home: [140, 60] as [number, number], axis: 1 },
    { lineId: 'F', home: [-90, 130] as [number, number], axis: 2 },
    { lineId: 'G', home: [60, -150] as [number, number], axis: 3 },
  ];
  const out = rectSeat(members, box, gap);
  assert.equal(out.centers.size, 7);
  // The collinear lines share at least one row (so fewer than 7 groups); the far
  // lines are not all absorbed into it (so more than one group).
  assert.ok(out.groups.length > 1, 'far lines should not all collapse into one row');
  assert.ok(out.groups.length < 7, 'collinear lines should share at least one row');
  // No two output group capsules overlap or touch.
  const rects = out.groups.map(capsuleRect);
  const capGap = box * CAP_GAP_FRAC;
  let touchPairs = 0;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      if (rectClearance(rects[i], rects[j]) < capGap - 1e-6) touchPairs++;
  assert.equal(touchPairs, 0, 'no two output group rects overlap or touch');
  // Determinism: two calls with the same input serialize identically.
  const ser = () => JSON.stringify(rectSeat(members, box, gap), (_k, v) =>
    v instanceof Map ? [...v.entries()] : v);
  assert.equal(ser(), ser());
});
