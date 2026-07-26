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

test('a two-lane bundle wears no stubs: the dot bridges both', () => {
  const g = dc.paint(scene([ln(0, [0, 0]), ln(1, [0, 10])]), ctx);
  assert.equal(ticks(g).length, 0);
  assert.equal(circles(g).length, 2, 'just the bridging dot');
});

test('a three-lane bundle stubs the two lanes the dot misses', () => {
  const g = dc.paint(scene([ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20])]), ctx);
  assert.equal(ticks(g).length, 2, 'the outer lanes only');
});

test('a wide bundle keeps the centred dot and stubs every other lane', () => {
  const lines = [ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20]), ln(3, [0, 30]), ln(4, [0, 40])];
  const g = dc.paint(scene(lines), ctx);
  const c = circles(g);
  assert.equal(c.length, 2, 'still one dot, not one per lane');
  assert.deepEqual([c[0].cx, c[0].cy], [0, 20], 'seated on the centre lane');
  assert.equal(ticks(g).length, 4, 'the four lanes the dot does not cover');
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
  // A horizontal lane at y=20 crossed by a vertical lane at x=10.
  const lines = [ln(0, [0, 20], { axis: 0, dir: [1, 0] }), ln(1, [10, 0], { axis: 2, dir: [0, 1] })];
  const g = dc.paint(scene(lines, [999, 999]), ctx);
  const c = circles(g);
  assert.equal(c.length, 4, 'outer ring (2) plus the inner stop circle (2)');
  for (const x of c) {
    // At the junction of the two centrelines, NOT at the (deliberately bogus) anchor.
    assert.ok(Math.abs(x.cx - 10) < 1e-6 && Math.abs(x.cy - 20) < 1e-6, `seated at ${x.cx},${x.cy}`);
  }
  assert.equal(ticks(g).length, 0);
});

test('a transfer seats centred between a two-lane bundle, not on a rail', () => {
  // A two-lane horizontal band at y=0 and y=10, crossed by a vertical lane.
  const lines = [
    ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
    ln(1, [0, 10], { axis: 0, dir: [1, 0] }),
    ln(2, [30, 0], { axis: 2, dir: [0, 1] }),
  ];
  const c = circles(dc.paint(scene(lines, [0, 0]), ctx));
  // Centred BETWEEN the pair (y=5), and on the crossing lane (x=30).
  assert.ok(Math.abs(c[0].cy - 5) < 1e-6, `expected the band centre, got y=${c[0].cy}`);
  assert.ok(Math.abs(c[0].cx - 30) < 1e-6, `expected the crossing lane, got x=${c[0].cx}`);
});

test('a splitting bundle counts as a transfer even on a shared axis', () => {
  // Same octilinear axis, but the exact tangents diverge: a split, not a run.
  const lines = [ln(0, [0, 0], { dir: [1, 0] }), ln(1, [0, 10], { dir: [0.7, 0.71] })];
  const g = dc.paint(scene(lines, [0, 5]), ctx);
  assert.equal(circles(g).length, 4, 'double ring');
});

test('a stub protrudes INWARD, toward the seated mark', () => {
  // Lanes at y 0,10,20; the dot seats on y=10, so lanes 0 and 20 are stubbed.
  const ds = ticks(dc.paint(scene([ln(0, [0, 0]), ln(1, [0, 10]), ln(2, [0, 20])]), ctx)) as Array<{ y1: number; y2: number }>;
  assert.equal(ds.length, 2);
  for (const d of ds) {
    const outer = Math.abs(d.y1 - 10) > Math.abs(d.y2 - 10) ? d.y1 : d.y2;
    const inner = outer === d.y1 ? d.y2 : d.y1;
    assert.ok(Math.abs(inner - 10) < Math.abs(outer - 10), 'the free end points at the mark');
    // It protrudes PAST its own lane on the inward side.
    const lane = outer < 10 ? 0 : 20;
    assert.ok(Math.abs(inner - 10) < Math.abs(lane - 10), `protrudes inward past lane ${lane}`);
  }
});

test('a solved point crossing seats the ring exactly there', () => {
  // Placement resolves a true crossing at compute time and hands it over as a
  // ring carrying no lines; the mark must take that point verbatim.
  const sc: StopScene = {
    nodeId: 'n', lines: [], capsule: { kind: 'ring', cx: 42, cy: 17, r: 9 },
    anchor: [999, 999], dotRadius: 3,
  };
  const c = circles(dc.paint(sc, ctx));
  assert.equal(c.length, 4, 'outer ring plus the inner stop circle');
  for (const x of c) {
    assert.ok(Math.abs(x.cx - 42) < 1e-6 && Math.abs(x.cy - 17) < 1e-6, `seated at ${x.cx},${x.cy}`);
  }
});
