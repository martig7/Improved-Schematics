import { test } from 'node:test';
import assert from 'node:assert';
import { buildSeatInkOracle } from '../seatInk';
import type { Pixel } from '../types';

const SP = 6; // threshold = 4.5

// Base fixture: 'seat' is the line being seated (rank 1). 'under' runs
// straight through the query point but paints BELOW; 'over' runs 2px away
// and paints ABOVE.
const mkOracle = (over: Partial<Parameters<typeof buildSeatInkOracle>[0]> = {}) =>
  buildSeatInkOracle({
    segments: [
      { lineId: 'under', pts: [[0, 10], [100, 10]] as Pixel[] },
      { lineId: 'over', pts: [[0, 12], [100, 12]] as Pixel[] },
    ],
    joinCurves: [],
    strokeRank: new Map([['seat', 1], ['under', 0], ['over', 2]]),
    colorOf: new Map([['seat', '#f00'], ['under', '#0f0'], ['over', '#00f']]),
    spacing: SP,
    ...over,
  });

test('seatInk: a higher-ranked strand within the threshold is dirty, graded by depth', () => {
  const o = mkOracle();
  assert.equal(o.threshold, 4.5);
  const near = o.dirtAt([50, 11], 'seat'); // 1px from 'over'
  const far = o.dirtAt([50, 8.2], 'seat'); // 3.8px from 'over'
  assert.ok(near > 0 && far > 0, 'both within threshold are dirty');
  assert.ok(near > far, 'closer occluder charges more');
  assert.equal(o.dirtAt([50, 30], 'seat'), 0, 'beyond threshold is clean');
});

test('seatInk: a lower-ranked strand (paints below) is clean', () => {
  const o = mkOracle();
  // ON the 'under' strand, 2px from 'over': only 'over' counts
  const d = o.dirtAt([50, 10], 'seat');
  assert.ok(Math.abs(d - (4.5 - 2)) < 1e-9, 'depth comes from over only');
  // move out of over's reach: under alone -> clean
  assert.equal(o.dirtAt([50, 5], 'seat'), 0);
});

test('seatInk: the own line never dirties its own seat', () => {
  const o = buildSeatInkOracle({
    segments: [{ lineId: 'seat', pts: [[0, 10], [100, 10]] as Pixel[] }],
    joinCurves: [],
    strokeRank: new Map([['seat', 0]]),
    colorOf: new Map([['seat', '#f00']]),
    spacing: SP,
  });
  assert.equal(o.dirtAt([50, 10], 'seat'), 0);
});

test('seatInk: same-color occlusion is invisible and clean', () => {
  const o = mkOracle({
    colorOf: new Map([['seat', '#f00'], ['under', '#0f0'], ['over', '#F00']]),
  });
  assert.equal(o.dirtAt([50, 11], 'seat'), 0, 'case-insensitive color match');
});

test('seatInk: multiple occluders charge the max depth, not the sum', () => {
  const o = buildSeatInkOracle({
    segments: [
      { lineId: 'a', pts: [[0, 12], [100, 12]] as Pixel[] }, // 2px away
      { lineId: 'b', pts: [[0, 9], [100, 9]] as Pixel[] },   // 1px away
    ],
    joinCurves: [],
    strokeRank: new Map([['seat', 0], ['a', 1], ['b', 2]]),
    colorOf: new Map([['seat', '#f00'], ['a', '#0f0'], ['b', '#00f']]),
    spacing: SP,
  });
  const d = o.dirtAt([50, 10], 'seat');
  assert.ok(Math.abs(d - (4.5 - 1)) < 1e-9, 'max of (4.5-2, 4.5-1)');
});

test('seatInk: join-curve strands count as ink', () => {
  const o = buildSeatInkOracle({
    segments: [],
    joinCurves: [{ lineId: 'over', a: [0, 10], apex: [50, 10], b: [100, 10] }],
    strokeRank: new Map([['seat', 0], ['over', 1]]),
    colorOf: new Map([['seat', '#f00'], ['over', '#00f']]),
    spacing: SP,
  });
  assert.ok(o.dirtAt([50, 11], 'seat') > 0, 'sampled quadratic occludes');
  assert.equal(o.dirtAt([50, 30], 'seat'), 0);
});
