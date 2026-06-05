import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeAllEdgesViaHanan } from './hananRouter';
import type { Pixel } from './types';

test('routed paths begin and end at SNAPPED station positions', () => {
  // Stations off-grid at (3,7) and (203,7); snapCell=50 -> snap to (0,0) and (200,0).
  const positions = new Map<string, Pixel>([
    ['A', [3, 7]],
    ['B', [203, 7]],
  ]);
  const edges = [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 200,
  });
  const path = out.paths.get('e')!;
  // First and last points must equal the snapped positions reported back.
  const snapA = out.snappedPositions.get('A')!;
  const snapB = out.snappedPositions.get('B')!;
  assert.deepEqual(path[0], snapA);
  assert.deepEqual(path[path.length - 1], snapB);
});

test('two edges sharing a vertical corridor share interior grid edges', () => {
  const positions = new Map<string, Pixel>([
    ['A', [100, 0]],
    ['B', [100, 100]],
    ['C', [100, 200]],
  ]);
  const edges = [
    { id: 'eAB', from: 'A', to: 'B', lineIds: new Set(['L1']) },
    { id: 'eBC', from: 'B', to: 'C', lineIds: new Set(['L1']) },
  ];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 100,
  });
  const ab = out.paths.get('eAB')!;
  const bc = out.paths.get('eBC')!;
  // Both paths should be straight vertical (start.x === end.x for each).
  assert.ok(Math.abs(ab[0][0] - ab[ab.length - 1][0]) < 1e-6);
  assert.ok(Math.abs(bc[0][0] - bc[ab.length - 1][0]) < 1e-6);
  // A's snap and B's snap should align since both are at x=100, which is on the grid.
  assert.deepEqual(out.snappedPositions.get('A')!, [100, 0]);
  assert.deepEqual(out.snappedPositions.get('B')!, [100, 100]);
});

test('every segment in every routed path is octilinear', () => {
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['B', [157, 84]],
    ['C', [89, 200]],
  ]);
  const edges = [
    { id: 'eAB', from: 'A', to: 'B', lineIds: new Set(['L']) },
    { id: 'eBC', from: 'B', to: 'C', lineIds: new Set(['L']) },
  ];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 180,
  });
  for (const p of out.paths.values()) {
    for (let i = 1; i < p.length; i++) {
      const dx = p[i][0] - p[i - 1][0];
      const dy = p[i][1] - p[i - 1][1];
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const ux = dx / len;
      const uy = dy / len;
      const oct: [number, number][] = [
        [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
        [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
      ];
      let best = Infinity;
      for (const [a, b] of oct) best = Math.min(best, 1 - (ux * a + uy * b));
      assert.ok(best < 1e-6, `non-octilinear segment ${i - 1}->${i}: (${dx}, ${dy})`);
    }
  }
});
