import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTorontoByNode, type LaneByStop } from '../torontoCross';
import { LINE_WIDTH, LINE_GAP } from '../../constants';
import type { Pixel } from '../types';

type M = { lineId: string; axis?: number; dir?: Pixel; pos: Pixel };
const spacing = LINE_WIDTH + LINE_GAP;
const lanes = (entries: Record<string, Pixel[][]>): LaneByStop => new Map(Object.entries(entries));

test('two ribbons crossing at a wide angle collapse to a dot at the crossing', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [6, 0] },
    { lineId: 'B', axis: 2, pos: [0, 6] },
  ]]]);
  const geo = lanes({ 'n|A': [[[-30, 0], [36, 0]]], 'n|B': [[[0, -24], [0, 36]]] });
  const c = computeTorontoByNode(stops, geo).get('n');
  assert.ok(c && Math.abs(c.cx) < 1e-6 && Math.abs(c.cy) < 1e-6, 'dot at the (0,0) crossing');
});

test('two ribbons that converge and run PARALLEL are not a crossing (kept as a pill)', () => {
  // different run-axes (so the axis gate passes), but the drawn ribbons meet at a
  // shallow angle and run alongside — a merge, not a perfect crossing.
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [0, 0] },
    { lineId: 'B', axis: 2, pos: [0, 2] },
  ]]]);
  const geo = lanes({ 'n|A': [[[-30, 0], [30, 0]]], 'n|B': [[[-30, 18], [0, 2], [30, 1.5]]] });
  assert.equal(computeTorontoByNode(stops, geo).size, 0, 'parallel merge -> pill');
});

test('a parallel two-line bundle (same axis) is gated out before geometry', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [0, 0] },
    { lineId: 'B', axis: 0, pos: [0, spacing] },
  ]]]);
  assert.equal(computeTorontoByNode(stops, lanes({})).size, 0);
});

test('a crossing whose meeting point is out of slide range falls back to a pill', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [0, 0] },
    { lineId: 'B', axis: 2, pos: [0, 0] },
  ]]]);
  // ribbons cross far (x=40) from the stops
  const geo = lanes({ 'n|A': [[[-30, 0], [50, 0]]], 'n|B': [[[40, -30], [40, 30]]] });
  assert.equal(computeTorontoByNode(stops, geo).size, 0, 'meeting too far to slide');
});

test('a three-line star (all different axes through one point) collapses via the tangent test', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [5, 0] },
    { lineId: 'B', axis: 2, pos: [0, 5] },
    { lineId: 'C', axis: 1, pos: [3, 3] },
  ]]]);
  assert.equal(computeTorontoByNode(stops).size, 1);
});

test('single stops and coincident nodes without a real crossing are skipped', () => {
  const stops = new Map<string, M[]>([
    ['single', [{ lineId: 'A', axis: 0, pos: [0, 0] }]],
    ['coincident', [{ lineId: 'A', axis: 0, pos: [0, 0] }, { lineId: 'B', axis: 2, pos: [0, 0] }]],
  ]);
  assert.equal(computeTorontoByNode(stops, lanes({})).size, 0);
});
