import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDenseBoxes, buildBoxExpandWarp, buildSepBoxWarp } from './densityBoxWarp';
import { buildDensityWarp } from './densityWarp';
import type { Pixel } from './types';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

// numeric area magnification J = det(Jacobian) at p, via finite differences
function jacDet(W: (p: Pixel) => Pixel, p: Pixel, h = 0.5): number {
  const wx1 = W([p[0] + h, p[1]]);
  const wx0 = W([p[0] - h, p[1]]);
  const wy1 = W([p[0], p[1] + h]);
  const wy0 = W([p[0], p[1] - h]);
  const a = (wx1[0] - wx0[0]) / (2 * h);
  const b = (wy1[0] - wy0[0]) / (2 * h);
  const c = (wx1[1] - wx0[1]) / (2 * h);
  const d = (wy1[1] - wy0[1]) / (2 * h);
  return a * d - b * c;
}

function clusterAt(cx: number, cy: number, n = 120): Pixel[] {
  const pts: Pixel[] = [];
  for (let k = 0; k < n; k++) pts.push([cx + ((k % 6) - 3), cy + (((k / 6) | 0) % 6 - 3)]);
  return pts;
}

test('findDenseBoxes: a cluster yields a box covering it; empty → none', () => {
  assert.deepEqual(findDenseBoxes([], BOX, {}), []);
  const boxes = findDenseBoxes(clusterAt(70, 30), BOX, { bins: 32, frac: 0.4 });
  assert.ok(boxes.length >= 1, 'at least one dense box');
  // some box contains the cluster centre (70,30)
  const hit = boxes.some((b) => b.x0 <= 70 && 70 <= b.x1 && b.y0 <= 30 && 30 <= b.y1);
  assert.ok(hit, `a box covers the cluster, got ${JSON.stringify(boxes)}`);
});

test('findDenseBoxes: higher cutoff selects a smaller (or equal) dense area', () => {
  const s = clusterAt(50, 50, 200);
  const lo = findDenseBoxes(s, BOX, { bins: 48, frac: 0.2 });
  const hi = findDenseBoxes(s, BOX, { bins: 48, frac: 0.6 });
  const area = (bs: { x0: number; y0: number; x1: number; y1: number }[]) =>
    bs.reduce((a, b) => a + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  assert.ok(area(hi) <= area(lo) + 1e-6, `stricter cutoff ≤ area: ${area(hi)} vs ${area(lo)}`);
});

test('buildBoxExpandWarp: expands inside the dense box, identity far away, fold-free', () => {
  const W = buildBoxExpandWarp(clusterAt(50, 50, 160), BOX, { bins: 48, frac: 0.4, expand: 1.4, marginFrac: 1 });
  const jIn = jacDet(W, [50, 50]); // inside the dense box → expanded
  const jFar = jacDet(W, [92, 8]); // opposite corner, far → untouched
  assert.ok(jIn > 1.1, `dense box expands, J=${jIn.toFixed(2)}`);
  assert.ok(Math.abs(jFar - 1) < 0.05, `far is identity, J=${jFar.toFixed(2)}`);
  // fold-free everywhere
  for (let y = 2; y < 100; y += 4) for (let x = 2; x < 100; x += 4) {
    assert.ok(jacDet(W, [x, y]) > 0, `det>0 at (${x},${y})`);
  }
});

test('buildBoxExpandWarp: LOCAL — a far same-row point is not co-expanded', () => {
  const W = buildBoxExpandWarp(clusterAt(50, 50, 160), BOX, { bins: 48, frac: 0.4, expand: 1.5, marginFrac: 1 });
  const jBox = jacDet(W, [50, 50]);
  const jSameRow = jacDet(W, [92, 50]); // same row as the box, far in x
  assert.ok(jBox > 1.1, `box expands, J=${jBox.toFixed(2)}`);
  assert.ok(jSameRow < 1.1, `same-row far point not co-expanded, J=${jSameRow.toFixed(2)}`);
});

test('buildBoxExpandWarp: deterministic; expand=1 or no samples → identity', () => {
  assert.deepEqual(buildBoxExpandWarp([], BOX, {})([3, 4]), [3, 4]);
  assert.deepEqual(buildBoxExpandWarp(clusterAt(50, 50), BOX, { expand: 1 })([3, 4]), [3, 4]);
  const a = buildBoxExpandWarp(clusterAt(40, 60, 120), BOX, { bins: 32, frac: 0.4, expand: 1.4 });
  const b = buildBoxExpandWarp(clusterAt(40, 60, 120), BOX, { bins: 32, frac: 0.4, expand: 1.4 });
  for (const p of [[10, 10], [40, 60], [90, 90]] as Pixel[]) assert.deepEqual(a(p), b(p));
});

test('buildSepBoxWarp: composes separable + box, fold-free, expands core more than separable alone', () => {
  const s = clusterAt(50, 50, 200);
  const sep = buildDensityWarp(s, BOX, { alpha: 0.8 });
  const both = buildSepBoxWarp(s, BOX, { alpha: 0.8 }, { bins: 48, frac: 0.4, expand: 3, marginFrac: 2 });
  for (let y = 2; y < 100; y += 5) for (let x = 2; x < 100; x += 5) {
    assert.ok(jacDet(both, [x, y]) > 0, `det>0 at (${x},${y})`);
  }
  // the box adds expansion on top of separable: J at the core is strictly larger
  const jSep = jacDet(sep, [50, 50]);
  const jBoth = jacDet(both, [50, 50]);
  assert.ok(jBoth > jSep, `combined expands core more than separable: ${jBoth.toFixed(2)} > ${jSep.toFixed(2)}`);
});
