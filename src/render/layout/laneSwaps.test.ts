import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdgeLanes, planSwaps } from './laneSwaps';
import { offsetPolyline } from './offsets';
import type { Pixel } from './types';

const spacing = 16; // LINE_WIDTH + LINE_GAP at the time of writing

test('buildEdgeLanes: identity order == constant offsetPolyline (byte-identical path)', () => {
  const base: Pixel[] = [[0, 0], [50, 0], [100, 0]];
  const order = ['A', 'B', 'C'];
  const lanes = buildEdgeLanes(base, order, order, spacing, 0);
  const center = (order.length - 1) / 2;
  for (let i = 0; i < order.length; i++) {
    const o = (i - center) * spacing;
    const expected = Math.abs(o) < 1e-9 ? base.map((p) => p.slice()) : offsetPolyline(base, o, false);
    assert.deepEqual(lanes.get(order[i]), expected, `lane ${order[i]} matches constant offset`);
  }
});

test('buildEdgeLanes: identity with bias matches constant (offset+bias)', () => {
  const base: Pixel[] = [[0, 0], [80, 0]];
  const order = ['A', 'B'];
  const bias = 4;
  const lanes = buildEdgeLanes(base, order, order, spacing, bias);
  const center = (order.length - 1) / 2;
  for (let i = 0; i < order.length; i++) {
    const o = (i - center) * spacing + bias;
    assert.deepEqual(lanes.get(order[i]), offsetPolyline(base, o, false));
  }
});

function segs(poly: Pixel[]): Array<[Pixel, Pixel]> {
  const s: Array<[Pixel, Pixel]> = [];
  for (let i = 1; i < poly.length; i++) s.push([poly[i - 1], poly[i]]);
  return s;
}

function segIntersections(a: Pixel[], b: Pixel[]): number {
  // Count proper crossings between two polylines (segment-segment).
  const cross = (p: Pixel, q: Pixel, r: Pixel, s: Pixel): boolean => {
    const d = (o: Pixel, x: Pixel, y: Pixel) =>
      Math.sign((x[0] - o[0]) * (y[1] - o[1]) - (x[1] - o[1]) * (y[0] - o[0]));
    const d1 = d(p, q, r), d2 = d(p, q, s), d3 = d(r, s, p), d4 = d(r, s, q);
    return d1 !== d2 && d3 !== d4;
  };
  let n = 0;
  for (const [p, q] of segs(a)) for (const [r, s] of segs(b)) if (cross(p, q, r, s)) n++;
  return n;
}

test('buildEdgeLanes: a single adjacent swap makes the two lanes cross exactly once', () => {
  const base: Pixel[] = [[0, 0], [100, 0]];
  const lanes = buildEdgeLanes(base, ['A', 'B'], ['B', 'A'], spacing, 0);
  const A = lanes.get('A')!;
  const B = lanes.get('B')!;
  assert.equal(segIntersections(A, B), 1, 'A and B cross exactly once');
  // Endpoints arrive in canonical order: A starts low (-8), ends high (+8).
  assert.ok(A[0][1] < 0 && A[A.length - 1][1] > 0, 'A steps from low to high');
  assert.ok(B[0][1] > 0 && B[B.length - 1][1] < 0, 'B steps from high to low');
});

test('buildEdgeLanes: swapping lanes never share a collinear segment (overdraw-safe)', () => {
  const base: Pixel[] = [[0, 0], [100, 0]];
  const lanes = buildEdgeLanes(base, ['A', 'B'], ['B', 'A'], spacing, 0);
  const A = segs(lanes.get('A')!);
  const B = segs(lanes.get('B')!);
  for (const [a1, a2] of A) {
    for (const [b1, b2] of B) {
      const collinearSame =
        Math.abs(a1[0] - b1[0]) < 0.01 && Math.abs(a1[1] - b1[1]) < 0.01 &&
        Math.abs(a2[0] - b2[0]) < 0.01 && Math.abs(a2[1] - b2[1]) < 0.01;
      assert.ok(!collinearSame, 'no identical segment shared by both lanes');
    }
  }
});

test('planSwaps: a single swap on a bent edge lands at the interior bend vertex', () => {
  // Base bends at arc 30 (vertex [30,0]); total length 80 so the even-spacing
  // midpoint would be 40 — the swap must prefer the bend (30), not 40.
  const base: Pixel[] = [[0, 0], [30, 0], [30, 50]];
  const swaps = planSwaps(['A', 'B'], ['B', 'A'], base);
  assert.equal(swaps.length, 1);
  assert.ok(Math.abs(swaps[0].arc - 30) < 1e-6, `swap at the bend (arc 30), got ${swaps[0].arc}`);
});

test('planSwaps: straight edge with no bend spaces swaps in the interior', () => {
  const base: Pixel[] = [[0, 0], [120, 0]];
  const swaps = planSwaps(['A', 'B', 'C'], ['C', 'B', 'A'], base); // 3 inversions
  assert.equal(swaps.length, 3);
  for (const s of swaps) assert.ok(s.arc > 0 && s.arc < 120, 'interior');
});
