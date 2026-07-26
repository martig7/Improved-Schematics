import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dc } from '../dc';
import type { StopScene, StopLine, Point } from '../types';

const ctx = { dark: false, showBullets: true };

const ln = (i: number, pos: Point, extra: Partial<StopLine> = {}): StopLine =>
  ({ lineId: 'L' + i, color: '#dc2626', bullet: String(i), textColor: '#fff', pos, chain: i, axis: 0, dir: [1, 0], ...extra });

const scene = (lines: StopLine[], anchor: Point = [0, 0]): StopScene =>
  ({ nodeId: 'n', lines, capsule: { kind: 'none' }, anchor, dotRadius: 3 });

const circles = (g: ReturnType<typeof dc.paint>) => g.filter((x) => x.kind === 'circle') as Array<{ cx: number; cy: number; r: number }>;
const ticks = (g: ReturnType<typeof dc.paint>) => g.filter((x) => x.kind === 'line');

test('a lone stop is one ringed circle fitted in the line', () => {
  const g = dc.paint(scene([ln(0, [10, 20])]), ctx);
  const c = circles(g);
  assert.equal(c.length, 2, 'ink disc + paper disc');
  assert.equal(ticks(g).length, 0);
  for (const x of c) assert.deepEqual([x.cx, x.cy], [10, 20]);
  assert.ok(c[0].r > c[1].r, 'the paper disc sits inside the ink one');
});

test('an odd bundle seats its single mark on the centre lane', () => {
  const g = dc.paint(scene([ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20])]), ctx);
  const c = circles(g);
  assert.equal(c.length, 2, 'one mark, not one per lane');
  assert.deepEqual([c[0].cx, c[0].cy], [0, 10], 'the middle lane');
});

test('an even bundle seats its single mark in the middle gap', () => {
  const g = dc.paint(scene([ln(0, [0, 0]), ln(1, [0, 10])]), ctx);
  const c = circles(g);
  assert.equal(c.length, 2);
  assert.deepEqual([c[0].cx, c[0].cy], [0, 5], 'between the two lanes');
});

test('a lone stop wears no stubs', () => {
  assert.equal(ticks(dc.paint(scene([ln(0, [10, 20])]), ctx)).length, 0);
});

test('a wide bundle keeps the centred dot and adds the stubs', () => {
  const lines = [ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20]), ln(3, [0, 30]), ln(4, [0, 40])];
  const g = dc.paint(scene(lines), ctx);
  const c = circles(g);
  assert.equal(c.length, 2, 'still one dot, not one per lane');
  assert.deepEqual([c[0].cx, c[0].cy], [0, 20], 'seated on the centre lane');
  assert.equal(ticks(g).length, 2, 'one stub per band edge');
});

test('stubs strike perpendicular to the run', () => {
  const lines = [ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20]), ln(3, [0, 30])];
  for (const t of ticks(dc.paint(scene(lines), ctx)) as Array<{ x1: number; y1: number; x2: number; y2: number }>) {
    // The run is horizontal, so a stub must be vertical.
    assert.ok(Math.abs(t.x2 - t.x1) < 1e-6, 'no horizontal component');
    assert.ok(Math.abs(t.y2 - t.y1) > 0, 'has length');
  }
});

test('lanes pointing different ways make it a transfer: a double ring', () => {
  const lines = [ln(0, [0, 0], { axis: 0, dir: [1, 0] }), ln(1, [0, 10], { axis: 2, dir: [0, 1] })];
  const g = dc.paint(scene(lines, [5, 5]), ctx);
  const c = circles(g);
  assert.equal(c.length, 4, 'outer ring (2) plus the inner stop circle (2)');
  for (const x of c) assert.deepEqual([x.cx, x.cy], [5, 5], 'all seated on the anchor');
  assert.equal(ticks(g).length, 0);
});

test('a splitting bundle counts as a transfer even on a shared axis', () => {
  // Same octilinear axis, but the exact tangents diverge: a split, not a run.
  const lines = [ln(0, [0, 0], { dir: [1, 0] }), ln(1, [0, 10], { dir: [0.7, 0.71] })];
  const g = dc.paint(scene(lines, [0, 5]), ctx);
  assert.equal(circles(g).length, 4, 'double ring');
});

test('a stub straddles its band edge, showing outside the paint', () => {
  // Lanes at y 0..30, so the band centre is 15 and the outermost lanes are +-15.
  const wide = [ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20]), ln(3, [0, 30])];
  const ds = ticks(dc.paint(scene(wide), ctx)) as Array<{ y1: number; y2: number }>;
  assert.equal(ds.length, 2, 'one per edge');
  for (const d of ds) {
    const near = Math.min(Math.abs(d.y1 - 15), Math.abs(d.y2 - 15));
    const far = Math.max(Math.abs(d.y1 - 15), Math.abs(d.y2 - 15));
    assert.ok(far > 15, `stub shows outside the outermost lane (reaches ${far.toFixed(1)})`);
    assert.ok(near < far, 'and starts inside it, so it straddles the edge');
  }
  // One each side of the band centre.
  const sides = ds.map((d) => Math.sign((d.y1 + d.y2) / 2 - 15));
  assert.notEqual(sides[0], sides[1], 'opposite edges');
});
