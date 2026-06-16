import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseMutualSlide, penBetween, segSegDist, type Hull } from './capsuleSlide';

// A circular capsule = a single degenerate segment (a == b) of radius `half`.
const dot = (x: number, y: number, half = 5): Hull => [{ a: [x, y], b: [x, y], half }];

// A slides left (−x) with index ka, B slides right (+x) with index kb; radius 5
// each, so they "clear" (pen ≤ −1) once their centres are ≥ 11px apart.
const slideA = (steps: number, step: number): Hull[] =>
  Array.from({ length: steps + 1 }, (_, k) => dot(-1 - k * step, 0));
const slideB = (steps: number, step: number): Hull[] =>
  Array.from({ length: steps + 1 }, (_, k) => dot(1 + k * step, 0));

test('segSegDist: parallel offset segments → perpendicular gap', () => {
  assert.equal(segSegDist([0, 0], [10, 0], [0, 10], [10, 10]), 10);
});

test('penBetween: far apart is negative (clear), overlapping is positive', () => {
  assert.ok(penBetween(dot(0, 0), dot(20, 0)) < 0); // 10 − 20 = −10
  assert.ok(penBetween(dot(0, 0), dot(8, 0)) > 0); // 10 − 8 = 2
});

test('chooseMutualSlide: splits across both when neither side alone can clear', () => {
  // each side reaches only k ≤ 2 at 3px/step → one-sided max centre gap = 2 + 6 = 8
  // (pen 2, not clear); clearing needs gap ≥ 11 → ka+kb ≥ 3, only by moving BOTH.
  const A = slideA(2, 3);
  const B = slideB(2, 3);
  const { ka, kb } = chooseMutualSlide(A, B);
  assert.ok(penBetween(A[ka], B[kb]) <= -1, 'chosen cell clears');
  assert.ok(penBetween(A[2], B[0]) > -1, 'A alone (max) does not clear');
  assert.ok(penBetween(A[0], B[2]) > -1, 'B alone (max) does not clear');
  assert.equal(ka + kb, 3, 'uses the least total slide that clears');
  assert.ok(ka > 0 && kb > 0, 'both capsules moved');
});

test('chooseMutualSlide: prefers a one-sided move when it clears at equal total cost', () => {
  // A can reach k=3 (gap 2 + 12 = 14, clears) alone; least total to clear is 3,
  // achievable single-sided — so one capsule should stay put.
  const A = slideA(3, 4);
  const B = slideB(3, 4);
  const { ka, kb } = chooseMutualSlide(A, B);
  assert.ok(penBetween(A[ka], B[kb]) <= -1, 'chosen cell clears');
  assert.equal(ka + kb, 3, 'least total slide');
  assert.ok(ka === 0 || kb === 0, 'one capsule stays put when one-sided suffices');
});

test('chooseMutualSlide: best-effort returns max separation when nothing clears', () => {
  // 1px/step, max gap 2 + 2 + 2 = 6 < 11 → never clears; least-penetration cell is
  // the farthest-apart one.
  const A = slideA(2, 1);
  const B = slideB(2, 1);
  const { ka, kb } = chooseMutualSlide(A, B);
  assert.equal(ka, 2);
  assert.equal(kb, 2);
});

test('chooseMutualSlide: indices stay within the provided candidate ranges', () => {
  const A = slideA(1, 1); // length 2
  const B = slideB(4, 1); // length 5
  const { ka, kb } = chooseMutualSlide(A, B);
  assert.ok(ka >= 0 && ka < A.length);
  assert.ok(kb >= 0 && kb < B.length);
});
