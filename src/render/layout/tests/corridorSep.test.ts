import { test } from 'node:test';
import assert from 'node:assert';
import { findParallelPairs, applyJointSeating } from '../corridorSep';
import type { Pixel } from '../types';

const SP = 6;

test('separation: near-parallel sub-clearance edges pair with signed offset', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['b', [[0, 3], [100, 5]]], // ~1 deg divergence, 3-5px away for the whole run
  ]);
  const pairs = findParallelPairs(['a', 'b'], (id) => polys.get(id), () => 0, SP);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].eA, 'a');
  assert.equal(pairs[0].sign, 1);
  assert.ok(pairs[0].d0 > 2.5 && pairs[0].d0 < 5, 'offset ~3-4.5: ' + pairs[0].d0);
  assert.equal(pairs[0].needed, SP);
});

test('separation: antiparallel edges pair with sign -1', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['b', [[100, 4], [0, 4]]],
  ]);
  const pairs = findParallelPairs(['a', 'b'], (id) => polys.get(id), () => 0, SP);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].sign, -1);
  assert.ok(Math.abs(pairs[0].d0 - 4) < 0.5, 'offset ~4: ' + pairs[0].d0);
});

test('separation: perpendicular and end-to-end edges do not pair', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['x', [[50, -50], [50, 50]]],   // perpendicular crossing
    ['c', [[100, 0], [200, 0]]],    // collinear continuation
  ]);
  const pairs = findParallelPairs(['a', 'c', 'x'], (id) => polys.get(id), () => 0, SP);
  assert.equal(pairs.filter((p) => p.eB === 'x' || p.eA === 'x').length, 0, 'no perpendicular pair');
  // the collinear continuation only touches at the shared endpoint: the
  // near-parallel sub-clearance RUN there is a single point, not sustained
  assert.equal(pairs.filter((p) => (p.eA === 'a' && p.eB === 'c')).length, 0, 'no end-to-end pair');
});

test('seating: a transient mid-span gap spike stays jointly seated; a genuine tail release does not', () => {
  // Base A runs straight; base B rides 6px away but detours to 24px for a
  // short mid-span stretch (the corner-projection spike shape) and then
  // genuinely diverges at the far end. needed=12 puts the detour past the
  // far fade threshold (18), so without the dip fill the mid-span vertex
  // would release entirely.
  const baseA: Pixel[] = [[0, 0], [30, 0], [60, 0], [90, 0], [120, 0], [150, 0], [180, 0], [210, 0], [240, 0], [270, 0], [300, 0]];
  const baseB: Pixel[] = [[0, 6], [120, 6], [135, 24], [165, 24], [180, 6], [240, 6], [270, 40], [300, 60]];
  const laneA = baseA.map((p) => [...p] as Pixel);
  const laneB = baseB.map((p) => [...p] as Pixel);
  const segPath = new Map<string, Pixel[]>([['a|l1', laneA], ['b|l2', laneB]]);
  const seated = applyJointSeating({
    pairs: [{ eA: 'a', eB: 'b', d0: 6, sign: 1, needed: 12 }],
    polyOf: (id) => (id === 'a' ? baseA : baseB),
    orderOf: new Map([['a', ['l1']], ['b', ['l2']]]),
    segPath,
    spacing: 10,
  });
  assert.equal(seated, 1);
  // mid-span vertex opposite the detour: centerline y=12, joint seat -5
  // (nearest-rail projection may cut the synthetic tent apex slightly, so
  // assert the fill moved the vertex to its rail and that the two lanes
  // kept clearance through the spike; vertices are found by position, the
  // rail-bend insertion grows the arrays)
  const mid = laneA.reduce((best, p) => (Math.abs(p[0] - 150) < Math.abs(best[0] - 150) ? p : best));
  assert.ok(mid[1] > 5 && mid[1] < 8.5, 'dip filled, seated near centerline-5: y=' + mid[1]);
  const distToB = (p: Pixel): number => {
    let best = Infinity;
    for (let i = 1; i < laneB.length; i++) {
      const [ax, ay] = laneB[i - 1];
      const vx = laneB[i][0] - ax, vy = laneB[i][1] - ay;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / len2));
      best = Math.min(best, Math.hypot(p[0] - (ax + vx * t), p[1] - (ay + vy * t)));
    }
    return best;
  };
  for (const p of laneA.filter((v) => v[0] >= 120 && v[0] <= 180)) {
    assert.ok(distToB(p) > 8.5, 'clearance held through the spike at x=' + p[0] + ': ' + distToB(p));
  }
  // far-end vertices past the genuine divergence stay in their own frame
  for (const p of laneA.filter((v) => v[0] >= 270)) {
    assert.ok(Math.abs(p[1]) < 0.01, 'tail release kept at x=' + p[0] + ': y=' + p[1]);
  }
});

test('separation: clear edges (beyond combined reach) do not pair', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['b', [[0, 20], [100, 20]]],
  ]);
  const pairs = findParallelPairs(['a', 'b'], (id) => polys.get(id), () => 3, SP);
  // needed = 3 + 3 + 6 = 12 < 20 apart
  assert.equal(pairs.length, 0);
});
