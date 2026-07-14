import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTorontoByNode, type LaneSegsAt } from '../torontoCross';
import { LINE_WIDTH, LINE_GAP } from '../../constants';

type P = [number, number];
type M = { lineId: string; axis?: number; dir?: P; pos: P; mega?: boolean };
const spacing = LINE_WIDTH + LINE_GAP;

// Mock drawn lanes: a straight segment through each mark along its tangent
// (defaulting to its axis), clipped to the requested window. Good enough to
// stand in for the real ribbon segments for the two-line meeting test.
const AXIS: P[] = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071]];
function mockLanes(stops: Map<string, M[]>): LaneSegsAt {
  const byLine = new Map<string, M>();
  for (const marks of stops.values()) for (const m of marks) byLine.set(m.lineId, m);
  return (lineId, pos, win) => {
    const m = byLine.get(lineId);
    if (!m) return [];
    const d = m.dir ?? AXIS[((m.axis ?? 0) % 4 + 4) % 4];
    return [[[pos[0] - win * d[0], pos[1] - win * d[1]], [pos[0] + win * d[0], pos[1] + win * d[1]]]];
  };
}
const run = (stops: Map<string, M[]>) => computeTorontoByNode(stops, mockLanes(stops));

test('a two-line X (different axes meeting at a point) collapses to one crossing dot', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, dir: [1, 0], pos: [6, 0] },
    { lineId: 'B', axis: 2, dir: [0, 1], pos: [0, 6] },
  ]]]);
  const out = run(stops);
  assert.equal(out.size, 1);
  const c = out.get('n')!;
  assert.ok(Math.abs(c.cx) < 1e-6 && Math.abs(c.cy) < 1e-6, 'crossing dot at the intersection (0,0)');
});

test('a parallel two-line bundle (same axis) is NOT a crossing', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, dir: [1, 0], pos: [0, 0] },
    { lineId: 'B', axis: 0, dir: [1, 0], pos: [0, spacing] },
  ]]]);
  assert.equal(run(stops).size, 0);
});

test('a junction with a parallel pair (a wide cover) is NOT a crossing', () => {
  // two parallel horizontals a slot apart, plus one vertical (three lines -> the
  // coverCenter path); the parallel pair forces the cover wide, so no single dot.
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [0, 0] },
    { lineId: 'B', axis: 0, pos: [0, spacing] },
    { lineId: 'C', axis: 2, pos: [0, spacing / 2] },
  ]]]);
  assert.equal(run(stops).size, 0);
});

test('a three-line star (all different axes through one point) collapses', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, pos: [5, 0] },
    { lineId: 'B', axis: 2, pos: [0, 5] },
    { lineId: 'C', axis: 1, pos: [3, 3] },
  ]]]);
  assert.equal(run(stops).size, 1);
});

test('the crossing dot sits where the DRAWN lanes meet, not on the straight-tangent estimate', () => {
  // line A vertical (x = 5); line B through the origin angled below its quantized
  // (horizontal) axis, so the true meeting is above y = 0.
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 2, dir: [0, 1], pos: [5, 0] },
    { lineId: 'B', axis: 0, dir: [0.94, 0.35], pos: [0, 0] },
  ]]]);
  const c = run(stops).get('n');
  assert.ok(c, 'still detected as a crossing');
  assert.ok(Math.abs(c!.cx - 5) < 1e-6, 'on the vertical line x=5');
  // exact intersection: 0.94*s = 5 -> s = 5.319, y = 0.35*s = 1.862 (NOT 0)
  assert.ok(Math.abs(c!.cy - 1.862) < 0.01, `drawn-meeting y ~1.86, got ${c!.cy.toFixed(3)}`);
});

test('a shallow convergence whose meeting point is out of slide range is NOT a crossing', () => {
  const stops = new Map<string, M[]>([['n', [
    { lineId: 'A', axis: 0, dir: [1, 0], pos: [0, 0] },
    { lineId: 'B', axis: 1, dir: [0.7071, 0.7071], pos: [0, 40] }, // meets line A ~40px away
  ]]]);
  assert.equal(run(stops).size, 0, 'too far to slide -> pill fallback');
});

test('single stops and mega nodes are skipped', () => {
  const stops = new Map<string, M[]>([
    ['single', [{ lineId: 'A', axis: 0, pos: [0, 0] }]],
    ['mega', [{ lineId: 'A', axis: 0, pos: [0, 0], mega: true }, { lineId: 'B', axis: 2, pos: [0, 0], mega: true }]],
  ]);
  assert.equal(run(stops).size, 0);
});
