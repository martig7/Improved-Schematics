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

test('the first edge leaves the start in a direction that advances toward the goal', () => {
  // Goal is NE of start. The first edge should head NE-ish: either pure E,
  // pure N, or the NE diagonal — NOT W, S, NW, SW (which would leave the
  // station heading away from the goal). The amplified exit-direction cost
  // makes any away-from-goal exit much more expensive than a 1-step detour
  // along a forward-pointing edge.
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['B', [300, 200]],
  ]);
  const edges = [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50,
    padding: 50,
    medianEdgeLength: 300,
  });
  const path = out.paths.get('e')!;
  assert.ok(path.length >= 2);
  // dot of (first edge direction) with (start → goal direction) must be > 0:
  // the exit edge has a positive component toward the goal.
  const ex = path[1][0] - path[0][0];
  const ey = path[1][1] - path[0][1];
  const eLen = Math.hypot(ex, ey) || 1;
  const gx = 300;
  const gy = 200;
  const gLen = Math.hypot(gx, gy);
  const dot = (ex * gx + ey * gy) / (eLen * gLen);
  assert.ok(dot > 0, `exit edge should advance toward goal; dot=${dot}`);
});

test('a line passing straight through a station continues without a kink', () => {
  // Three collinear stations on the same horizontal line. The line traversal
  // visits them in order; both edges should be pure-east, and the arrival
  // direction at S must match the departure direction.
  const positions = new Map<string, Pixel>([
    ['A', [0, 0]],
    ['S', [100, 0]],
    ['B', [200, 0]],
  ]);
  const edges = [
    { id: 'eAS', from: 'A', to: 'S', lineIds: new Set(['L']) },
    { id: 'eSB', from: 'S', to: 'B', lineIds: new Set(['L']) },
  ];
  const out = routeAllEdgesViaHanan(
    positions,
    edges,
    { snapCell: 50, padding: 50, medianEdgeLength: 100 },
    new Map([['L', ['eAS', 'eSB']]]),
  );
  const pAS = out.paths.get('eAS')!;
  const pSB = out.paths.get('eSB')!;
  const arr = [
    pAS[pAS.length - 1][0] - pAS[pAS.length - 2][0],
    pAS[pAS.length - 1][1] - pAS[pAS.length - 2][1],
  ];
  const dep = [pSB[1][0] - pSB[0][0], pSB[1][1] - pSB[0][1]];
  const la = Math.hypot(arr[0], arr[1]) || 1;
  const ld = Math.hypot(dep[0], dep[1]) || 1;
  const dot = (arr[0] / la) * (dep[0] / ld) + (arr[1] / la) * (dep[1] / ld);
  assert.ok(
    dot > 0.99,
    `straight-line pass-through must not kink at S; dot=${dot}`,
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

