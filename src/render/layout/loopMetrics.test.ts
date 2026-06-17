import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPaintedLoops } from './loopMetrics';
import type { Pixel } from './types';

// A straight line never crosses itself.
test('straight line: no loop', () => {
  const pts: Pixel[] = Array.from({ length: 20 }, (_, i) => [i * 10, 0] as Pixel);
  assert.equal(detectPaintedLoops([{ lineId: 'a', pts }]).length, 0);
});

// An out-and-back retrace is coincident, not crossing — must NOT be a loop.
test('out-and-back retrace: no loop (coincident, not crossing)', () => {
  const pts: Pixel[] = [];
  for (let x = 0; x <= 200; x += 10) pts.push([x, 0]);
  for (let x = 200; x >= 0; x -= 10) pts.push([x, 0]); // exact retrace
  assert.equal(detectPaintedLoops([{ lineId: 'a', pts }]).length, 0);
});

// Two parallel lanes (offset out-and-back) with a clean hairpin: no crossing.
test('parallel out-and-back: no loop', () => {
  const pts: Pixel[] = [];
  for (let x = 0; x <= 200; x += 10) pts.push([x, 0]);
  for (let x = 200; x >= 0; x -= 10) pts.push([x, 6]); // 6px offset, never crosses
  assert.equal(detectPaintedLoops([{ lineId: 'a', pts }]).length, 0);
});

// A figure-of-eight / hook that genuinely crosses itself: one small artifact loop.
test('self-crossing hook: one artifact loop', () => {
  // a small loop: out, around, and back across the outgoing leg
  const pts: Pixel[] = [
    [0, 0], [40, 0], [40, 40], [10, 40], [10, -10], [40, -10], [60, -10],
  ];
  const loops = detectPaintedLoops([{ lineId: 'a', pts }]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].kind, 'artifact');
});

// A map-scale self-crossing loop (genuine near-circular route) classes bigloop.
test('map-scale self-crossing: bigloop', () => {
  const pts: Pixel[] = [];
  const R = 400;
  for (let deg = 0; deg <= 380; deg += 8) {
    // past 360° so the path overshoots its start and crosses itself
    const t = (deg * Math.PI) / 180;
    pts.push([R + R * Math.cos(t), R + R * Math.sin(t)]);
  }
  const loops = detectPaintedLoops([{ lineId: 'a', pts }]);
  assert.ok(loops.length >= 1);
  assert.equal(loops[0].kind, 'bigloop', `diam ${loops[0]?.diameter} should be a bigloop`);
});
