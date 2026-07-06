import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestOctilinearUnit, simplifyLayout, smoothGeographic } from './simplify';
import { octilinearLayout } from './octilinear';
import { lineGraph } from './_fixtures';

test('nearestOctilinearUnit snaps to the 8 directions', () => {
  assert.deepEqual(nearestOctilinearUnit(10, 0.5), [1, 0]); // ~East
  const ne = nearestOctilinearUnit(5, 5);
  assert.ok(Math.abs(ne[0] - Math.SQRT1_2) < 1e-9 && Math.abs(ne[1] - Math.SQRT1_2) < 1e-9);
  assert.deepEqual(nearestOctilinearUnit(0, -7), [0, -1]); // South
});

test('nearestOctilinearUnit handles near-zero vectors', () => {
  assert.deepEqual(nearestOctilinearUnit(0, 0), [1, 0]);
});

test('simplifyLayout is deterministic and preserves node ids', () => {
  const graph = lineGraph([
    [0, 0],
    [100, 37],
    [205, 12],
    [300, 95],
  ]);
  const base = octilinearLayout(graph);
  const a = simplifyLayout(base, graph);
  const b = simplifyLayout(base, graph);
  assert.deepEqual([...a.nodes.keys()].sort(), [...graph.nodes.keys()].sort());
  // same input -> same output
  const cellsA = [...a.nodes.values()].map((n) => n.cell);
  const cellsB = [...b.nodes.values()].map((n) => n.cell);
  assert.deepEqual(cellsA, cellsB);
});

test('smoothGeographic keeps nodes near their original positions', () => {
  const graph = lineGraph([
    [0, 0],
    [100, 20],
    [200, -15],
  ]);
  const smoothed = smoothGeographic(graph);
  for (const [id, n] of graph.nodes) {
    const p = smoothed.get(id)!;
    // anchored: displacement stays within one median edge length (~100px)
    assert.ok(Math.hypot(p[0] - n.pos[0], p[1] - n.pos[1]) < 120);
  }
});
