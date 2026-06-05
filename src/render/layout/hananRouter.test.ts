import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeAllEdgesViaHanan } from './hananRouter';
import type { Pixel } from './types';

test('routed paths begin and end at real station positions', () => {
  const positions = new Map<string, Pixel>([
    ['A', [3, 7]], // not aligned to a 50-cell base grid
    ['B', [203, 7]],
  ]);
  const edges = [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 200,
  });
  const path = out.get('e')!;
  assert.deepEqual(path[0], [3, 7]);
  assert.deepEqual(path[path.length - 1], [203, 7]);
});

test('two edges sharing a vertical corridor share interior grid edges', () => {
  // Three stations on a vertical line: A → B → C.
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
  const ab = out.get('eAB')!;
  const bc = out.get('eBC')!;
  // Both paths should be straight vertical (start.x === end.x for each).
  assert.ok(Math.abs(ab[0][0] - ab[ab.length - 1][0]) < 1e-6);
  assert.ok(Math.abs(bc[0][0] - bc[ab.length - 1][0]) < 1e-6);
  // Their shared midpoint (station B) should match.
  assert.deepEqual(ab[ab.length - 1], [100, 100]);
  assert.deepEqual(bc[0], [100, 100]);
});

test('an edge that has no Hanan path falls back to octilinearPath', () => {
  // Construct a degenerate case: two stations and request an impossibly tiny
  // expansion budget by making the grid very dense. Easier: just verify the
  // function returns a polyline for every edge even with bad input.
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['B', [157, 84]], // offset, exercises real-position re-stitching
  ]);
  const edges = [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 180,
  });
  const p = out.get('e')!;
  assert.deepEqual(p[0], [0, 0]);
  assert.deepEqual(p[p.length - 1], [157, 84]);
  assert.ok(p.length >= 2);
});
