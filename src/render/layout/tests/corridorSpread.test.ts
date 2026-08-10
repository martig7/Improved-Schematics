import { test } from 'node:test';
import assert from 'node:assert';
import { corridorSpreadReachLimit, solveCorridorSpread } from '../corridorSpread';

const WANT = 8.85; // full separation
const MIN = 4.78;  // drawn fill-touch

test('corridorSpread: a free corridor takes the full spacing', () => {
  const home = [0, 0.5, 1];
  const r = solveCorridorSpread(home, [-40, -40, -40], [40, 40, 40], WANT, MIN)!;
  assert.ok(r, 'placed');
  assert.equal(r.gap, WANT);
  assert.ok(r.at[1] - r.at[0] >= WANT - 1e-9);
  assert.ok(r.at[2] - r.at[1] >= WANT - 1e-9);
});

test('corridorSpread: stops already far enough apart are left where they are', () => {
  const home = [-20, 0, 20];
  const r = solveCorridorSpread(home, [-40, -40, -40], [40, 40, 40], WANT, MIN)!;
  assert.deepEqual(r.at, home, 'no stop disturbed');
});

test('corridorSpread: only the crowded stops move', () => {
  // outer two are comfortable; the middle pair is piled on the second
  const home = [-20, 0, 0.5, 20];
  const r = solveCorridorSpread(home, [-40, -10, -10, 10], [-10, 10, 10, 40], WANT, MIN)!;
  assert.equal(r.at[0], -20, 'first stop untouched');
  assert.equal(r.at[3], 20, 'last stop untouched');
  assert.ok(r.at[2] - r.at[1] >= r.gap - 1e-9, 'the piled pair separated');
});

test('corridorSpread: a tight corridor takes the widest spacing it admits', () => {
  // three stops confined to a 12px run: the widest even spacing is 6
  const r = solveCorridorSpread([0, 0, 0], [0, 0, 0], [12, 12, 12], WANT, MIN)!;
  assert.ok(Math.abs(r.gap - 6) < 1e-9, `gap ${r.gap}`);
  assert.ok(r.at[2] - r.at[0] <= 12 + 1e-9, 'inside the run');
});

test('corridorSpread: no room for a useful spacing places nothing', () => {
  // two stops that can barely move: the widest spacing is below fill-touch
  assert.equal(solveCorridorSpread([0, 0], [-1, -1], [1, 1], WANT, MIN), null);
});

test('corridorSpread: a stop pinned at its position bounds the run', () => {
  // the last stop cannot move at all (an anchor); spacing must fit the rest
  const r = solveCorridorSpread([0, 5, 10], [-2, -2, 10], [30, 30, 10], WANT, MIN)!;
  assert.equal(r.at[2], 10, 'the pinned stop stays');
  assert.ok(r.gap >= MIN, 'still worth doing');
  assert.ok(r.at[1] - r.at[0] >= r.gap - 1e-9);
  assert.ok(r.at[2] - r.at[1] >= r.gap - 1e-9);
});

test('corridorSpread: placement never leaves a stop outside its reach', () => {
  const home = [0, 1, 2, 3];
  const lo = [-5, -3, 0, 4];
  const hi = [5, 9, 14, 22];
  const r = solveCorridorSpread(home, lo, hi, WANT, MIN)!;
  for (let k = 0; k < home.length; k++) {
    assert.ok(r.at[k] >= lo[k] - 1e-9 && r.at[k] <= hi[k] + 1e-9, `stop ${k} at ${r.at[k]} outside [${lo[k]},${hi[k]}]`);
  }
  for (let k = 1; k < home.length; k++) {
    assert.ok(r.at[k] - r.at[k - 1] >= r.gap - 1e-9, 'spacing held');
    assert.ok(r.at[k] > r.at[k - 1], 'order held');
  }
});

test('corridorSpread: reach for a long free chain admits the requested spacing', () => {
  const n = 6;
  const reach = corridorSpreadReachLimit(n, WANT);
  const home = new Array<number>(n).fill(0);
  const r = solveCorridorSpread(
    home,
    new Array<number>(n).fill(-reach),
    new Array<number>(n).fill(reach),
    WANT,
    MIN,
  )!;
  assert.equal(reach, (n - 1) * WANT);
  assert.equal(r.gap, WANT);
});
