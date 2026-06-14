import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bendWeight,
  buildOctiGrid,
  BEND_CORRECTION,
  DIRECTIONS,
} from './octiGrid';

test('bend weights are monotone after the no-shortcut correction', () => {
  // turn-step distance is the angle between the two port directions, so the
  // interior path angle is steps·45°: steps=4 is a straight pass-through (180°,
  // cheapest) and steps=1 is the sharpest 45° turn (most expensive).
  const straight = bendWeight(4); // 180° straight-through
  const w135 = bendWeight(3);
  const w90 = bendWeight(2);
  const w45 = bendWeight(1); // sharpest
  assert.ok(straight <= w135 && w135 <= w90 && w90 <= w45);
  assert.ok(straight >= 0); // non-negative so Dijkstra stays valid
});

test('a single base node has 8 ports, 8 sinks, and C(8,2)=28 bend edges', () => {
  const grid = buildOctiGrid({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 10, 0);
  const base = grid.baseNodes[0];
  assert.equal(base.ports.length, 8);
  let sinks = 0;
  let bends = 0;
  for (const e of grid.edges) {
    if (e.kind === 'sink' && e.base === base.id) sinks++;
    if (e.kind === 'bend' && e.base === base.id) bends++;
  }
  assert.equal(sinks, 8);
  assert.equal(bends, 28);
});

test('grid edges keep the 1.0:1.5 axis:diagonal length gap after correction', () => {
  // Raw lengths 1.0/1.5 minus the no-shortcut correction A (=0.75); the 0.5 gap
  // that slightly favours horizontal/vertical travel is preserved.
  const grid = buildOctiGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 10);
  const axis = grid.edges.find((e) => e.kind === 'grid' && e.dir === DIRECTIONS.E);
  const diag = grid.edges.find((e) => e.kind === 'grid' && e.dir === DIRECTIONS.NE);
  assert.ok(axis && diag);
  assert.ok(axis!.w >= 0 && diag!.w >= 0);
  assert.ok(Math.abs((diag!.w - axis!.w) - 0.5) < 1e-9);
  assert.ok(Math.abs(axis!.w - (1.0 - BEND_CORRECTION)) < 1e-9);
});
