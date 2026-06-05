# Schematic Modes + Game-Faithful Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three render modes (Geographic / Smoothed / Schematic) and game-faithful station labels to the Improved Schematics panel, reproducing the game's octilinear schematic engine.

**Architecture:** A framework-free render engine under `src/render/`. `schematic.ts` becomes a thin dispatcher over two renderers: the existing geographic renderer (Geographic + Smoothed modes) and a new octilinear renderer ported faithfully from the game (Schematic mode). The octilinear engine is ported function-by-function from the deobfuscated reference in `dev/reference/`, preserving exact constants and logic.

**Tech Stack:** TypeScript, Vite (rolldown-vite, IIFE lib build), React (game-provided), Node test runner (`node --test` via tsx), pnpm.

**Source of truth for ports:** `dev/reference/*.js` — readable code recovered from `GameMain` by `dev/deobf.cjs` (the obfuscation is a string-array transform; the deobfuscator evaluates the decoders and rewrites all calls to string literals). Each port task names the exact reference file. Local variable names in the reference are `_0x…`; rename them meaningfully when porting. **Preserve all numeric constants and control flow exactly.**

**Testing convention:** Pure modules get unit tests run with `pnpm test` (added in Task 1) via `node --test` over `tsx`-loaded `*.test.ts`. Rendering is validated visually through `dev/render-test.ts` against the real Seattle save.

**Key constants (from `dev/reference/_constants.txt`, do not change):**
`STEP_SIZE=3`, `TARGET_EDGE_CELLS=2.2`, `EDGE_STIFFNESS=0.18`, `ITERATIONS=80`,
`REPULSE_MIN_CELLS=1.6`, `REPULSE_STRENGTH=0.6`, `BEND_STIFFNESS=0.12`, `MAX_STEP_PER_ITER=0.6`,
`OCT_DIRS=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]`,
`CELL_PX=36`, `LINE_WIDTH=5`, `LINE_GAP=2`, `PAD=24`, `LABEL_FONT_SIZE=11`, `LABEL_CHAR_WIDTH=6`, `LABEL_OFFSET=12`.

---

## File structure

```
src/render/
  constants.ts          # NEW: all octilinear/render constants + OCT_DIRS, OCT_UNIT
  projection.ts         # EXISTING: geo->SVG (Geographic/Smoothed + water fit). Unchanged.
  routes.ts             # EXISTING: extractRouteLines (geographic geometry). Unchanged.
  types.ts              # EXISTING: extend with RenderMode + label/option fields
  layout/
    types.ts            # NEW: TransitGraph, Layout, Cell, StationGroup, … (shared graph types)
    graph.ts            # NEW: buildStationGroups, buildTransitGraph (+ walkRouteVisits, helpers)
    grid.ts             # NEW: cellKey, cellKeyOf, edgeKey, octilinearDistance, routeEdge (A*)
    octilinear.ts       # NEW: snapStations, findFreeCell, orderEdgesByImportance,
                        #      rebuildLayoutFromCells, octilinearLayout
    simplify.ts         # NEW: OCT_UNIT use, nearestOctilinearUnit, simplifyLayout, smoothGeographic
    lineOrder.ts        # NEW: orderLines
    offsets.ts          # NEW: computeCanonicalOffsets, offsetPolyline
  labels.ts             # NEW: estimateTextWidth, boxesOverlap, segmentIntersectsBox,
                        #      placeLabels, renderLabel  (shared by both renderers)
  stops.ts              # NEW: renderStops
  renderOctilinear.ts   # NEW: port of renderSvg + water backdrop affine fit
  renderGeographic.ts   # NEW: refactor of current schematic.ts body + shared labels
  schematic.ts          # MODIFIED: generateSchematicSVG({ mode, … }) dispatcher
src/ui/SchematicPanel.tsx  # MODIFIED: mode selector + labels toggle
dev/render-test.ts         # MODIFIED: emit out-geo/out-smooth/out-octi SVGs
dev/reference/*.js         # EXISTING (committed): port source of truth
dev/deobf.cjs              # EXISTING (committed): regenerates dev/reference/
```

---

## Task 0: Initialize git + test runner

**Files:**
- Create: `.gitignore` already exists (adds `dist/`, `node_modules/`). Keep `dev/reference/` tracked.
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Initialize the repository**

```bash
git init
git add -A
git commit -m "chore: snapshot working mod + deobfuscated game reference"
```

- [ ] **Step 2: Add a test script**

In `package.json` `scripts`, add:

```json
"test": "node --test --import tsx ./src/**/*.test.ts"
```

If the glob is not expanded on Windows shells, use the explicit form the executor's shell supports; on pnpm/Windows prefer:

```json
"test": "tsx --test \"src/**/*.test.ts\""
```

- [ ] **Step 3: Verify the runner finds no tests yet but exits cleanly**

Run: `pnpm test`
Expected: exits 0 (or "no test files found"); no crash.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add test script"
```

---

## Task 1: Constants module

**Files:**
- Create: `src/render/constants.ts`
- Test: `src/render/constants.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OCT_DIRS, OCT_UNIT, STEP_SIZE, TARGET_EDGE_CELLS, ITERATIONS } from './constants';

test('OCT_DIRS has 8 directions', () => {
  assert.equal(OCT_DIRS.length, 8);
});

test('OCT_UNIT normalizes diagonals to length 1', () => {
  for (const [x, y] of OCT_UNIT) {
    assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
  }
  // diagonal components equal SQRT1_2
  assert.ok(Math.abs(OCT_UNIT[1][0] - Math.SQRT1_2) < 1e-9);
});

test('scalar constants match the game', () => {
  assert.equal(STEP_SIZE, 3);
  assert.equal(TARGET_EDGE_CELLS, 2.2);
  assert.equal(ITERATIONS, 80);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./constants`.

- [ ] **Step 3: Implement**

```ts
// src/render/constants.ts
// Octilinear layout + render constants, ported verbatim from the game
// (dev/reference/_constants.txt). Do not change values.

export const STEP_SIZE = 3;
export const TARGET_EDGE_CELLS = 2.2;
export const EDGE_STIFFNESS = 0.18;
export const ITERATIONS = 80;
export const REPULSE_MIN_CELLS = 1.6;
export const REPULSE_STRENGTH = 0.6;
export const BEND_STIFFNESS = 0.12;
export const MAX_STEP_PER_ITER = 0.6;

export const CELL_PX = 36;
export const LINE_WIDTH = 5;
export const LINE_GAP = 2;
export const PAD = 24;
export const LABEL_FONT_SIZE = 11;
export const LABEL_CHAR_WIDTH = 6;
export const LABEL_OFFSET = 12;

export type Vec2 = [number, number];

/** 8 integer octilinear directions (E, NE, N, …). */
export const OCT_DIRS: Vec2[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** Unit-length versions of OCT_DIRS (diagonals scaled by SQRT1_2). */
export const OCT_UNIT: Vec2[] = OCT_DIRS.map(([x, y]) => {
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len] as Vec2;
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/constants.ts src/render/constants.test.ts
git commit -m "feat(render): octilinear constants"
```

---

## Task 2: Layout types

**Files:**
- Create: `src/render/layout/types.ts`

No test (types only); validated by `pnpm typecheck` in later tasks.

- [ ] **Step 1: Implement the shared graph/layout types**

```ts
// src/render/layout/types.ts
import type { Coordinate } from '../../types/core';

export type Cell = [number, number];   // grid coordinates (col, row)
export type Pixel = [number, number];  // projected meters/pixels

/** Interchange node input to buildTransitGraph (grouped stations). */
export interface StationGroup {
  id: string;            // trackGroupId
  name: string;
  center: Coordinate;    // [lng, lat]
  stationIds: string[];
}

export interface GraphNode { id: string; label: string; pos: Pixel; lngLat: Coordinate; }
export interface LineRef { id: string; label: string; color: string; }
export interface EdgeStop { atFrom: boolean; atTo: boolean; }

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  lines: LineRef[];
  stops: Map<string, EdgeStop>;       // lineId -> stop flags
}

export interface TraversalStep { edgeId: string; reversed: boolean; }

export interface TransitGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  adj: Map<string, string[]>;          // nodeId -> edgeIds
  lineTraversals: Map<string, TraversalStep[]>;  // lineId -> ordered edge steps
}

export interface LayoutNode { id: string; cell: Cell; label: string; lngLat: Coordinate; }

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  path: Cell[];                        // octilinear grid path
  lines: LineRef[];
  lineOrder: string[];                 // ordered line ids (mutated by orderLines)
  stops: Map<string, EdgeStop>;
}

export interface Layout {
  cellSize: number;
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  lineTraversals: Map<string, TraversalStep[]>;
}

/** Walk result element from walkRouteVisits. */
export interface Visit { groupId: string; isStop: boolean }
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/render/layout/types.ts
git commit -m "feat(render): layout graph types"
```

---

## Task 3: Grid primitives (cell keys, octilinear distance, A* routeEdge)

**Files:**
- Create: `src/render/layout/grid.ts`
- Test: `src/render/layout/grid.test.ts`
- Port from: `dev/reference/cellKeyOf.js`, `octilinearDistance.js`, `routeEdge.js` (also define `cellKey`, `edgeKey` — trivial, see below)

`cellKey`/`cellKeyOf` both stringify a cell; in the game `cellKeyOf(c)` and `cellKey(c)` are both `c[0] + ',' + c[1]`. `edgeKey(a,b)` is an order-independent key of two cells.

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, edgeKey, octilinearDistance, routeEdge } from './grid';

test('octilinearDistance: diagonal then straight (Chebyshev with SQRT2)', () => {
  // dx=3, dy=1 -> min=1 diagonal (SQRT2) + 2 straight
  assert.ok(Math.abs(octilinearDistance([0, 0], [3, 1]) - (Math.SQRT2 + 2)) < 1e-9);
});

test('edgeKey is order-independent', () => {
  assert.equal(edgeKey([1, 2], [3, 4]), edgeKey([3, 4], [1, 2]));
});

test('routeEdge returns an octilinear path from start to goal', () => {
  const occupied = new Set<string>();
  const sharedSegs = new Map<string, Set<string>>();
  const path = routeEdge([0, 0], [3, 0], new Set(['L1']), occupied, sharedSegs);
  assert.equal(cellKey(path[0]), cellKey([0, 0]));
  assert.equal(cellKey(path[path.length - 1]), cellKey([3, 0]));
  // every step moves to an 8-neighbour
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i][0] - path[i - 1][0]);
    const dy = Math.abs(path[i][1] - path[i - 1][1]);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./grid` not found.

- [ ] **Step 3: Implement by porting**

Port `octilinearDistance` and `routeEdge` from `dev/reference/octilinearDistance.js` and `dev/reference/routeEdge.js` exactly (A* over the 8 directions, `octilinearDistance` heuristic, the 50000-node expansion cap, preferring cells not in `occupied` and reusing shared segments for the same line set). Add the trivial helpers. Target signatures:

```ts
// src/render/layout/grid.ts
import type { Cell } from './types';

export const cellKey = (c: Cell): string => c[0] + ',' + c[1];
export const cellKeyOf = cellKey;
export const edgeKey = (a: Cell, b: Cell): string => {
  const ka = cellKey(a), kb = cellKey(b);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
};

export function octilinearDistance(a: Cell, b: Cell): number { /* port */ }

/**
 * A* grid route between two cells over the 8 octilinear directions.
 * @param occupied   keys of cells already used by other nodes (soft-avoided)
 * @param sharedSegs edgeKey -> set of lineIds, to bundle co-running lines
 */
export function routeEdge(
  from: Cell, to: Cell, lineIds: Set<string>,
  occupied: Set<string>, sharedSegs: Map<string, Set<string>>,
): Cell[] { /* port */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/grid.ts src/render/layout/grid.test.ts
git commit -m "feat(render): grid primitives + A* routeEdge port"
```

---

## Task 4: Transit graph from game state

**Files:**
- Create: `src/render/layout/graph.ts`
- Test: `src/render/layout/graph.test.ts`
- Port from: `dev/reference/buildTransitGraph.js`, `walkRouteVisits.js`, `normalizeColor.js`, `edgeKey_1.js`, `projectFactory.js`

**New glue:** `buildStationGroups(stations)` groups the API `Station[]` by `trackGroupId` into `StationGroup[]` (the game's 3rd argument), since the mod must derive interchange groups itself.

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStationGroups, buildTransitGraph } from './graph';
import type { Station, Route, Track } from '../../types/game-state';

// Two stations sharing a trackGroupId collapse to one node.
const stations = [
  { id: 's1', name: 'A', coords: [-122.0, 47.0], trackIds: ['t1'], trackGroupId: 'g1',
    buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's2', name: 'B', coords: [-122.0, 47.01], trackIds: ['t2'], trackGroupId: 'g1',
    buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's3', name: 'C', coords: [-122.1, 47.0], trackIds: ['t3'], trackGroupId: 'g2',
    buildType: 'constructed', stNodeIds: ['n3'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
] as unknown as Station[];

test('buildStationGroups collapses by trackGroupId', () => {
  const groups = buildStationGroups(stations);
  assert.equal(groups.length, 2);
  const g1 = groups.find((g) => g.id === 'g1')!;
  assert.deepEqual(g1.stationIds.sort(), ['s1', 's2']);
  // center is the mean of members
  assert.ok(Math.abs(g1.center[1] - 47.005) < 1e-9);
});

test('buildTransitGraph builds edges between consecutive distinct groups', () => {
  const routes = [{ id: 'r1', bullet: '1', color: '#ff0000', stCombos: [
    { startStNodeId: 'n1', endStNodeId: 'n3', path: [], distance: 0 },
  ], stComboTimings: [] }] as unknown as Route[];
  const tracks = [] as unknown as Track[];
  const graph = buildTransitGraph(stations, routes, buildStationGroups(stations));
  assert.equal(graph.nodes.size, 2);          // g1, g2
  assert.equal(graph.edges.length, 1);        // g1<->g2
  assert.deepEqual([...graph.lineTraversals.keys()], ['r1']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./graph` not found.

- [ ] **Step 3: Implement**

Port `walkRouteVisits`, `normalizeColor`, `edgeKey$1` (as `groupEdgeKey`), `projectFactory`, and `buildTransitGraph` from the reference exactly. Then add the new grouping helper:

```ts
// in src/render/layout/graph.ts
import type { Station, Route } from '../../types/game-state';
import type { StationGroup, TransitGraph } from './types';

export function buildStationGroups(stations: Station[]): StationGroup[] {
  const byGroup = new Map<string, Station[]>();
  for (const s of stations) {
    if (s.buildType !== 'constructed') continue;
    const arr = byGroup.get(s.trackGroupId) ?? [];
    arr.push(s);
    byGroup.set(s.trackGroupId, arr);
  }
  const groups: StationGroup[] = [];
  for (const [id, members] of byGroup) {
    let lng = 0, lat = 0;
    for (const m of members) { lng += m.coords[0]; lat += m.coords[1]; }
    groups.push({
      id,
      name: members[0].name,
      center: [lng / members.length, lat / members.length],
      stationIds: members.map((m) => m.id),
    });
  }
  return groups;
}

export function buildTransitGraph(
  stations: Station[], routes: Route[], groups: StationGroup[],
): TransitGraph { /* port from dev/reference/buildTransitGraph.js */ }
```

Notes for the port: `walkRouteVisits(route, stNodeToGroup, trackToGroup)` returns `Visit[]`; it reads `route.stCombos` (start/end `stNodeId` + each path segment's `trackId`), falling back to `route.stNodes`. `buildTransitGraph` filters stations to `buildType === 'constructed'`, maps `stNodeIds`/`trackIds` to group ids, projects group centers via `projectFactory(meanLat)`, builds edges + per-line `stops` + `lineTraversals`, and prunes nodes with no edges.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/graph.ts src/render/layout/graph.test.ts
git commit -m "feat(render): buildTransitGraph + station grouping"
```

---

## Task 5: Octilinear layout (snap + rebuild)

**Files:**
- Create: `src/render/layout/octilinear.ts`
- Test: `src/render/layout/octilinear.test.ts`
- Port from: `dev/reference/snapStations.js`, `findFreeCell.js`, `orderEdgesByImportance.js`, `rebuildLayoutFromCells.js`, `octilinearLayout.js`

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octilinearLayout } from './octilinear';
import { buildStationGroups, buildTransitGraph } from './graph';
import { cellKey } from './grid';
// build a tiny 3-station line graph (reuse a fixture helper or inline like Task 4)

test('octilinearLayout assigns a unique grid cell per node', () => {
  const graph = /* build a >=3 node graph */ undefined as any;
  const layout = octilinearLayout(graph);
  const seen = new Set<string>();
  for (const n of layout.nodes.values()) {
    const k = cellKey(n.cell);
    assert.ok(!seen.has(k), 'no two nodes share a cell');
    seen.add(k);
  }
  assert.equal(layout.cellSize, 3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./octilinear` not found.

- [ ] **Step 3: Implement by porting**

Port the five functions exactly. Signatures:

```ts
// src/render/layout/octilinear.ts
import type { TransitGraph, Layout, Cell, GraphEdge } from './types';

export function findFreeCell(want: Cell, nodeId: string, used: Map<string, string>): Cell { /* port */ }
export function orderEdgesByImportance(graph: TransitGraph): GraphEdge[] { /* port */ }
export function snapStations(graph: TransitGraph): Map<string, Cell> { /* port */ }
export function rebuildLayoutFromCells(graph: TransitGraph, cells: Map<string, Cell>): Layout { /* port */ }
export function octilinearLayout(graph: TransitGraph): Layout {
  return rebuildLayoutFromCells(graph, snapStations(graph));
}
```

`snapStations`: compute pixel bounds, median edge length, `cellSize = max(1, median/STEP_SIZE)`, round each node to a cell, then assign in descending adjacency order via `findFreeCell` (ring search for a free cell). `rebuildLayoutFromCells`: route each edge with `routeEdge` (ordered by `orderEdgesByImportance`), recording shared segments, and emit `LayoutEdge`s with `path`, `lineOrder`, `stops`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/octilinear.ts src/render/layout/octilinear.test.ts
git commit -m "feat(render): octilinear grid layout port"
```

---

## Task 6: Simplify + smoothing

**Files:**
- Create: `src/render/layout/simplify.ts`
- Test: `src/render/layout/simplify.test.ts`
- Port from: `dev/reference/nearestOctilinearUnit.js`, `simplifyLayout.js`

**New glue:** `smoothGeographic(graph)` — the Smoothed mode. Same spring relaxation as `simplifyLayout` but operating on geographic-projected pixel positions with an added anchor force toward each node's original `pos`, returning displaced pixel positions (NOT grid cells). It reuses `nearestOctilinearUnit`. See Step 3.

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestOctilinearUnit } from './simplify';

test('nearestOctilinearUnit snaps to the 8 directions', () => {
  assert.deepEqual(nearestOctilinearUnit(10, 0.5), [1, 0]);             // ~East
  const ne = nearestOctilinearUnit(5, 5);
  assert.ok(Math.abs(ne[0] - Math.SQRT1_2) < 1e-9 && Math.abs(ne[1] - Math.SQRT1_2) < 1e-9);
  assert.deepEqual(nearestOctilinearUnit(0, -7), [0, -1]);              // South
});

test('nearestOctilinearUnit handles near-zero vectors', () => {
  assert.deepEqual(nearestOctilinearUnit(0, 0), [1, 0]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./simplify` not found.

- [ ] **Step 3: Implement**

Port `nearestOctilinearUnit` (uses `OCT_UNIT`, max dot product) and `simplifyLayout` exactly — including all four force phases per iteration (edge spring toward `nearestOctilinearUnit × TARGET_EDGE_CELLS` with `EDGE_STIFFNESS`, split ±0.5; pairwise repulsion under `REPULSE_MIN_CELLS` with `REPULSE_STRENGTH`; bend-straightening along line traversals with `BEND_STIFFNESS`; per-node displacement clamp `MAX_STEP_PER_ITER`), 80 iterations, then round + `findFreeCell` + `rebuildLayoutFromCells`. Signatures:

```ts
// src/render/layout/simplify.ts
import type { TransitGraph, Layout, Pixel } from './types';

export function nearestOctilinearUnit(dx: number, dy: number): [number, number] { /* port */ }
export function simplifyLayout(layout: Layout, graph: TransitGraph): Layout { /* port */ }

/** Smoothed mode: relax projected positions toward octilinear while anchored to geography. */
export function smoothGeographic(graph: TransitGraph): Map<string, Pixel> {
  // Start from graph.nodes[].pos. Run ITERATIONS iterations of:
  //   - edge spring toward nearestOctilinearUnit(dir) * (median edge length),
  //     stiffness EDGE_STIFFNESS, split ±0.5  (reuse the simplifyLayout math)
  //   - anchor spring pulling each node back to its original pos (stiffness ~0.25)
  //   - clamp per-iteration displacement
  // Return the displaced pixel positions (no grid snap).
}
```

Anchor stiffness `0.25` is a Smoothed-mode tuning value (not from the game); it is the one knob the user may adjust after seeing output.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/simplify.ts src/render/layout/simplify.test.ts
git commit -m "feat(render): simplifyLayout + geographic smoothing"
```

---

## Task 7: Line ordering

**Files:**
- Create: `src/render/layout/lineOrder.ts`
- Test: `src/render/layout/lineOrder.test.ts`
- Port from: `dev/reference/orderLines.js`

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderLines } from './lineOrder';

test('orderLines is deterministic and preserves line membership', () => {
  const layout = /* a layout with 2 edges sharing a node, 2 lines each */ undefined as any;
  orderLines(layout);
  const before = layout.edges.map((e: any) => [...e.lineOrder]);
  orderLines(layout);
  const after = layout.edges.map((e: any) => [...e.lineOrder]);
  assert.deepEqual(after, before);  // idempotent / stable
  for (const e of layout.edges) {
    assert.equal(e.lineOrder.length, e.lines.length);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./lineOrder` not found.

- [ ] **Step 3: Implement by porting**

Port `orderLines` exactly (it mutates each edge's `lineOrder` in place, iterating up to 6 passes, ordering each edge's lines by their median position on adjacent edges, breaking ties by id). Signature:

```ts
// src/render/layout/lineOrder.ts
import type { Layout } from './types';
export function orderLines(layout: Layout): void { /* port */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/lineOrder.ts src/render/layout/lineOrder.test.ts
git commit -m "feat(render): parallel line ordering"
```

---

## Task 8: Parallel-line offsets

**Files:**
- Create: `src/render/layout/offsets.ts`
- Test: `src/render/layout/offsets.test.ts`
- Port from: `dev/reference/computeCanonicalOffsets.js`, `offsetPolyline.js`

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetPolyline } from './offsets';

test('offsetPolyline with zero offset returns the input points', () => {
  const pts: [number, number][] = [[0, 0], [10, 0], [10, 10]];
  const out = offsetPolyline(pts, 0);
  assert.deepEqual(out, pts);
});

test('offsetPolyline shifts a straight horizontal line perpendicularly', () => {
  const out = offsetPolyline([[0, 0], [10, 0]], 4);
  // perpendicular to +x is ±y; magnitude 4
  assert.ok(Math.abs(Math.abs(out[0][1] - 0) - 4) < 1e-6);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./offsets` not found.

- [ ] **Step 3: Implement by porting**

Port `computeCanonicalOffsets(layout)` (assigns each (edge,line) a signed lane offset from `lineOrder`, centered, spaced by `LINE_WIDTH + LINE_GAP`) and `offsetPolyline(points, offset)` (shift a pixel polyline perpendicular to each segment, mitering at joints). Signatures:

```ts
// src/render/layout/offsets.ts
import type { Layout } from './types';
export function computeCanonicalOffsets(layout: Layout): Map<string, number> { /* port; key = edgeId|lineId */ }
export function offsetPolyline(points: [number, number][], offset: number): [number, number][] { /* port */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/offsets.ts src/render/layout/offsets.test.ts
git commit -m "feat(render): parallel-line offset bundling"
```

---

## Task 9: Labels (shared)

**Files:**
- Create: `src/render/labels.ts`
- Test: `src/render/labels.test.ts`
- Port from: `dev/reference/placeLabels.js`, `renderLabel.js` (+ helpers `estimateTextWidth`, `boxesOverlap`, `segmentIntersectsBox`)

`estimateTextWidth(s) = s.length * LABEL_CHAR_WIDTH`. `boxesOverlap(a,b)` is standard AABB overlap. `segmentIntersectsBox(p1,p2,box)` is segment/AABB intersection. These three are small helpers used by `placeLabels`; implement them directly (they are not separately recoverable but are simple and unambiguous).

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap, estimateTextWidth, placeLabels } from './labels';

test('estimateTextWidth scales with length', () => {
  assert.equal(estimateTextWidth('abcd'), 4 * 6);
});

test('boxesOverlap detects overlap and separation', () => {
  assert.ok(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(!boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }));
});

test('placeLabels assigns non-overlapping boxes for two distant stations', () => {
  // graph with 2 nodes far apart; nodePx positions provided; expect 2 placements
  const placements = placeLabels(/* graph */ undefined as any, /* nodePx */ new Map(), /* stops */ new Map(), []);
  assert.ok(placements instanceof Map);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./labels` not found.

- [ ] **Step 3: Implement by porting**

Port `placeLabels(graph, nodePx, stops, segments)` exactly: build avoidance boxes from station markers, sort nodes by descending label length, and for each pick the lowest-cost of 8 candidate placements (cost: +100 per placed-label overlap, +30 per station-box overlap, +12 per line-segment crossing, +priority). Port `renderLabel(node, placement, hasStops, dark)` to an SVG `<text>` string. Signatures:

```ts
// src/render/labels.ts
import type { TransitGraph, GraphNode } from './layout/types';

export interface Box { x: number; y: number; w: number; h: number }
export interface Placement { x: number; y: number; anchor: 'start' | 'middle' | 'end' }
export interface Segment { p1: [number, number]; p2: [number, number] }

export const estimateTextWidth = (s: string): number => s.length * 6; // LABEL_CHAR_WIDTH
export function boxesOverlap(a: Box, b: Box): boolean { /* AABB */ }
export function segmentIntersectsBox(p1: [number, number], p2: [number, number], box: Box): boolean { /* port */ }

export function placeLabels(
  graph: TransitGraph,
  nodePx: Map<string, [number, number]>,
  stops: Map<string, { lineId: string; color: string; pos: [number, number] }[]>,
  segments: Segment[],
): Map<string, Placement> { /* port */ }

export function renderLabel(node: GraphNode, placement: Placement, hasStops: boolean, dark: boolean): string { /* port */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/labels.ts src/render/labels.test.ts
git commit -m "feat(render): game-faithful label placement"
```

---

## Task 10: Stop ticks

**Files:**
- Create: `src/render/stops.ts`
- Port from: `dev/reference/renderStops.js`

No standalone unit test (pure string output, exercised by the harness in Task 13).

- [ ] **Step 1: Implement by porting**

Port `renderStops(stopsByNode, dark)` to its SVG string output. Signature:

```ts
// src/render/stops.ts
export function renderStops(
  stopsByNode: Map<string, { lineId: string; color: string; pos: [number, number] }[]>,
  dark: boolean,
): string[] { /* port from dev/reference/renderStops.js */ }
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/render/stops.ts
git commit -m "feat(render): per-line stop ticks"
```

---

## Task 11: Octilinear renderer + water backdrop

**Files:**
- Create: `src/render/renderOctilinear.ts`
- Port from: `dev/reference/renderSvg.js`, `gridToPx.js`
- Test: `src/render/renderOctilinear.test.ts`

**New glue:** water backdrop. Compute an affine map from the station groups' geographic bbox → the layout's pixel bbox, apply it to water polygons, and draw them behind the schematic.

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOctilinear } from './renderOctilinear';

test('renderOctilinear returns a self-contained svg', () => {
  const layout = /* a small laid-out graph (build->snap->simplify->order) */ undefined as any;
  const svg = renderOctilinear(layout, { dark: false, showLabels: true });
  assert.match(svg, /^<svg[\s>]/);
  assert.match(svg, /<\/svg>$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./renderOctilinear` not found.

- [ ] **Step 3: Implement**

Port `renderSvg(layout, options)` and `gridToPx` exactly: compute cell bounds, `gridToPx` with `CELL_PX`/`PAD`, `computeCanonicalOffsets`, per-edge `offsetPolyline` (casing stroke + colored stroke), `renderStops`, `placeLabels` + `renderLabel`, honoring `options.showLabels` (default true) and `options.dark`. Then extend with the water backdrop:

```ts
// src/render/renderOctilinear.ts
import type { Layout } from './layout/types';
import type { WaterCollection } from './types';

export interface OctiOptions { dark?: boolean; showLabels?: boolean; water?: WaterCollection }

export function renderOctilinear(layout: Layout, opts: OctiOptions = {}): string {
  // 1. port of renderSvg -> produces canvas size (w,h) + body parts
  // 2. if opts.water: derive affine geoBBox(nodes.lngLat) -> pxBBox(node cells->gridToPx),
  //    map each water ring through it, and prepend a <g fill=water> behind the lines.
  //    (Loose backdrop; will not precisely align — accepted.)
}
```

The affine: from node `lngLat` compute geo bbox; from node `cell→gridToPx` compute pixel bbox; build `x' = px0 + (lng-lng0)*(pw/gw)`, `y' = py0 + (lat1-lat)*(ph/gh)` (note Y flip), apply to every water coordinate.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/renderOctilinear.ts src/render/renderOctilinear.test.ts
git commit -m "feat(render): octilinear renderer + water backdrop"
```

---

## Task 12: Geographic renderer refactor + dispatcher

**Files:**
- Create: `src/render/renderGeographic.ts`
- Modify: `src/render/schematic.ts` (becomes dispatcher), `src/render/types.ts` (add `RenderMode`)
- Test: `src/render/schematic.test.ts`

- [ ] **Step 1: Add RenderMode to types and write failing test**

In `src/render/types.ts` add:

```ts
export type RenderMode = 'geographic' | 'smoothed' | 'schematic';
```

Test:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchematicSVG } from './schematic';

const input = { routes: [], tracks: [], stations: [], options: { mode: 'geographic' as const } };

test('empty network yields the empty-state svg in every mode', () => {
  for (const mode of ['geographic', 'smoothed', 'schematic'] as const) {
    const svg = generateSchematicSVG({ ...input, options: { mode } });
    assert.match(svg, /^<svg/);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — `generateSchematicSVG` signature/mode not present.

- [ ] **Step 3: Move current renderer into renderGeographic.ts**

Move the body of today's `generateSchematicSVG` (land rect, water, lines, stations) into `renderGeographic(input)` in `src/render/renderGeographic.ts`. Add label support by calling shared `placeLabels`/`renderLabel` over the projected station pixels when `showLabels`. For Smoothed mode, replace station/line pixel positions with `smoothGeographic(graph)` output before drawing (build the graph, smooth, then project edges through the smoothed node pixels).

- [ ] **Step 4: Rewrite schematic.ts as a dispatcher**

```ts
// src/render/schematic.ts
import type { RenderMode } from './types';
import { renderGeographic } from './renderGeographic';
import { renderOctilinear } from './renderOctilinear';
import { buildStationGroups, buildTransitGraph } from './layout/graph';
import { octilinearLayout } from './layout/octilinear';
import { simplifyLayout } from './layout/simplify';
import { orderLines } from './layout/lineOrder';

export interface SchematicInput { /* routes, tracks, stations, water?, options: { mode, showStations, showLabels, dark, width, height, … } */ }

export function generateSchematicSVG(input: SchematicInput): string {
  const mode: RenderMode = input.options?.mode ?? 'geographic';
  if (mode === 'schematic') {
    const groups = buildStationGroups(input.stations);
    const graph = buildTransitGraph(input.stations, input.routes, groups);
    if (graph.edges.length === 0) return EMPTY_STATE_SVG;
    let layout = octilinearLayout(graph);
    layout = simplifyLayout(layout, graph);
    orderLines(layout);
    return renderOctilinear(layout, { dark: input.options.dark, showLabels: input.options.showLabels, water: input.water });
  }
  return renderGeographic({ ...input, smooth: mode === 'smoothed' });
}
```

(`EMPTY_STATE_SVG` is the existing empty-state string, extracted to a const.)

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/renderGeographic.ts src/render/schematic.ts src/render/types.ts src/render/schematic.test.ts
git commit -m "feat(render): mode dispatcher + geographic renderer with labels"
```

---

## Task 13: Dev harness — render all three modes

**Files:**
- Modify: `dev/render-test.ts`

- [ ] **Step 1: Emit all three modes from the Seattle save**

Update `dev/render-test.ts` to load the real save (as today) and write `dev/out-geo.svg`, `dev/out-smooth.svg`, `dev/out-octi.svg` by calling `generateSchematicSVG` with each `mode` (and `showLabels: true`, water loaded for octi).

- [ ] **Step 2: Run the harness**

Run: `pnpm render`
Expected: three SVG files written; no exceptions.

- [ ] **Step 3: Rasterize for review**

Run: `python -c "import cairosvg; [cairosvg.svg2png(url=f'dev/out-{m}.svg', write_to=f'dev/out-{m}.png') for m in ('geo','smooth','octi')]"`
Expected: three PNGs. **Surface `dev/out-octi.png` to the user for the water-backdrop (#6) decision before finalizing.**

- [ ] **Step 4: Commit**

```bash
git add dev/render-test.ts
git commit -m "test(render): harness emits geographic/smoothed/schematic"
```

---

## Task 14: Panel UI — mode selector + labels toggle

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

- [ ] **Step 1: Add mode + labels state and controls**

Add a 3-way mode selector (`Geographic` / `Smoothed` / `Schematic`) and a `Labels` toggle alongside the existing `Stations` toggle. Thread `mode`, `showStations`, `showLabels`, and resolved `dark` (from `api.ui.getResolvedTheme()`) into `generateSchematicSVG`, and add them to the `useMemo` dependency array.

- [ ] **Step 2: Build + typecheck**

Run: `pnpm typecheck && pnpm build`
Expected: PASS; `dist/index.js` rebuilt.

- [ ] **Step 3: Commit**

```bash
git add src/ui/SchematicPanel.tsx
git commit -m "feat(ui): schematic mode selector + labels toggle"
```

---

## Task 15: Verify in game

- [ ] **Step 1: Relink + launch**

Run: `pnpm dev:link` then `pnpm exec tsx scripts/run.ts` (background). Load a city with a built route.

- [ ] **Step 2: Confirm**

Check `debug/latest.log` for `[ImprovedSchematics] Initialized.` and no errors. In the panel, switch all three modes and toggle Labels; confirm the octilinear schematic renders with bundled lines, stops, and labels.

- [ ] **Step 3: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "chore: schematic modes + labels verified in game"
```

---

## Self-review notes

- **Spec coverage:** modes (Tasks 11/12), labels (Task 9), faithful octilinear engine (Tasks 3–8, 11), smoothing (Task 6), water-in-octilinear (Task 11), buildTransitGraph mapping (Task 4), deobfuscation reference (pre-built, `dev/deobf.cjs` + `dev/reference/`), UI (Task 14), testing/harness (Tasks 1,13), error handling (empty-state in Task 12; A* cap in Task 3). All covered.
- **Out of scope (unchanged):** runtime water *generation* from `ocean_depth_index`.
- **Type consistency:** `Layout`/`TransitGraph`/`Cell`/`StationGroup` defined once in `layout/types.ts` and reused; `placeLabels`/`renderLabel` shared by both renderers; `RenderMode` defined in `render/types.ts`.
- **Wait-and-see:** Task 13 Step 3 surfaces the octilinear water backdrop render for the user's #6 decision before it is locked.
```
