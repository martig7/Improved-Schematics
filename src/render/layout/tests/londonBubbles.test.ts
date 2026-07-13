import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLondonByNode, type LondonBubble } from '../londonBubbles';

type P = [number, number];
const mark = (pos: P, axis = 0, mega = false) => ({ axis, pos, mega });
const R = (lw: number) => lw * 1.5; // must match londonBubbles R_FACTOR
const compute = (marks: ReturnType<typeof mark>[], lw = 4) => computeLondonByNode(new Map([['n', marks]]), lw).get('n')!;

const overlaps = (a: LondonBubble, b: LondonBubble) => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 1e-6;
const noOverlaps = (bs: LondonBubble[]) => bs.every((a, i) => bs.slice(i + 1).every((b) => !overlaps(a, b)));

// ---- single dot (clusters that fit under one bubble) -------------------------

test('computeLondonByNode: a tight crossing collapses to one dot', () => {
  const cap = compute([mark([0, 0], 0), mark([1, 1], 2), mark([-1, 1], 3)]);
  assert.equal(cap.bubbles.length, 1);
  assert.equal(cap.necks.length, 0);
  assert.equal(cap.bubbles[0].r, R(4), 'uniform bubble size');
});

test('computeLondonByNode: two adjacent lines are one dot covering both', () => {
  const cap = compute([mark([0, 0]), mark([0, 5])]);
  assert.equal(cap.bubbles.length, 1);
  assert.ok(Math.abs(cap.bubbles[0].x) < 1e-9 && Math.abs(cap.bubbles[0].y - 2.5) < 1e-9, 'between the two lanes');
});

test('computeLondonByNode: a bundle crossing a single line is one dot at the intersection, even with the crossing stop offset', () => {
  const cap = compute([mark([0, 0], 0), mark([0, 5], 0), mark([2.5, -18], 2)]);
  assert.equal(cap.bubbles.length, 1);
  assert.ok(Math.abs(cap.bubbles[0].x - 2.5) < 1e-6, 'on the crossing line');
});

// ---- clustering: crossings vs bundles ---------------------------------------

test('computeLondonByNode: a wide bundle crossed by a diagonal clusters into a crossing dot plus a pair dot', () => {
  // three parallel vertical lines (a gray + two green, spanning 11px) plus a red
  // diagonal that crosses near the first: too wide for one dot, so it must split,
  // and the cheapest split pairs the diagonal with the line it crosses.
  const cap = compute([
    mark([1613.6, 1703.6], 2), // gray, vertical
    mark([1619.1, 1703.6], 2), // green, vertical
    mark([1624.6, 1703.6], 2), // green, vertical
    mark([1607.4, 1706.2], 1), // red, diagonal
  ], 3.5);
  assert.equal(cap.bubbles.length, 2, 'crossing pair + green pair, not three separate dots');
  assert.ok(noOverlaps(cap.bubbles), 'the two dots do not touch');
});

test('computeLondonByNode: a spread same-axis bundle splits into non-overlapping bubbles', () => {
  const cap = compute([mark([0, 0]), mark([0, 7]), mark([0, 14]), mark([0, 21])]);
  assert.ok(cap.bubbles.length >= 2, 'falls back to a chain');
  assert.ok(noOverlaps(cap.bubbles), 'no two bubbles overlap');
  assert.ok(cap.bubbles.every((b) => b.r === R(4)), 'uniform size');
});

test('computeLondonByNode: prefers fewer bubbles (pairs over singles)', () => {
  const cap = compute([mark([0, 0]), mark([0, 7]), mark([0, 14]), mark([0, 21])]);
  assert.equal(cap.bubbles.length, 2, 'two pair bubbles, not four singles');
});

test('computeLondonByNode: a pair too wide to cover becomes two separate bubbles', () => {
  const cap = compute([mark([0, 0]), mark([0, 15])]);
  assert.equal(cap.bubbles.length, 2);
  assert.ok(noOverlaps(cap.bubbles));
});

test('computeLondonByNode: bubbles at a node are connected by one fewer neck than bubbles', () => {
  const cap = compute([mark([0, 0]), mark([0, 7]), mark([0, 14])]);
  assert.equal(cap.necks.length, cap.bubbles.length - 1, 'a spanning tree of connectors');
});

// ---- degenerate --------------------------------------------------------------

test('computeLondonByNode: single stops and mega nodes get no bubble', () => {
  const out = computeLondonByNode(new Map([
    ['single', [mark([0, 0])]],
    ['mega', [mark([0, 0], 0, true), mark([0, 6], 0, true)]],
    ['pair', [mark([0, 0]), mark([0, 5])]],
  ]), 4);
  assert.equal(out.has('single'), false);
  assert.equal(out.has('mega'), false);
  assert.equal(out.has('pair'), true);
});

test('computeLondonByNode: deterministic on repeat', () => {
  const marks = [mark([1, 2]), mark([3, 14]), mark([5, 26])];
  const a = computeLondonByNode(new Map([['n', marks]]), 3.5).get('n')!;
  const b = computeLondonByNode(new Map([['n', marks]]), 3.5).get('n')!;
  assert.deepEqual(a, b);
});
