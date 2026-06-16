import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDensityWarp } from './densityWarp';
import type { Pixel } from './types';

const BOX = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

function clusteredSamples(): Pixel[] {
  const pts: Pixel[] = [];
  // dense cluster around (200, 200)
  for (let i = 0; i < 60; i++) {
    pts.push([180 + (i % 10) * 4, 180 + Math.floor(i / 10) * 6]);
  }
  // sparse spread elsewhere
  for (let i = 0; i < 12; i++) {
    pts.push([400 + i * 45, 500 + ((i * 137) % 400)]);
  }
  return pts;
}

test('densityWarp: alpha=0 is the identity', () => {
  const warp = buildDensityWarp(clusteredSamples(), BOX, { alpha: 0 });
  const p: Pixel = [123.4, 567.8];
  assert.deepEqual(warp(p), p);
});

test('densityWarp: no samples is the identity', () => {
  const warp = buildDensityWarp([], BOX, {});
  const p: Pixel = [42, 17];
  assert.deepEqual(warp(p), p);
});

test('densityWarp: strictly monotone along each axis (fold-free)', () => {
  const warp = buildDensityWarp(clusteredSamples(), BOX, { alpha: 0.8 });
  let prevX = -Infinity;
  let prevY = -Infinity;
  for (let v = -200; v <= 1200; v += 1) {
    const [x] = warp([v, 0]);
    const [, y] = warp([0, v]);
    assert.ok(x > prevX, `x monotone at ${v}`);
    assert.ok(y > prevY, `y monotone at ${v}`);
    prevX = x;
    prevY = y;
  }
});

test('densityWarp: domain endpoints are fixed points', () => {
  const warp = buildDensityWarp(clusteredSamples(), BOX, { alpha: 0.7 });
  const [x0] = warp([0, 0]);
  const [x1] = warp([1000, 0]);
  assert.ok(Math.abs(x0 - 0) < 1e-6);
  assert.ok(Math.abs(x1 - 1000) < 1e-6);
});

test('densityWarp: expands the dense cluster, shrinks empty space', () => {
  const samples = clusteredSamples();
  const warp = buildDensityWarp(samples, BOX, { alpha: 0.6 });
  // width of the dense cluster (x: 180..216) grows
  const [a] = warp([180, 0]);
  const [b] = warp([216, 0]);
  assert.ok(b - a > 36, `cluster expanded: ${(b - a).toFixed(1)}px from 36px`);
  // empty corridor (x: 800..1000 has no samples) shrinks
  const [c] = warp([800, 0]);
  const [d] = warp([1000, 0]);
  assert.ok(d - c < 200, `empty space compressed: ${(d - c).toFixed(1)}px from 200px`);
});

test('densityWarp: local magnification respects maxScale', () => {
  const samples: Pixel[] = [];
  for (let i = 0; i < 200; i++) samples.push([500 + (i % 5), 500 + (i % 7)]); // extreme point cluster
  const warp = buildDensityWarp(samples, BOX, { alpha: 1, maxScale: 3 });
  for (let v = 0; v < 1000; v += 2) {
    const [x1] = warp([v, 0]);
    const [x2] = warp([v + 2, 0]);
    assert.ok((x2 - x1) / 2 <= 3 + 0.05, `scale at ${v} = ${((x2 - x1) / 2).toFixed(2)}`);
  }
});

test('densityWarp: default maxScale (8) allows stronger magnification than the old 3', () => {
  const samples: Pixel[] = [];
  for (let i = 0; i < 200; i++) samples.push([500 + (i % 5), 500 + (i % 7)]); // extreme point cluster
  const warp = buildDensityWarp(samples, BOX, { alpha: 1 }); // no maxScale → default 8
  let peak = 0;
  for (let v = 0; v < 1000; v += 2) {
    const [x1] = warp([v, 0]);
    const [x2] = warp([v + 2, 0]);
    peak = Math.max(peak, (x2 - x1) / 2);
  }
  // The raised default lets a dense locale magnify well past the old 3× ceiling,
  // while still clamping at the new default (fold-free at any value).
  assert.ok(peak > 3, `default ceiling lifted: peak scale ${peak.toFixed(2)} should exceed 3`);
  assert.ok(peak <= 8 + 0.05, `default ceiling honored: peak scale ${peak.toFixed(2)} should be ≤ 8`);
});
