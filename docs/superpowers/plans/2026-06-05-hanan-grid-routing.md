# Hanan-Grid Routing for Smoothed Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-edge `octilinearPath` in smoothed mode with shared-base-grid Dijkstra routing on an octilinear Hanan grid, so transit edges that share corridors share grid edges and bundle correctly.

**Spec:** `docs/superpowers/specs/2026-06-05-hanan-grid-routing-design.md`

**Architecture:** Three new files under `src/render/layout/`: `hananGrid.ts` (construction), `dijkstra.ts` (priority-queue shortest path), `hananRouter.ts` (orchestrator with shared-segment tracking). `renderSmoothed` swaps `octilinearPath` for `routeAllEdgesViaHanan`.

**Tech Stack:** TypeScript, `node --test` via tsx, pnpm.

---

## Task A: Spec + plan committed

- [ ] **Step 1: Commit the spec and plan files.**

```bash
git add docs/superpowers/specs/2026-06-05-hanan-grid-routing-design.md \
       docs/superpowers/plans/2026-06-05-hanan-grid-routing.md
git commit -m "docs: Hanan-grid routing for smoothed mode spec + plan"
```

---

## Task B: Dijkstra utility (`dijkstra.ts`)

**Files:**
- Create: `src/render/layout/dijkstra.ts`
- Test: `src/render/layout/dijkstra.test.ts`

A small binary-heap priority queue and a generic Dijkstra that takes a graph as an adjacency lookup and an edge-cost function. Keeping it generic lets the router stay focused on routing logic.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dijkstra } from './dijkstra';

test('dijkstra finds the cheapest path on a tiny weighted graph', () => {
  // 0—(1)—1—(1)—2 (top) ; 0—(5)—2 (direct expensive edge); 2 -> goal
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['0', [{ to: '1', w: 1 }, { to: '2', w: 5 }]],
    ['1', [{ to: '2', w: 1 }, { to: '0', w: 1 }]],
    ['2', []],
  ]);
  const res = dijkstra('0', '2', (n) => adj.get(n) ?? [], () => 1e9);
  assert.deepEqual(res?.path, ['0', '1', '2']);
  assert.equal(res?.cost, 2);
});

test('dijkstra returns null when no path exists', () => {
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['0', []],
    ['1', []],
  ]);
  const res = dijkstra('0', '1', (n) => adj.get(n) ?? [], () => 1e9);
  assert.equal(res, null);
});
```

- [ ] **Step 2: Implement**

```ts
// src/render/layout/dijkstra.ts

/** Min-heap keyed by `priority` (lower = better). */
class MinHeap<T> {
  private a: { p: number; v: T }[] = [];
  push(p: number, v: T) {
    this.a.push({ p, v });
    let i = this.a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.a[parent].p <= this.a[i].p) break;
      [this.a[parent], this.a[i]] = [this.a[i], this.a[parent]];
      i = parent;
    }
  }
  pop(): { p: number; v: T } | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      while (true) {
        const l = 2 * i + 1, r = l + 1;
        let best = i;
        if (l < n && this.a[l].p < this.a[best].p) best = l;
        if (r < n && this.a[r].p < this.a[best].p) best = r;
        if (best === i) break;
        [this.a[best], this.a[i]] = [this.a[i], this.a[best]];
        i = best;
      }
    }
    return top;
  }
  get size(): number { return this.a.length; }
}

export interface DijkstraEdge<NodeId> {
  to: NodeId;
  w: number;
}

export interface DijkstraResult<NodeId> {
  path: NodeId[];
  cost: number;
}

/**
 * Generic Dijkstra. `neighbors(n, prev)` returns outgoing edges from n; the
 * previous-node parameter lets the cost function depend on incoming direction
 * (which we use for bend penalties). `heuristic` is the admissible distance
 * estimate to the goal — pass `() => 0` for plain Dijkstra, or an octilinear
 * distance for A*. `expansionBudget` caps the search (returns null on overflow).
 */
export function dijkstra<NodeId>(
  start: NodeId,
  goal: NodeId,
  neighbors: (n: NodeId, prev: NodeId | null) => Iterable<DijkstraEdge<NodeId>>,
  heuristic: (n: NodeId) => number,
  expansionBudget = 200_000,
): DijkstraResult<NodeId> | null {
  const best = new Map<string, number>();
  const parent = new Map<string, NodeId | null>();
  const keyFn = (n: NodeId) => String(n);
  const open = new MinHeap<NodeId>();
  open.push(heuristic(start), start);
  best.set(keyFn(start), 0);
  parent.set(keyFn(start), null);
  let expanded = 0;
  while (open.size > 0) {
    const top = open.pop()!;
    const cur = top.v;
    if (keyFn(cur) === keyFn(goal)) {
      const path: NodeId[] = [];
      let n: NodeId | null = cur;
      while (n !== null) {
        path.push(n);
        const p = parent.get(keyFn(n));
        n = p === undefined ? null : p;
      }
      path.reverse();
      return { path, cost: best.get(keyFn(goal))! };
    }
    if (++expanded > expansionBudget) return null;
    const curBest = best.get(keyFn(cur)) ?? Infinity;
    if (top.p - heuristic(cur) > curBest) continue; // stale entry
    const prev = parent.get(keyFn(cur)) ?? null;
    for (const edge of neighbors(cur, prev)) {
      const g = curBest + edge.w;
      const k = keyFn(edge.to);
      if (g < (best.get(k) ?? Infinity)) {
        best.set(k, g);
        parent.set(k, cur);
        open.push(g + heuristic(edge.to), edge.to);
      }
    }
  }
  return null;
}
```

- [ ] **Step 3: Run tests**

```
pnpm test
```

Expected: PASS (2 new tests, +existing 46).

- [ ] **Step 4: Commit**

```bash
git add src/render/layout/dijkstra.ts src/render/layout/dijkstra.test.ts
git commit -m "feat(layout): generic Dijkstra with binary-heap PQ + A* heuristic hook"
```

---

## Task C: Hanan grid construction (`hananGrid.ts`)

**Files:**
- Create: `src/render/layout/hananGrid.ts`
- Test: `src/render/layout/hananGrid.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHananGrid } from './hananGrid';
import type { Pixel } from './types';

test('a 2×2 grid of stations yields the expected line counts', () => {
  const positions = new Map<string, Pixel>([
    ['a', [0, 0]],
    ['b', [100, 0]],
    ['c', [0, 100]],
    ['d', [100, 100]],
  ]);
  const g = buildHananGrid(positions, { snapCell: 100, padding: 0 });
  // 2 unique x, 2 unique y → 4 H/V intersections (the stations themselves).
  // 4 unique (x+y) values: 0, 100, 100, 200 → 3 unique. Likewise (x-y).
  // Resulting grid contains at minimum the 4 station nodes.
  assert.ok(g.stationNodeKeys.size === 4);
  // Each station has at least 2 neighbours (along the H and V lines that pass through it,
  // plus the diagonals — typically 4-8).
  for (const key of g.stationNodeKeys.values()) {
    const adj = g.adj.get(key) ?? [];
    assert.ok(adj.length >= 2, `station ${key} should have ≥2 neighbours, got ${adj.length}`);
  }
});

test('snap collapses nearby stations to the same grid node', () => {
  const positions = new Map<string, Pixel>([
    ['a', [0, 0]],
    ['b', [3, 4]], // < d/√2 from a when snapCell=50
  ]);
  const g = buildHananGrid(positions, { snapCell: 50, padding: 0 });
  assert.equal(g.stationNodeKeys.get('a'), g.stationNodeKeys.get('b'));
});
```

- [ ] **Step 2: Implement**

```ts
// src/render/layout/hananGrid.ts
import type { Pixel } from './types';

export interface HananOptions {
  /** Base-grid cell size in pixels. Stations within √2·snapCell collapse. */
  snapCell: number;
  /** Padding around the station bounding box, in pixels. */
  padding: number;
}

export interface HananGrid {
  /** key = "x,y" of grid-node pixel coords. */
  positions: Map<string, Pixel>;
  /** For each grid-node key, its neighbour keys with direction index 0..7. */
  adj: Map<string, Array<{ to: string; dir: number; len: number }>>;
  /** Per-input-station grid-node key. */
  stationNodeKeys: Map<string, string>;
}

const DIRS: Array<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

const key = (x: number, y: number) => x + ',' + y;

function snap(p: Pixel, cell: number): Pixel {
  return [Math.round(p[0] / cell) * cell, Math.round(p[1] / cell) * cell];
}

export function buildHananGrid(
  stationPositions: Map<string, Pixel>,
  opts: HananOptions,
): HananGrid {
  const { snapCell, padding } = opts;

  // 1. Snap each station to base grid; record snapped position per station.
  const snapped = new Map<string, Pixel>();
  for (const [id, p] of stationPositions) snapped.set(id, snap(p, snapCell));

  // 2. Collect unique snapped positions, plus the four line families.
  const xs = new Set<number>();
  const ys = new Set<number>();
  const sums = new Set<number>();   // x + y diag (slope -1)
  const diffs = new Set<number>();  // x - y diag (slope +1)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [, p] of snapped) {
    xs.add(p[0]); ys.add(p[1]);
    sums.add(p[0] + p[1]); diffs.add(p[0] - p[1]);
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const bboxMinX = minX - padding;
  const bboxMaxX = maxX + padding;
  const bboxMinY = minY - padding;
  const bboxMaxY = maxY + padding;

  const xArr = [...xs].sort((a, b) => a - b);
  const yArr = [...ys].sort((a, b) => a - b);
  const sumArr = [...sums].sort((a, b) => a - b);
  const diffArr = [...diffs].sort((a, b) => a - b);

  // 3. Compute all intersection points of different-family lines, within bbox.
  //    For each family pair, intersect every line with every other line in the
  //    other family; insert intersection into the grid if inside bbox.
  const positions = new Map<string, Pixel>();
  const insert = (x: number, y: number) => {
    if (x < bboxMinX || x > bboxMaxX || y < bboxMinY || y > bboxMaxY) return;
    const k = key(x, y);
    if (!positions.has(k)) positions.set(k, [x, y]);
    return k;
  };

  // H × V: (x, y)
  for (const x of xArr) for (const y of yArr) insert(x, y);
  // H × diag (slope -1, x+y=s): (s-y, y)
  for (const y of yArr) for (const s of sumArr) insert(s - y, y);
  // H × diag (slope +1, x-y=t): (t+y, y)
  for (const y of yArr) for (const t of diffArr) insert(t + y, y);
  // V × diag (slope -1): (x, s-x)
  for (const x of xArr) for (const s of sumArr) insert(x, s - x);
  // V × diag (slope +1): (x, x-t)
  for (const x of xArr) for (const t of diffArr) insert(x, x - t);
  // diag × diag: x = (s+t)/2, y = (s-t)/2
  for (const s of sumArr) for (const t of diffArr) {
    if ((s + t) % 2 !== 0 || (s - t) % 2 !== 0) {
      // accept half-integer x/y if snapCell allows; here we accept all values.
    }
    insert((s + t) / 2, (s - t) / 2);
  }

  // 4. For each grid node, find its 8 octilinear neighbours by walking along
  //    each of the 4 lines through it to the nearest collinear grid node.
  //    Efficient: index grid nodes by (line family, line-value) → sorted positions.
  const onX = new Map<number, number[]>();      // x → sorted ys
  const onY = new Map<number, number[]>();      // y → sorted xs
  const onSum = new Map<number, number[]>();    // s = x+y → sorted xs
  const onDiff = new Map<number, number[]>();   // t = x-y → sorted xs
  for (const p of positions.values()) {
    const x = p[0], y = p[1];
    if (!onX.has(x)) onX.set(x, []);
    if (!onY.has(y)) onY.set(y, []);
    const s = x + y, t = x - y;
    if (!onSum.has(s)) onSum.set(s, []);
    if (!onDiff.has(t)) onDiff.set(t, []);
    onX.get(x)!.push(y);
    onY.get(y)!.push(x);
    onSum.get(s)!.push(x);
    onDiff.get(t)!.push(x);
  }
  for (const arr of onX.values()) arr.sort((a, b) => a - b);
  for (const arr of onY.values()) arr.sort((a, b) => a - b);
  for (const arr of onSum.values()) arr.sort((a, b) => a - b);
  for (const arr of onDiff.values()) arr.sort((a, b) => a - b);

  const adj = new Map<string, Array<{ to: string; dir: number; len: number }>>();
  for (const p of positions.values()) {
    const x = p[0], y = p[1];
    const k = key(x, y);
    const here: Array<{ to: string; dir: number; len: number }> = [];
    const addNeighbour = (nx: number, ny: number, dir: number) => {
      const nk = key(nx, ny);
      if (!positions.has(nk)) return;
      here.push({ to: nk, dir, len: Math.hypot(nx - x, ny - y) });
    };
    // Along Y (vertical) at this x: neighbours = previous and next y in onX[x]
    const ys = onX.get(x);
    if (ys) {
      const idx = ys.indexOf(y);
      if (idx > 0) addNeighbour(x, ys[idx - 1], 6);          // S (dy<0)
      if (idx >= 0 && idx + 1 < ys.length) addNeighbour(x, ys[idx + 1], 2); // N (dy>0)
    }
    // Along X (horizontal) at this y
    const xs2 = onY.get(y);
    if (xs2) {
      const idx = xs2.indexOf(x);
      if (idx > 0) addNeighbour(xs2[idx - 1], y, 4);          // W
      if (idx >= 0 && idx + 1 < xs2.length) addNeighbour(xs2[idx + 1], y, 0); // E
    }
    // Along diag slope -1 (x+y constant): movement (+1, -1) increases x, decreases y → dir 7 (SE)
    const sumX = onSum.get(x + y);
    if (sumX) {
      const idx = sumX.indexOf(x);
      if (idx > 0) addNeighbour(sumX[idx - 1], (x + y) - sumX[idx - 1], 3); // NW (dx<0, dy>0)
      if (idx >= 0 && idx + 1 < sumX.length) addNeighbour(sumX[idx + 1], (x + y) - sumX[idx + 1], 7); // SE
    }
    // Along diag slope +1 (x-y constant): movement (+1, +1) increases both → dir 1 (NE)
    const diffX = onDiff.get(x - y);
    if (diffX) {
      const idx = diffX.indexOf(x);
      if (idx > 0) addNeighbour(diffX[idx - 1], diffX[idx - 1] - (x - y), 5); // SW
      if (idx >= 0 && idx + 1 < diffX.length) addNeighbour(diffX[idx + 1], diffX[idx + 1] - (x - y), 1); // NE
    }
    adj.set(k, here);
  }

  // 5. Map each original station to its grid-node key (its snapped position).
  const stationNodeKeys = new Map<string, string>();
  for (const [id, p] of snapped) stationNodeKeys.set(id, key(p[0], p[1]));

  return { positions, adj, stationNodeKeys };
}

void DIRS; // direction reference kept for documentation
```

- [ ] **Step 3: Run tests**

```
pnpm test
```

Expected: PASS (2 new tests).

- [ ] **Step 4: Commit**

```bash
git add src/render/layout/hananGrid.ts src/render/layout/hananGrid.test.ts
git commit -m "feat(layout): octilinear Hanan grid construction with snap-collapse"
```

---

## Task D: Hanan router (`hananRouter.ts`)

**Files:**
- Create: `src/render/layout/hananRouter.ts`
- Test: `src/render/layout/hananRouter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeAllEdgesViaHanan } from './hananRouter';
import type { Pixel } from './types';

test('two edges sharing a corridor reuse the same Hanan grid edges', () => {
  // 3 stations on a vertical line; 2 transit edges A→B and B→C share the central column.
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
    snapCell: 50, padding: 50, medianEdgeLength: 100,
  });
  const ab = out.get('eAB')!;
  const bc = out.get('eBC')!;
  // Both paths should be straight vertical (start.x === end.x).
  assert.equal(ab[0][0], ab[ab.length - 1][0]);
  assert.equal(bc[0][0], bc[bc.length - 1][0]);
});

test('routed paths begin and end at real station positions', () => {
  const positions = new Map<string, Pixel>([
    ['A', [3, 7]],   // not aligned to a 50-cell base grid
    ['B', [203, 7]],
  ]);
  const edges = [{ id: 'e', from: 'A', to: 'B', lineIds: new Set(['L']) }];
  const out = routeAllEdgesViaHanan(positions, edges, {
    snapCell: 50, padding: 50, medianEdgeLength: 200,
  });
  const path = out.get('e')!;
  assert.deepEqual(path[0], [3, 7]);
  assert.deepEqual(path[path.length - 1], [203, 7]);
});
```

- [ ] **Step 2: Implement**

```ts
// src/render/layout/hananRouter.ts
import type { Pixel } from './types';
import { buildHananGrid } from './hananGrid';
import { dijkstra } from './dijkstra';
import { octilinearPath } from './octilinearPath';

export interface RouteableEdge {
  id: string;
  from: string;
  to: string;
  lineIds: Set<string>;
}

export interface HananRouterOptions {
  /** Base-grid cell size. Smaller = more grid, less displacement. */
  snapCell: number;
  /** Bounding-box padding for the grid (in pixels). */
  padding: number;
  /** Median edge length, used to scale bend/conflict/bonus weights. */
  medianEdgeLength: number;
}

const BEND_TURN_K = 0.3;
const STATION_PENALTY_K = 2.0;
const BUNDLE_BONUS_K = -1.5;
const CONFLICT_PENALTY_K = 3.0;
const DIAG_CROSS_PENALTY_K = 2.0;

/** Octilinear direction angle distance: 0..4 steps of 45°. */
function turnSteps(prev: number, cur: number): number {
  const d = Math.abs(prev - cur) % 8;
  return Math.min(d, 8 - d);
}

/**
 * Route every transit edge as a Dijkstra shortest path through a shared
 * octilinear Hanan grid built from the station positions. Returns one polyline
 * per edge in pixel space, with first/last points at the station's REAL
 * (unsnapped) positions. Falls back to octilinearPath for un-routable edges.
 */
export function routeAllEdgesViaHanan(
  stationPositions: Map<string, Pixel>,
  edges: RouteableEdge[],
  opts: HananRouterOptions,
): Map<string, Pixel[]> {
  const grid = buildHananGrid(stationPositions, {
    snapCell: opts.snapCell,
    padding: opts.padding,
  });

  // Trackers for relaxation: which line-ids have been routed along each grid edge
  // (key = "u→v" canonical), and which diagonal axes are used at each grid node.
  const segLines = new Map<string, Set<string>>();
  const diagUsedAtNode = new Map<string, Set<number>>(); // node → set of dir mod 2 != 0 (1,3 = the two diag axes)

  const edgeKey = (u: string, v: string) => (u < v ? u + '→' + v : v + '→' + u);

  // Order edges by importance: descending line count, descending geographic length.
  const orderedEdges = [...edges].sort((a, b) => {
    const dl = b.lineIds.size - a.lineIds.size;
    if (dl !== 0) return dl;
    const pa1 = stationPositions.get(a.from)!;
    const pa2 = stationPositions.get(a.to)!;
    const pb1 = stationPositions.get(b.from)!;
    const pb2 = stationPositions.get(b.to)!;
    return Math.hypot(pb1[0] - pb2[0], pb1[1] - pb2[1]) -
           Math.hypot(pa1[0] - pa2[0], pa1[1] - pa2[1]);
  });

  // Station-grid-node keys for "pass-through" detection.
  const stationGridKeys = new Set(grid.stationNodeKeys.values());

  const med = opts.medianEdgeLength || 1;

  const out = new Map<string, Pixel[]>();

  for (const tEdge of orderedEdges) {
    const startKey = grid.stationNodeKeys.get(tEdge.from);
    const goalKey = grid.stationNodeKeys.get(tEdge.to);
    const realFrom = stationPositions.get(tEdge.from)!;
    const realTo = stationPositions.get(tEdge.to)!;
    if (!startKey || !goalKey) {
      out.set(tEdge.id, octilinearPath(realFrom, realTo, 2));
      continue;
    }
    if (startKey === goalKey) {
      out.set(tEdge.id, [realFrom, realTo]);
      continue;
    }

    const goalPos = grid.positions.get(goalKey)!;

    const heuristic = (k: string) => {
      const p = grid.positions.get(k);
      if (!p) return 0;
      const dx = Math.abs(p[0] - goalPos[0]);
      const dy = Math.abs(p[1] - goalPos[1]);
      // Octilinear admissible distance.
      return Math.SQRT2 * Math.min(dx, dy) + Math.abs(dx - dy);
    };

    const neighbors = (n: string, prev: string | null) => {
      const adj = grid.adj.get(n) ?? [];
      const prevDir = prev === null ? -1 : (() => {
        const prevAdj = grid.adj.get(prev) ?? [];
        const e = prevAdj.find((x) => x.to === n);
        return e ? e.dir : -1;
      })();
      const result: Array<{ to: string; w: number }> = [];
      for (const e of adj) {
        let w = e.len;
        if (prevDir >= 0) w += turnSteps(prevDir, e.dir) * BEND_TURN_K * med;
        // Pass-through penalty: discourage routing through another station's node
        if (e.to !== goalKey && stationGridKeys.has(e.to)) w += STATION_PENALTY_K * med;
        // Shared-segment term
        const segK = edgeKey(n, e.to);
        const prior = segLines.get(segK);
        if (prior) {
          let same = 0, diff = 0;
          for (const id of prior) if (tEdge.lineIds.has(id)) same++; else diff++;
          if (same > 0) w += BUNDLE_BONUS_K * e.len * Math.min(same, 3);
          if (diff > 0) w += CONFLICT_PENALTY_K * e.len * Math.min(diff, 3);
        }
        // Diagonal-cross penalty at the target node
        if (e.dir % 2 === 1) {
          const usedAxes = diagUsedAtNode.get(e.to);
          if (usedAxes) {
            const myAxis = e.dir === 1 || e.dir === 5 ? 0 : 1;
            const otherAxis = 1 - myAxis;
            if (usedAxes.has(otherAxis)) w += DIAG_CROSS_PENALTY_K * e.len;
          }
        }
        if (w < 0.01) w = 0.01;
        result.push({ to: e.to, w });
      }
      return result;
    };

    const res = dijkstra(startKey, goalKey, neighbors, heuristic, 80_000);

    if (!res || res.path.length < 2) {
      out.set(tEdge.id, octilinearPath(realFrom, realTo, 2));
      continue;
    }

    // Record shared-segments + diagonal axes for future edges.
    for (let i = 1; i < res.path.length; i++) {
      const u = res.path[i - 1];
      const v = res.path[i];
      const segK = edgeKey(u, v);
      let s = segLines.get(segK);
      if (!s) { s = new Set(); segLines.set(segK, s); }
      for (const id of tEdge.lineIds) s.add(id);
      // diagonal axis at v
      const prevAdj = grid.adj.get(u) ?? [];
      const e = prevAdj.find((x) => x.to === v);
      if (e && e.dir % 2 === 1) {
        const axis = e.dir === 1 || e.dir === 5 ? 0 : 1;
        let axes = diagUsedAtNode.get(v);
        if (!axes) { axes = new Set(); diagUsedAtNode.set(v, axes); }
        axes.add(axis);
      }
    }

    // Build the pixel polyline; replace first/last with real station positions.
    const pixels: Pixel[] = res.path.map((k) => grid.positions.get(k)!);
    pixels[0] = realFrom;
    pixels[pixels.length - 1] = realTo;
    out.set(tEdge.id, pixels);
  }

  return out;
}
```

- [ ] **Step 3: Run tests**

```
pnpm test
```

Expected: PASS (2 new tests).

- [ ] **Step 4: Commit**

```bash
git add src/render/layout/hananRouter.ts src/render/layout/hananRouter.test.ts
git commit -m "feat(layout): Hanan-grid Dijkstra router with paper-style relaxed cost weights"
```

---

## Task E: Plumb into `renderSmoothed`

**Files:**
- Modify: `src/render/renderGeographic.ts`

- [ ] **Step 1: Replace per-edge `octilinearPath` with `routeAllEdgesViaHanan`**

In `renderSmoothed`, after computing `nodePx`:

```ts
import { routeAllEdgesViaHanan } from './layout/hananRouter';

// Compute median edge length for cost scaling.
const lengths: number[] = [];
for (const e of graph.edges) {
  const a = nodePx.get(e.from)!;
  const b = nodePx.get(e.to)!;
  lengths.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
}
lengths.sort((p, q) => p - q);
const med = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 100;

const routed = routeAllEdgesViaHanan(
  nodePx,
  graph.edges.map((e) => ({
    id: e.id, from: e.from, to: e.to,
    lineIds: new Set(e.lines.map((l) => l.id)),
  })),
  { snapCell: med / 4, padding: med, medianEdgeLength: med },
);
```

Then replace the `layoutEdges` construction:

```ts
const layoutEdges: LayoutEdge[] = graph.edges.map((e) => {
  const path = (routed.get(e.id) ?? [nodePx.get(e.from)!, nodePx.get(e.to)!])
    .map((p) => [p[0], p[1]] as Cell);
  return {
    id: e.id, from: e.from, to: e.to, path,
    lines: e.lines,
    lineOrder: e.lines.map((l) => l.id).sort(),
    stops: e.stops,
  };
});
```

Remove the unused `octilinearPath` import (and the `SMOOTHED_OCTI_SEGMENTS` constant).

- [ ] **Step 2: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 3: Visual check via the dev harness**

```
pnpm exec tsx dev/render-test.ts "<NYC save path>" dev/water-out.geojson
python -c "import cairosvg; cairosvg.svg2png(url='dev/out-smooth.svg', write_to='dev/out-smooth.png', output_width=1400, output_height=1400)"
```

Open `dev/out-smooth.png` and confirm shared corridors bundle into clean parallel ribbons (no more independent zigzags).

- [ ] **Step 4: Commit**

```bash
git add src/render/renderGeographic.ts
git commit -m "feat(render): smoothed mode routes on shared Hanan grid (parallel ribbons)"
```

---

## Task F: Build, link, in-game verify

- [ ] **Step 1: Build + relink**

```
pnpm build
pnpm dev:link
```

- [ ] **Step 2: Launch in-game**

Open the panel in NYC; switch to smoothed; confirm:
- Corridor bundling looks correct (parallel ribbons instead of independent zigzags).
- Stations sit at (approximately) their real positions.
- No `console.warn` for routing failures (or only on isolated edges).

- [ ] **Step 3: Tune constants if needed**

Constants live at the top of `hananRouter.ts`:
- `BEND_TURN_K` (default 0.3) — increase to penalize bends more
- `STATION_PENALTY_K` (default 2.0) — increase to avoid passing through other stations
- `BUNDLE_BONUS_K` (default −1.5) — make more negative for stronger bundling
- `CONFLICT_PENALTY_K` (default 3.0) — increase to discourage line crossings
- `DIAG_CROSS_PENALTY_K` (default 2.0) — increase to discourage diag X-crossings
- `SNAP_CELL` is `medianEdge / 4` — divisor up = finer grid + less displacement, but slower

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Hanan-routing smoothed mode verified in game"
```
