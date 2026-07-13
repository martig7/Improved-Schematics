import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTorontoByNode } from '../torontoCross';
import { LINE_WIDTH, LINE_GAP } from '../../constants';

type M = { axis?: number; pos: [number, number]; mega?: boolean };
const spacing = LINE_WIDTH + LINE_GAP;

test('a two-line X (different axes meeting at a point) collapses to one crossing dot', () => {
  // horizontal line through y=0 (axis 0), vertical line through x=0 (axis 2)
  const stops = new Map<string, M[]>([['n', [
    { axis: 0, pos: [6, 0] },
    { axis: 2, pos: [0, 6] },
  ]]]);
  const out = computeTorontoByNode(stops);
  assert.equal(out.size, 1);
  const c = out.get('n')!;
  assert.ok(Math.abs(c.cx) < 1e-6 && Math.abs(c.cy) < 1e-6, 'crossing dot at the intersection (0,0)');
});

test('a parallel two-line bundle (same axis) is NOT a crossing', () => {
  const stops = new Map<string, M[]>([['n', [
    { axis: 0, pos: [0, 0] },
    { axis: 0, pos: [0, spacing] }, // one slot apart, parallel
  ]]]);
  assert.equal(computeTorontoByNode(stops).size, 0);
});

test('a junction with a parallel pair (a wide cover) is NOT a crossing', () => {
  // two parallel horizontals a slot apart, plus one vertical: the parallel pair
  // forces the cover wide, so no single tight dot covers all three.
  const stops = new Map<string, M[]>([['n', [
    { axis: 0, pos: [0, 0] },
    { axis: 0, pos: [0, spacing] },
    { axis: 2, pos: [0, spacing / 2] },
  ]]]);
  assert.equal(computeTorontoByNode(stops).size, 0);
});

test('a three-line star (all different axes through one point) collapses', () => {
  const stops = new Map<string, M[]>([['n', [
    { axis: 0, pos: [5, 0] },
    { axis: 2, pos: [0, 5] },
    { axis: 1, pos: [3, 3] }, // diagonal through the origin
  ]]]);
  assert.equal(computeTorontoByNode(stops).size, 1);
});

test('the crossing dot sits at the EXACT-tangent intersection, not the quantized-axis one', () => {
  // line A is vertical (x = 5); line B passes through the origin angled below its
  // quantized (horizontal) axis, so the true meeting point is above y = 0.
  const stops = new Map<string, M[]>([['n', [
    { axis: 2, dir: [0, 1], pos: [5, 0] } as M,
    { axis: 0, dir: [0.94, 0.35], pos: [0, 0] } as M,
  ]]]);
  const c = computeTorontoByNode(stops).get('n');
  assert.ok(c, 'still detected as a crossing');
  assert.ok(Math.abs(c!.cx - 5) < 1e-6, 'on the vertical line x=5');
  // exact intersection: 0.94*s = 5 -> s = 5.319, y = 0.35*s = 1.862 (NOT 0)
  assert.ok(Math.abs(c!.cy - 1.862) < 0.01, `exact-tangent y ~1.86, got ${c!.cy.toFixed(3)}`);
});

test('a shallow convergence whose meeting point is out of slide range is NOT a crossing', () => {
  const stops = new Map<string, M[]>([['n', [
    { axis: 0, dir: [1, 0], pos: [0, 0] } as M,
    { axis: 1, dir: [0.7071, 0.7071], pos: [0, 40] } as M, // meets line A ~40px away
  ]]]);
  assert.equal(computeTorontoByNode(stops).size, 0, 'too far to slide -> pill fallback');
});

test('single stops and mega nodes are skipped', () => {
  const stops = new Map<string, M[]>([
    ['single', [{ axis: 0, pos: [0, 0] }]],
    ['mega', [{ axis: 0, pos: [0, 0], mega: true }, { axis: 2, pos: [0, 0], mega: true }]],
  ]);
  assert.equal(computeTorontoByNode(stops).size, 0);
});
