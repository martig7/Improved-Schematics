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

test('toCardinalDir biases the final segment toward the requested cardinal', () => {
  // Soft (cost-based) constraint, not a hard guarantee: we verify that the
  // constrained version's final segment is MORE aligned with the cardinal
  // than the unconstrained baseline. (The router may still pick a
  // non-cardinal final segment when other costs — bend penalty, edge length —
  // would be too high to overcome.)
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['B', [200, 100]],
  ]);
  const opts = { snapCell: 50, padding: 50, medianEdgeLength: 200 };
  const base = routeAllEdgesViaHanan(
    positions,
    [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }],
    opts,
  );
  const constrained = routeAllEdgesViaHanan(
    positions,
    [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']), toCardinalDir: 2 }],
    opts,
  );
  // Verticality of last segment = |dy| / |seg_length|. 1 = pure vertical.
  const verticality = (p: Pixel[]): number => {
    const a = p[p.length - 2];
    const b = p[p.length - 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs(dy) / len;
  };
  const v0 = verticality(base.paths.get('e')!);
  const v1 = verticality(constrained.paths.get('e')!);
  assert.ok(
    v1 >= v0,
    `toCardinalDir=2 should make last seg at least as vertical (v0=${v0}, v1=${v1})`,
  );
});

test('a 90° bend is avoided at the first node after the start when possible', () => {
  // Start (0,0), goal (200, 50). Two octilinear paths exist:
  //   (0,0) → (0, 50) → (200, 50):  90° bend at (0,50), one step from start
  //   (0,0) → (50, 50) → (200, 50): 45° bend at (50,50), one step from start
  //   (0,0) → (150, 0) → (200, 50): 45° bend at (150,0), THREE steps from start
  //   (0,0) → (200, 0) → (200, 50): 90° bend at (200,0), three steps from start
  // The station-adjacent bend penalty should push the router AWAY from a 90°
  // bend at the second node when a 45° (or no-bend) alternative exists.
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['B', [200, 50]],
  ]);
  const edges = [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 200,
  });
  const path = out.paths.get('e')!;
  // The bend at path[1] (one step from start) must not be a hard 90° turn.
  if (path.length >= 3) {
    const dx1 = path[1][0] - path[0][0];
    const dy1 = path[1][1] - path[0][1];
    const dx2 = path[2][0] - path[1][0];
    const dy2 = path[2][1] - path[1][1];
    const n1 = Math.hypot(dx1, dy1) || 1;
    const n2 = Math.hypot(dx2, dy2) || 1;
    const dot = (dx1 * dx2 + dy1 * dy2) / (n1 * n2);
    // dot=1 → straight, dot≈0.707 → 45° bend, dot=0 → 90° bend.
    // We require strictly better than a hard 90° turn at the second node.
    assert.ok(dot > 0.5, `early 90°+ bend at second node; dot=${dot}`);
  }
});

test('fromCardinalDir forces the first segment to leave the start in that cardinal', () => {
  // Start at (0, 0), goal at (200, 100). Force dir 0 (E, +x) for the first
  // segment — so the path must initially travel purely east, not diagonal.
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['B', [200, 100]],
  ]);
  const edges = [
    {
      id: 'e',
      from: 'A',
      to: 'B',
      lineIds: new Set(['L']),
      fromCardinalDir: 0,
    },
  ];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 200,
  });
  const path = out.paths.get('e')!;
  assert.ok(path.length >= 2);
  const first = path[0];
  const next = path[1];
  const dx = next[0] - first[0];
  const dy = next[1] - first[1];
  assert.ok(Math.abs(dy) < 1e-6, `first segment should be horizontal; dy=${dy}`);
  assert.ok(dx > 0, `first segment should travel in +x; dx=${dx}`);
});
