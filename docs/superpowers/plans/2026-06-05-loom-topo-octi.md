# LOOM-style Topo Merge + Octi Schematicization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Hanan-grid smoothed renderer with a two-stage LOOM-style pipeline — `topo` merges geographically-parallel transit edges into a support graph carrying corridors as single edges, and `octi` schematicizes that support graph by jointly placing stations on an octilinear grid and routing every edge octilinearly.

**Spec:** `docs/superpowers/specs/2026-06-05-loom-topo-octi-design.md`

**Architecture:** Three new modules under `src/render/layout/`: `topo.ts` (support-graph construction), `octiGrid.ts` (extended octilinear grid `Γ'` with ports/sinks/bend-edges), and `octi.ts` (iterative shortest-path placement). `topo` outputs a `SupportGraph` (new type); `octi` consumes it and outputs an `Image`, which is converted to the existing `Layout` and rendered with the existing `renderRibbons` + `orderLines`. `geographic` mode renders the support graph directly; `smoothed` mode runs `topo → octi`. The old `hananRouter.ts` and `ghostNodes.ts` are deleted in the final stage.

**Tech Stack:** TypeScript (ESM), tests via `node --test` driven by `tsx` (`pnpm test`), `tsc --noEmit` typecheck (`pnpm typecheck`), dev render harness `pnpm render`.

**Rollout:** Three stages on `feat/loom-pipeline`, each with a visual checkpoint, merged to `master` at the end:
1. **Topo** — new module + wired into `geographic` mode behind `useTopoMerge` flag (default off).
2. **Octi** — new modules + wired into `smoothed` mode.
3. **Cleanup** — delete dead code, flip `useTopoMerge` default on, remove the flag.

---

## Conventions used throughout this plan

- All new files live in `src/render/layout/`. Tests sit next to their module (`foo.ts` + `foo.test.ts`), matching the repo pattern.
- Test files use:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
```

- Run a single test file with: `pnpm exec tsx --test src/render/layout/<file>.test.ts`
- Run the whole suite with: `pnpm test`
- Typecheck with: `pnpm typecheck`
- `Pixel` is `[number, number]` (projected pixels); `Coordinate` is `[lng, lat]`. Both are imported from existing modules — `Pixel` from `./types`, `Coordinate` from `../../types/core`.
- Direction index convention matches `hananGrid.ts`: `0=E, 1=NE, 2=N, 3=NW, 4=W, 5=SW, 6=S, 7=SE` (math convention, +y up). The SVG y-axis is flipped downstream but the index convention stays internally consistent.
- Commit after every green task. Never use `--amend`.

---

# STAGE 1 — TOPO

## Task A: Branch + shared support-graph types

**Files:**
- Modify: `src/render/layout/types.ts` (append new interfaces)

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/loom-pipeline
```

- [ ] **Step 2: Append support-graph + image types to `src/render/layout/types.ts`**

Add at the end of the file (after `StopMark`):

```ts
// ---- LOOM topo: support graph -------------------------------------------

/** A node in the support graph H. Pure geometry; identity by id. */
export interface SupportNode {
  id: string;
  pos: Pixel;
}

/** A merged corridor edge in H. `points[0]` is from.pos, `points.at(-1)` is
 *  to.pos; intermediate points carry the corridor's bend geometry. */
export interface SupportEdge {
  id: string;
  from: string;
  to: string;
  points: Pixel[];
  lineIds: Set<string>;
}

/** A station placed onto the support graph by insertStations. */
export interface SupportStation {
  id: string;        // station-group id
  label: string;
  lngLat: Coordinate;
  nodeId: string;    // support node it was placed at
}

/** Output of topo: corridors as single edges + stations re-inserted. */
export interface SupportGraph {
  nodes: Map<string, SupportNode>;
  edges: Map<string, SupportEdge>;
  adj: Map<string, string[]>;                    // nodeId -> edgeIds
  lineRefs: Map<string, LineRef>;                // lineId -> color/label
  lineTraversals: Map<string, TraversalStep[]>;  // lines over support edges
  stations: Map<string, SupportStation>;         // stationGroupId -> placement
  /** Per (lineId|supportNodeId): the line stops at that node. */
  stopAt: Set<string>;
}

// ---- LOOM octi: schematized image ---------------------------------------

/** Result of octi: each support node mapped to a grid pixel, each support
 *  edge mapped to an octilinear pixel polyline. */
export interface Image {
  /** supportNodeId -> placed grid pixel. */
  placement: Map<string, Pixel>;
  /** supportEdgeId -> routed octilinear pixel polyline. */
  paths: Map<string, Pixel[]>;
  /** The base grid cell size actually used (after any stalling shrink). */
  cellSize: number;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (only added types, no usages yet).

- [ ] **Step 4: Commit**

```bash
git add src/render/layout/types.ts
git commit -m "feat(types): support-graph + image types for LOOM pipeline"
```

---

## Task B: Geometry helpers in `topo.ts`

**Files:**
- Create: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

These are the self-contained primitives the merge loop needs: distance, polyline length, equispaced densification, and the line-creep blocker. Build and test them first so the merge loop can rely on them.

- [ ] **Step 1: Write the failing test** (`src/render/layout/topo.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, polylineLength, densify, creepBlocked } from './topo';
import type { Pixel } from './types';

test('dist computes euclidean distance', () => {
  assert.equal(dist([0, 0], [3, 4]), 5);
});

test('polylineLength sums segment lengths', () => {
  assert.equal(polylineLength([[0, 0], [0, 10], [10, 10]]), 20);
});

test('densify produces equispaced points including both endpoints', () => {
  const pts = densify([[0, 0], [0, 10]], 2.5);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts.at(-1), [0, 10]);
  // 10 / 2.5 = 4 segments -> 5 points
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[1], [0, 2.5]);
});

test('densify never returns fewer than the two endpoints', () => {
  const pts = densify([[0, 0], [1, 0]], 100);
  assert.deepEqual(pts, [[0, 0], [1, 0]]);
});

test('creepBlocked rejects a candidate that interlaces an obtuse meeting', () => {
  // samples along a straight run; p1 far left, pl far right.
  const samples: Pixel[] = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const pk: Pixel = [20, 0];
  // candidate sitting almost on top of p_k: alpha*dist(pk,p1)=0.707*20=14.1 > 0
  // distance to candidate ~0, so 14.1 <= 0 is false AND 0.707*10 <= 0 false -> NOT blocked
  assert.equal(creepBlocked([20.1, 0], pk, samples), false);
  // a candidate far from p_k relative to its distance to the ends IS blocked:
  // dist(pk, far)=15 ; alpha*dist(pk,p1)=14.1 <= 15 -> blocked
  assert.equal(creepBlocked([20, 15], pk, samples), true);
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `topo.ts` does not exist / exports undefined.

- [ ] **Step 3: Implement the helpers** (`src/render/layout/topo.ts`)

```ts
// LOOM topo: build the support graph H by merging geographically-parallel
// transit edges into single corridor edges carrying the union of their line
// ids, then re-insert stations at the best-scoring support nodes.
// Reference: Brosi & Bast 2024, "Network Topology Extraction".

import type { Pixel } from './types';

/** sin(pi/4): the paper's line-creep angle factor. */
export const ALPHA = Math.SQRT1_2; // 0.70710678…

export function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(pts: Pixel[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/** Resample a polyline into equispaced points ~`step` apart. Always returns
 *  the exact first/last endpoints; returns just the endpoints when the line is
 *  shorter than one step. */
export function densify(pts: Pixel[], step: number): Pixel[] {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const total = polylineLength(pts);
  if (total <= step) return [pts[0].slice() as Pixel, pts.at(-1)!.slice() as Pixel];
  const n = Math.max(1, Math.round(total / step));
  const seg = total / n;
  const out: Pixel[] = [pts[0].slice() as Pixel];
  let acc = 0;          // distance consumed along the source polyline
  let target = seg;     // next sample distance
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    while (target <= acc + segLen + 1e-9 && out.length < n) {
      const t = segLen === 0 ? 0 : (target - acc) / segLen;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      target += seg;
    }
    acc += segLen;
  }
  out.push(pts.at(-1)!.slice() as Pixel);
  return out;
}

/** Paper's line-creep mitigation. With p1/pl the first/last samples of the
 *  edge being densified, reject candidate node `v` when it sits too far from
 *  the current sample relative to that sample's distance to either endpoint —
 *  this prevents two edges meeting at an obtuse angle from interlacing. */
export function creepBlocked(vPos: Pixel, pk: Pixel, samples: Pixel[]): boolean {
  const p1 = samples[0];
  const pl = samples[samples.length - 1];
  const dv = dist(pk, vPos);
  return ALPHA * dist(pk, p1) <= dv || ALPHA * dist(pk, pl) <= dv;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): geometry helpers + line-creep blocker"
```

---

## Task C: Spatial node index (nearest support node)

**Files:**
- Modify: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

The merge loop calls `nearestNode(p, d̂)` per sample. A uniform grid hash bucketed by `d̂` keeps that near-O(1). Implement it as a small class internal to `topo.ts` but exported for testing.

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/topo.test.ts`)

```ts
import { NodeIndex } from './topo';

test('NodeIndex returns the nearest node within radius, or null beyond it', () => {
  const idx = new NodeIndex(5);
  idx.insert('a', [0, 0]);
  idx.insert('b', [3, 0]);
  idx.insert('c', [100, 100]);
  assert.equal(idx.nearest([1, 0], 5), 'a');
  assert.equal(idx.nearest([2.6, 0], 5), 'b');
  assert.equal(idx.nearest([50, 50], 5), null);
});

test('NodeIndex.move keeps lookups consistent after a node snaps', () => {
  const idx = new NodeIndex(5);
  idx.insert('a', [0, 0]);
  idx.move('a', [0, 0], [20, 0]);
  assert.equal(idx.nearest([19, 0], 5), 'a');
  assert.equal(idx.nearest([1, 0], 5), null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `NodeIndex` not exported.

- [ ] **Step 3: Implement `NodeIndex`** (append to `src/render/layout/topo.ts`, after the helpers)

```ts
/** Uniform grid hash keyed by cell = floor(coord / cellSize). Queries scan the
 *  3×3 neighbourhood of the query cell, which is sufficient when cellSize >= the
 *  query radius. */
export class NodeIndex {
  private cell: number;
  private buckets = new Map<string, Set<string>>();
  private pos = new Map<string, Pixel>();

  constructor(cellSize: number) {
    this.cell = Math.max(1e-6, cellSize);
  }

  private key(p: Pixel): string {
    return Math.floor(p[0] / this.cell) + ',' + Math.floor(p[1] / this.cell);
  }

  insert(id: string, p: Pixel): void {
    this.pos.set(id, p);
    const k = this.key(p);
    let b = this.buckets.get(k);
    if (!b) {
      b = new Set();
      this.buckets.set(k, b);
    }
    b.add(id);
  }

  move(id: string, from: Pixel, to: Pixel): void {
    const k = this.key(from);
    this.buckets.get(k)?.delete(id);
    this.insert(id, to);
  }

  nearest(p: Pixel, radius: number): string | null {
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    let best: string | null = null;
    let bestD = radius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = this.buckets.get(cx + dx + ',' + (cy + dy));
        if (!b) continue;
        for (const id of b) {
          const q = this.pos.get(id)!;
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d <= bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): grid-hash NodeIndex for nearest-node merge lookups"
```

---

## Task D: Mutable support-graph builder (`HBuilder`)

**Files:**
- Modify: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

The merge loop needs a mutable graph supporting `addNode`, `addOrUnionEdge`, snapping a node toward a sample, and degree-2 contraction. Encapsulate it in an internal `HBuilder` class so the round loop stays readable.

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/topo.test.ts`)

```ts
import { HBuilder } from './topo';

test('HBuilder.addOrUnionEdge unions line ids on a repeated node pair', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([10, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(a, b, new Set(['L2']));
  const edges = h.edgeList();
  assert.equal(edges.length, 1);
  assert.deepEqual([...edges[0].lineIds].sort(), ['L1', 'L2']);
});

test('HBuilder.snap averages a node toward a sample', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  h.snap(a, [10, 0]);
  assert.deepEqual(h.nodePos(a), [5, 0]);
});

test('contractDegree2WithMatchingLines collapses a straight matching run', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([10, 0]);
  const c = h.addNode([20, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(b, c, new Set(['L1']));
  h.contractDegree2WithMatchingLines();
  const edges = h.edgeList();
  assert.equal(edges.length, 1);
  // merged polyline keeps the through point b
  assert.equal(edges[0].points.length, 3);
});

test('contractDegree2 does NOT collapse when line sets differ', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([10, 0]);
  const c = h.addNode([20, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(b, c, new Set(['L2']));
  h.contractDegree2WithMatchingLines();
  assert.equal(h.edgeList().length, 2);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `HBuilder` not exported.

- [ ] **Step 3: Implement `HBuilder`** (append to `src/render/layout/topo.ts`)

```ts
interface HEdge {
  id: string;
  a: string;
  b: string;
  points: Pixel[];          // a.pos … b.pos
  lineIds: Set<string>;
}

const setsEqual = (x: Set<string>, y: Set<string>): boolean => {
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
};

/** Mutable working support graph used during the merge rounds. */
export class HBuilder {
  private nodes = new Map<string, Pixel>();
  private edges = new Map<string, HEdge>();
  private adj = new Map<string, Set<string>>(); // nodeId -> edgeIds
  private index: NodeIndex;
  private nId = 0;
  private eId = 0;

  constructor(indexCell: number) {
    this.index = new NodeIndex(indexCell);
  }

  addNode(p: Pixel): string {
    const id = 'h' + this.nId++;
    const pos = p.slice() as Pixel;
    this.nodes.set(id, pos);
    this.adj.set(id, new Set());
    this.index.insert(id, pos);
    return id;
  }

  nodePos(id: string): Pixel {
    return this.nodes.get(id)!;
  }

  nearestNode(p: Pixel, radius: number): string | null {
    return this.index.nearest(p, radius);
  }

  /** Move a node toward `sample`, averaging 50/50 (paper's running average). */
  snap(id: string, sample: Pixel): void {
    const cur = this.nodes.get(id)!;
    const next: Pixel = [(cur[0] + sample[0]) / 2, (cur[1] + sample[1]) / 2];
    this.index.move(id, cur, next);
    this.nodes.set(id, next);
  }

  private edgeKey(a: string, b: string): string {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  addOrUnionEdge(a: string, b: string, lines: Set<string>): void {
    if (a === b) return;
    for (const eid of this.adj.get(a)!) {
      const e = this.edges.get(eid)!;
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) {
        for (const l of lines) e.lineIds.add(l);
        return;
      }
    }
    const id = 'he' + this.eId++;
    const e: HEdge = {
      id,
      a,
      b,
      points: [this.nodes.get(a)!, this.nodes.get(b)!],
      lineIds: new Set(lines),
    };
    this.edges.set(id, e);
    this.adj.get(a)!.add(id);
    this.adj.get(b)!.add(id);
  }

  edgeList(): HEdge[] {
    return [...this.edges.values()];
  }

  totalLength(): number {
    let total = 0;
    for (const e of this.edges.values()) total += polylineLength(e.points);
    return total;
  }

  /** Collapse every degree-2 node whose two edges carry identical line sets,
   *  joining their polylines through the node. */
  contractDegree2WithMatchingLines(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [nid, eids] of this.adj) {
        if (eids.size !== 2) continue;
        const [e1, e2] = [...eids].map((id) => this.edges.get(id)!);
        if (!setsEqual(e1.lineIds, e2.lineIds)) continue;
        const other1 = e1.a === nid ? e1.b : e1.a;
        const other2 = e2.a === nid ? e2.b : e2.a;
        if (other1 === other2) continue; // would create a self-loop
        // Build the joined polyline other1 … nid … other2.
        const p1 = e1.a === nid ? [...e1.points].reverse() : e1.points;
        const p2 = e2.a === nid ? e2.points : [...e2.points].reverse();
        const joined = [...p1, ...p2.slice(1)];
        // Remove the two edges and the node.
        this.detach(e1);
        this.detach(e2);
        this.nodes.delete(nid);
        this.adj.delete(nid);
        const id = 'he' + this.eId++;
        const merged: HEdge = {
          id,
          a: other1,
          b: other2,
          points: joined,
          lineIds: new Set(e1.lineIds),
        };
        this.edges.set(id, merged);
        this.adj.get(other1)!.add(id);
        this.adj.get(other2)!.add(id);
        changed = true;
        break; // restart iteration; adj mutated
      }
    }
  }

  private detach(e: HEdge): void {
    this.edges.delete(e.id);
    this.adj.get(e.a)?.delete(e.id);
    this.adj.get(e.b)?.delete(e.id);
  }

  /** Snapshot the current nodes/edges/adjacency (used between rounds and for
   *  intersection smoothing). */
  snapshot(): { nodes: Map<string, Pixel>; edges: HEdge[]; adj: Map<string, Set<string>> } {
    return {
      nodes: new Map([...this.nodes].map(([k, v]) => [k, v.slice() as Pixel])),
      edges: this.edgeList().map((e) => ({ ...e, points: e.points.map((p) => p.slice() as Pixel), lineIds: new Set(e.lineIds) })),
      adj: new Map([...this.adj].map(([k, v]) => [k, new Set(v)])),
    };
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): mutable HBuilder with union-edge + degree-2 contraction"
```

---

## Task E: Merge rounds (`runMergeRounds`)

**Files:**
- Modify: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

This is the heart of topo — the round loop from the spec pseudocode. It takes the projected `TransitGraph` and produces a merged `HBuilder`. Exported for direct testing before stations are inserted.

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/topo.test.ts`)

```ts
import { runMergeRounds, type TopoParams } from './topo';
import type { TransitGraph, GraphEdge, LineRef } from './types';

function graphFrom(
  nodes: Record<string, [number, number]>,
  edges: Array<{ id: string; from: string; to: string; lines: string[] }>,
): TransitGraph {
  const nodeMap = new Map(
    Object.entries(nodes).map(([id, pos]) => [
      id,
      { id, label: id, pos: pos as [number, number], lngLat: [pos[0] / 1e5, pos[1] / 1e5] as [number, number] },
    ]),
  );
  const ref = (id: string): LineRef => ({ id, label: id, color: '#000' });
  const gEdges: GraphEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    lines: e.lines.map(ref),
    stops: new Map(),
  }));
  const adj = new Map<string, string[]>();
  for (const id of nodeMap.keys()) adj.set(id, []);
  for (const e of gEdges) {
    adj.get(e.from)!.push(e.id);
    adj.get(e.to)!.push(e.id);
  }
  return { nodes: nodeMap, edges: gEdges, adj, lineTraversals: new Map() };
}

const PARAMS: TopoParams = {
  dHat: 20,
  step: 5,
  convergenceEpsilon: 0.002,
  maxRounds: 8,
  stationCandidateRadius: 40,
};

test('two near-parallel edges within d̂ merge to a single corridor edge', () => {
  // Two horizontal edges 8px apart (< d̂=20), same span.
  const g = graphFrom(
    { a0: [0, 0], a1: [100, 0], b0: [0, 8], b1: [100, 8] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L2'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  const edges = h.edgeList();
  // The two runs collapse into one corridor carrying both lines.
  const carriers = edges.filter((e) => e.lineIds.has('L1') && e.lineIds.has('L2'));
  assert.ok(carriers.length >= 1, 'expected a shared corridor edge');
});

test('two parallel edges farther than d̂ stay separate', () => {
  const g = graphFrom(
    { a0: [0, 0], a1: [100, 0], b0: [0, 80], b1: [100, 80] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L2'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  const shared = h.edgeList().filter((e) => e.lineIds.has('L1') && e.lineIds.has('L2'));
  assert.equal(shared.length, 0, 'far edges must not merge');
});

test('a ~90° crossing does not merge (creep blocker prevents interlace)', () => {
  const g = graphFrom(
    { a0: [-100, 0], a1: [100, 0], b0: [0, -100], b1: [0, 100] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L2'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  const shared = h.edgeList().filter((e) => e.lineIds.has('L1') && e.lineIds.has('L2'));
  assert.equal(shared.length, 0, 'crossing edges must not interlace into a shared run');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `runMergeRounds` / `TopoParams` not exported.

- [ ] **Step 3: Implement `TopoParams` + `runMergeRounds`** (append to `src/render/layout/topo.ts`)

```ts
import type { TransitGraph, GraphEdge } from './types';

export interface TopoParams {
  dHat: number;                  // merge distance threshold (px)
  step: number;                  // densification step (px)
  convergenceEpsilon: number;    // edge-length-gap stop (0.002 = 0.2%)
  maxRounds: number;             // hard cap on the outer loop
  stationCandidateRadius: number;// station-insertion search radius (px)
}

interface MergeInput {
  edges: Array<{ a: Pixel; b: Pixel; points: Pixel[]; lineIds: Set<string> }>;
}

function inputFromGraph(g: TransitGraph): MergeInput {
  const edges = g.edges.map((e: GraphEdge) => {
    const a = g.nodes.get(e.from)!.pos;
    const b = g.nodes.get(e.to)!.pos;
    return { a, b, points: [a, b] as Pixel[], lineIds: new Set(e.lines.map((l) => l.id)) };
  });
  return { edges };
}

function inputFromBuilder(h: HBuilder): MergeInput {
  return {
    edges: h.edgeList().map((e) => ({
      a: e.points[0],
      b: e.points[e.points.length - 1],
      points: e.points,
      lineIds: e.lineIds,
    })),
  };
}

/** One merge pass: walk every input edge's densified samples, snapping each to
 *  a nearby existing H node or creating a new one, honouring the creep blocker
 *  and a ring buffer that prevents an edge from snapping back onto a node it
 *  just used. */
function onePass(input: MergeInput, params: TopoParams): HBuilder {
  const { dHat, step } = params;
  const h = new HBuilder(dHat);
  // Shortest edges first → most stable merges (paper).
  const sorted = [...input.edges].sort(
    (x, y) => polylineLength(x.points) - polylineLength(y.points),
  );
  const ringSize = Math.max(1, Math.ceil(dHat / step));
  for (const e of sorted) {
    const samples = densify(e.points, step);
    const blocking: string[] = []; // ring buffer of recently-used node ids
    let vPrev: string | null = null;
    for (let k = 0; k < samples.length; k++) {
      const pk = samples[k];
      let v = h.nearestNode(pk, dHat);
      if (
        v !== null &&
        !blocking.includes(v) &&
        !creepBlocked(h.nodePos(v), pk, samples)
      ) {
        h.snap(v, pk);
      } else {
        v = h.addNode(pk);
      }
      if (vPrev !== null) h.addOrUnionEdge(vPrev, v, e.lineIds);
      blocking.push(v);
      if (blocking.length > ringSize) blocking.shift();
      vPrev = v;
    }
  }
  h.contractDegree2WithMatchingLines();
  return h;
}

export function runMergeRounds(g: TransitGraph, params: TopoParams): HBuilder {
  let h: HBuilder | null = null;
  let prevLen = Infinity;
  for (let round = 1; round <= params.maxRounds; round++) {
    const input = h === null ? inputFromGraph(g) : inputFromBuilder(h);
    h = onePass(input, params);
    const len = h.totalLength();
    if (prevLen !== Infinity && Math.abs(1 - len / prevLen) < params.convergenceEpsilon) {
      break;
    }
    prevLen = len;
  }
  return h!;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS. If the crossing test fails (edges interlaced), verify `creepBlocked` is consulted against `h.nodePos(v)` (the candidate's current position) and that `dHat` in the fixture is smaller than the crossing geometry.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): merge rounds with densify + ring-buffer + convergence"
```

---

## Task F: Intersection smoothing

**Files:**
- Modify: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

Per paper §"Artefacts, Line Creep, and Intersection Smoothing": at each node, crop every adjacent edge's polyline at distance `d̂` from the node, move the node to the average of the cropped endpoints, then reconnect. Implement as a method on `HBuilder`.

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/topo.test.ts`)

```ts
test('intersectionSmoothing recentres a node toward its cropped neighbours', () => {
  const h = new HBuilder(50);
  const c = h.addNode([0, 0]);
  const e = h.addNode([100, 0]);
  const w = h.addNode([-100, 2]);
  h.addOrUnionEdge(c, e, new Set(['L1']));
  h.addOrUnionEdge(c, w, new Set(['L1']));
  h.intersectionSmoothing(40);
  // The node should move toward the average of the two cropped endpoints,
  // which sit symmetric in x but slightly off in y → small y shift, ~0 x.
  const p = h.nodePos(c);
  assert.ok(Math.abs(p[0]) < 1, 'x stays centred');
  assert.ok(p[1] > 0 && p[1] < 2, 'y nudged toward the offset neighbour');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `intersectionSmoothing` not a method.

- [ ] **Step 3: Implement `intersectionSmoothing` + a crop helper** (append to `src/render/layout/topo.ts` top-level helpers, then add the method to `HBuilder`)

Top-level helper (place near `densify`):

```ts
/** Walk `pts` from index 0 and return the point at arclength `d` from the
 *  start (clamped to the polyline end). */
export function pointAtDistance(pts: Pixel[], d: number): Pixel {
  if (pts.length === 0) return [0, 0];
  if (d <= 0) return pts[0].slice() as Pixel;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const segLen = dist(pts[i - 1], pts[i]);
    if (acc + segLen >= d) {
      const t = segLen === 0 ? 0 : (d - acc) / segLen;
      return [
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ];
    }
    acc += segLen;
  }
  return pts.at(-1)!.slice() as Pixel;
}
```

Method on `HBuilder` (add inside the class, before `snapshot`):

```ts
  /** Crop each adjacent edge at distance `dHat` from every node, move the node
   *  to the average of the cropped endpoints, then re-anchor the edge polylines
   *  at the moved node. */
  intersectionSmoothing(dHat: number): void {
    const newPos = new Map<string, Pixel>();
    for (const [nid, eids] of this.adj) {
      if (eids.size === 0) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const eid of eids) {
        const e = this.edges.get(eid)!;
        // Orient the polyline so it starts at this node.
        const pts = e.a === nid ? e.points : [...e.points].reverse();
        const cropped = pointAtDistance(pts, dHat);
        sx += cropped[0];
        sy += cropped[1];
        n++;
      }
      newPos.set(nid, [sx / n, sy / n]);
    }
    for (const [nid, p] of newPos) {
      const old = this.nodes.get(nid)!;
      this.index.move(nid, old, p);
      this.nodes.set(nid, p);
    }
    // Re-anchor edge endpoints to the moved node positions.
    for (const e of this.edges.values()) {
      e.points[0] = this.nodes.get(e.a)!;
      e.points[e.points.length - 1] = this.nodes.get(e.b)!;
    }
  }
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): intersection smoothing (crop + reaverage at nodes)"
```

---

## Task G: Station insertion + line-traversal reconstruction (`buildSupportGraph`)

**Files:**
- Modify: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

This converts the merged `HBuilder` into the public `SupportGraph`: it freezes nodes/edges, reconstructs each line's traversal over the merged edges, copies stop flags onto support nodes, and inserts stations at the best-scoring support nodes (paper's multi-candidate fallback).

Station scoring rule (from spec): for each station group, gather the original input edges incident to its stops. Within `stationCandidateRadius` of the group centroid, rank candidate support nodes by the count of original-edges-shared with the cluster, where an original edge "is served" by a support node if that node is an endpoint of a support edge whose `lineIds` includes one of the original edge's lines. Place the station at the top candidate; if it doesn't cover every incident original edge, place a second station for the unserved edges.

Line-traversal reconstruction rule: map each consecutive pair of original-node positions in a line's traversal to their nearest support nodes; for each pair, BFS through support edges whose `lineIds` include the line to find a node path; emit `{edgeId, reversed}` steps.

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/topo.test.ts`)

```ts
import { buildSupportGraph } from './topo';
import type { StationGroup } from './types';

test('buildSupportGraph reconstructs a single line traversal over merged edges', () => {
  const g = graphFrom(
    { a: [0, 0], b: [100, 0], c: [200, 0] },
    [
      { id: 'e0', from: 'a', to: 'b', lines: ['L1'] },
      { id: 'e1', from: 'b', to: 'c', lines: ['L1'] },
    ],
  );
  g.lineTraversals.set('L1', [
    { edgeId: 'e0', reversed: false },
    { edgeId: 'e1', reversed: false },
  ]);
  const groups: StationGroup[] = [
    { id: 'a', name: 'A', center: [0, 0], stationIds: [] },
    { id: 'b', name: 'B', center: [100 / 1e5, 0], stationIds: [] },
    { id: 'c', name: 'C', center: [200 / 1e5, 0], stationIds: [] },
  ];
  const h = buildSupportGraph(g, groups, PARAMS);
  assert.ok(h.lineTraversals.has('L1'));
  // L1 covers the whole corridor; its traversal touches every support edge.
  const used = new Set(h.lineTraversals.get('L1')!.map((s) => s.edgeId));
  assert.equal(used.size, h.edges.size);
});

test('insertStations places one station when all incident edges share a node', () => {
  // Star: 4 lines meeting at b. One support node should serve all of them.
  const g = graphFrom(
    { b: [0, 0], n: [0, 100], s: [0, -100], e: [100, 0], w: [-100, 0] },
    [
      { id: 'e0', from: 'b', to: 'n', lines: ['L1'] },
      { id: 'e1', from: 'b', to: 's', lines: ['L2'] },
      { id: 'e2', from: 'b', to: 'e', lines: ['L3'] },
      { id: 'e3', from: 'b', to: 'w', lines: ['L4'] },
    ],
  );
  const groups: StationGroup[] = [{ id: 'b', name: 'B', center: [0, 0], stationIds: [] }];
  const h = buildSupportGraph(g, groups, PARAMS);
  assert.equal(h.stations.size, 1);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `buildSupportGraph` not exported.

- [ ] **Step 3: Implement `buildSupportGraph`** (append to `src/render/layout/topo.ts`)

```ts
import type { StationGroup, SupportGraph, SupportNode, SupportEdge, SupportStation, LineRef, TraversalStep } from './types';

/** Project a station group's [lng,lat] centre into the same pixel space the
 *  graph nodes use. We reuse the graph's own node positions: the projection is
 *  already baked into GraphNode.pos, so we re-derive each group's pixel from the
 *  matching graph node when present, else fall back to a scaled lng/lat. */
function groupPixel(group: StationGroup, g: TransitGraph): Pixel {
  const n = g.nodes.get(group.id);
  if (n) return n.pos;
  return [group.center[0] * 1e5, group.center[1] * 1e5];
}

function freezeBuilder(h: HBuilder, g: TransitGraph): {
  nodes: Map<string, SupportNode>;
  edges: Map<string, SupportEdge>;
  adj: Map<string, string[]>;
  index: NodeIndex;
} {
  const snap = h.snapshot();
  const nodes = new Map<string, SupportNode>();
  const index = new NodeIndex(50);
  for (const [id, pos] of snap.nodes) {
    nodes.set(id, { id, pos });
    index.insert(id, pos);
  }
  const edges = new Map<string, SupportEdge>();
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of snap.edges) {
    edges.set(e.id, { id: e.id, from: e.a, to: e.b, points: e.points, lineIds: e.lineIds });
    adj.get(e.a)!.push(e.id);
    adj.get(e.b)!.push(e.id);
  }
  return { nodes, edges, adj, index };
}

/** BFS through support edges whose lineIds include `lineId`, from `src` to
 *  `dst`. Returns the ordered support-edge steps, or null if unreachable. */
function bfsLinePath(
  src: string,
  dst: string,
  lineId: string,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
): TraversalStep[] | null {
  if (src === dst) return [];
  const prev = new Map<string, { node: string; edgeId: string }>();
  const seen = new Set<string>([src]);
  const queue = [src];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const eid of adj.get(cur) ?? []) {
      const e = edges.get(eid)!;
      if (!e.lineIds.has(lineId)) continue;
      const nxt = e.from === cur ? e.to : e.from;
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, { node: cur, edgeId: eid });
      if (nxt === dst) {
        const steps: TraversalStep[] = [];
        let at = dst;
        while (at !== src) {
          const back = prev.get(at)!;
          const e = edges.get(back.edgeId)!;
          steps.push({ edgeId: back.edgeId, reversed: e.from !== back.node });
          at = back.node;
        }
        steps.reverse();
        return steps;
      }
      queue.push(nxt);
    }
  }
  return null;
}

export function buildSupportGraph(
  g: TransitGraph,
  groups: StationGroup[],
  params: TopoParams,
): SupportGraph {
  const builder = runMergeRounds(g, params);
  builder.intersectionSmoothing(params.dHat);
  const { nodes, edges, adj, index } = freezeBuilder(builder, g);

  const lineRefs = new Map<string, LineRef>();
  for (const e of g.edges) for (const l of e.lines) if (!lineRefs.has(l.id)) lineRefs.set(l.id, l);

  // Reconstruct line traversals over the merged edges.
  const lineTraversals = new Map<string, TraversalStep[]>();
  for (const [lineId, origSteps] of g.lineTraversals) {
    // Ordered original node ids along the line.
    const seq: string[] = [];
    for (const step of origSteps) {
      const e = g.edges.find((x) => x.id === step.edgeId);
      if (!e) continue;
      const from = step.reversed ? e.to : e.from;
      const to = step.reversed ? e.from : e.to;
      if (seq.length === 0) seq.push(from);
      if (seq[seq.length - 1] !== to) seq.push(to);
    }
    // Map each original node to its nearest support node, collapse dups.
    const supportSeq: string[] = [];
    for (const nid of seq) {
      const gp = g.nodes.get(nid);
      if (!gp) continue;
      const sn = index.nearest(gp.pos, params.dHat * 2) ?? index.nearest(gp.pos, Infinity);
      if (sn && supportSeq[supportSeq.length - 1] !== sn) supportSeq.push(sn);
    }
    const steps: TraversalStep[] = [];
    for (let i = 0; i < supportSeq.length - 1; i++) {
      const seg = bfsLinePath(supportSeq[i], supportSeq[i + 1], lineId, edges, adj);
      if (seg) steps.push(...seg);
    }
    if (steps.length > 0) lineTraversals.set(lineId, steps);
  }

  // Stop flags: a line stops at a support node if it stopped at the original
  // node nearest to it.
  const stopAt = new Set<string>();
  for (const e of g.edges) {
    for (const [lineId, flags] of e.stops) {
      const place = (origNodeId: string, stops: boolean) => {
        if (!stops) return;
        const gp = g.nodes.get(origNodeId);
        if (!gp) return;
        const sn = index.nearest(gp.pos, params.dHat * 2);
        if (sn) stopAt.add(lineId + '|' + sn);
      };
      place(e.from, flags.atFrom);
      place(e.to, flags.atTo);
    }
  }

  // Insert stations.
  const stations = new Map<string, SupportStation>();
  const origIncident = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    for (const nid of [e.from, e.to]) {
      const arr = origIncident.get(nid) ?? [];
      arr.push(e);
      origIncident.set(nid, arr);
    }
  }

  for (const group of groups) {
    const incident = origIncident.get(group.id);
    if (!incident || incident.length === 0) continue;
    const wantLines = new Set<string>();
    for (const e of incident) for (const l of e.lines) wantLines.add(l.id);

    const centroid = groupPixel(group, g);
    // Candidate support nodes within radius, scored by served-line count.
    const candidates: Array<{ id: string; served: Set<string> }> = [];
    for (const [nid, node] of nodes) {
      if (dist(node.pos, centroid) > params.stationCandidateRadius) continue;
      const served = new Set<string>();
      for (const eid of adj.get(nid) ?? []) {
        for (const l of edges.get(eid)!.lineIds) if (wantLines.has(l)) served.add(l);
      }
      if (served.size > 0) candidates.push({ id: nid, served });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.served.size - a.served.size);

    const used = new Set<string>();
    let idx = 0;
    for (const cand of candidates) {
      const adds = [...cand.served].filter((l) => !used.has(l));
      if (adds.length === 0) continue;
      for (const l of adds) used.add(l);
      const stationId = idx === 0 ? group.id : group.id + '__alt' + idx;
      stations.set(stationId, {
        id: stationId,
        label: group.name,
        lngLat: group.center,
        nodeId: cand.id,
      });
      idx++;
      if (used.size >= wantLines.size) break;
    }
  }

  return { nodes, edges, adj, lineRefs, lineTraversals, stations, stopAt };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS (both new tests + all prior topo tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): support-graph freeze, traversal reconstruction, insertStations"
```

---

## Task H: Public `topo()` entry + parameter derivation

**Files:**
- Modify: `src/render/layout/topo.ts`
- Test: `src/render/layout/topo.test.ts`

Add the one-call entry that derives `d̂`, `l`, and the radii from the spec's defaults, then calls `buildSupportGraph`.

Parameter defaults (spec table):
- `maxLinesPerCorridor = max(|L(e)|)` over all input edges, floor 2.
- `d̂ = 2.5 × lineWidth × maxLinesPerCorridor`.
- `l = max(2, d̂ / 4)`.
- `convergenceEpsilon = 0.002`, `maxRounds = 8`, `stationCandidateRadius = 2 × d̂`.

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/topo.test.ts`)

```ts
import { topo } from './topo';

test('topo derives d̂ from line width and corridor capacity', () => {
  const g = graphFrom(
    { a0: [0, 0], a1: [100, 0], b0: [0, 8], b1: [100, 8] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1', 'L2'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L3'] },
    ],
  );
  const groups: StationGroup[] = [
    { id: 'a0', name: 'A0', center: [0, 0], stationIds: [] },
    { id: 'a1', name: 'A1', center: [100 / 1e5, 0], stationIds: [] },
    { id: 'b0', name: 'B0', center: [0, 8 / 1e5], stationIds: [] },
    { id: 'b1', name: 'B1', center: [100 / 1e5, 8 / 1e5], stationIds: [] },
  ];
  // lineWidth 4, maxLinesPerCorridor = 2 → d̂ = 2.5*4*2 = 20
  const h = topo(g, groups, { lineWidth: 4 });
  assert.ok(h.nodes.size > 0);
  assert.ok(h.edges.size > 0);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: FAIL — `topo` not exported.

- [ ] **Step 3: Implement `topo`** (append to `src/render/layout/topo.ts`)

```ts
export interface TopoOptions {
  /** theme.lineWidth in SVG units. */
  lineWidth: number;
}

export function topo(
  g: TransitGraph,
  groups: StationGroup[],
  opts: TopoOptions,
): SupportGraph {
  let maxLines = 2;
  for (const e of g.edges) maxLines = Math.max(maxLines, e.lines.length);
  const dHat = 2.5 * opts.lineWidth * maxLines;
  const params: TopoParams = {
    dHat,
    step: Math.max(2, dHat / 4),
    convergenceEpsilon: 0.002,
    maxRounds: 8,
    stationCandidateRadius: 2 * dHat,
  };
  return buildSupportGraph(g, groups, params);
}
```

- [ ] **Step 4: Run the full topo suite**

Run: `pnpm exec tsx --test src/render/layout/topo.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m "feat(topo): public topo() entry with paper-default parameter derivation"
```

---

## Task I: Wire topo into geographic mode behind `useTopoMerge`

**Files:**
- Modify: `src/render/types.ts` (add `useTopoMerge` option)
- Modify: `src/render/renderGeographic.ts` (render support-graph ribbons when enabled)

When `useTopoMerge` is on, geographic mode renders the support graph's merged corridors via `renderRibbons` (so parallel runs bundle in the graph, not just at render time). When off, the existing per-route polyline path runs unchanged. Default is off this stage (flipped on in Stage 3).

- [ ] **Step 1: Add the option** in `src/render/types.ts`

In `SchematicOptions`, after `showGrid?`, add:

```ts
  /** When true, geographic + smoothed modes run the LOOM topo merge so
   *  parallel corridors bundle in the graph. Default off until tuned. */
  useTopoMerge?: boolean;
```

- [ ] **Step 2: Add a support-graph → Layout adapter** in `src/render/renderGeographic.ts`

Add this import near the other layout imports:

```ts
import { topo } from './layout/topo';
import type { SupportGraph } from './layout/types';
```

Add this helper above `renderGeographic`:

```ts
/** Adapt a topo SupportGraph into the Layout shape renderRibbons consumes.
 *  Node "cells" are pixels (identity edgePolyline), edge paths are the merged
 *  corridor polylines, and stops come from the support graph's stopAt set. */
function supportToLayout(h: SupportGraph): { layout: Layout; nodePx: Map<string, Pixel> } {
  const nodes = new Map<string, LayoutNode>();
  const nodePx = new Map<string, Pixel>();
  // Render stations at their support-node positions; label by station.
  const labelByNode = new Map<string, string>();
  for (const st of h.stations.values()) labelByNode.set(st.nodeId, st.label);
  for (const [id, n] of h.nodes) {
    nodes.set(id, {
      id,
      cell: [n.pos[0], n.pos[1]] as Cell,
      label: labelByNode.get(id) ?? '',
      lngLat: [n.pos[0] / 1e5, n.pos[1] / 1e5] as Coordinate,
    });
    nodePx.set(id, n.pos);
  }
  const edges: LayoutEdge[] = [];
  for (const e of h.edges.values()) {
    const lines = [...e.lineIds].map((id) => h.lineRefs.get(id)!).filter(Boolean);
    const stops = new Map<string, EdgeStop>();
    for (const id of e.lineIds) {
      const atFrom = h.stopAt.has(id + '|' + e.from);
      const atTo = h.stopAt.has(id + '|' + e.to);
      if (atFrom || atTo) stops.set(id, { atFrom, atTo });
    }
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      path: e.points.map((p) => [p[0], p[1]] as Cell),
      lines,
      lineOrder: lines.map((l) => l.id).sort(),
      stops,
    });
  }
  const layout: Layout = { cellSize: 1, nodes, edges, lineTraversals: h.lineTraversals };
  return { layout, nodePx };
}
```

Add the needed type imports to the existing import of `./layout/types`:

```ts
import type { Pixel, StopMark, TransitGraph, Layout, LayoutNode, LayoutEdge, Cell, EdgeStop } from './layout/types';
```

- [ ] **Step 3: Branch geographic rendering on the flag**

In `renderGeographic`, immediately after the `if (input.smooth) { return renderSmoothed(input, opts); }` block, add:

```ts
  if (opts.useTopoMerge) {
    return renderGeographicTopo(input, opts);
  }
```

Then add the new function below `renderGeographic`:

```ts
function renderGeographicTopo(input: GeoInput, opts: SchematicOptions): string {
  const { width, height, padding, dark } = opts;
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const groups = getOrBuildStationGroups(input.stations as never, input.stationGroups);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, options: { ...input.options, useTopoMerge: false } });
  }

  // Frame on geography; project each node position into pixels.
  const bounds = (() => {
    const b = computeBounds([...graph.nodes.values()].map((n) => ({ points: [n.lngLat] })));
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

  const h = topo(graph, groups, { lineWidth: theme.lineWidth });
  const { layout, nodePx } = supportToLayout(h);
  orderLines(layout);

  const transfers = findTransferPairs(routedGroupsOnly(groups, graph), DEFAULT_TRANSFER_METERS);

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
    width,
    height,
    dark,
    showLabels: opts.showLabels,
    water: input.water,
    transfers,
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Visual smoke test (manual)**

Temporarily enable the flag in the harness by editing `dev/render-test.ts` line 52 options to `{ mode, width: 2700, height: 2700, showStations: true, showLabels: true, useTopoMerge: true }`, then run:

Run: `pnpm render`
Expected: `dev/out-geo.svg` written without error. Open it; parallel corridors (e.g. shared trunk lines) should now render as a single bundled ribbon rather than separate squiggles. Revert the harness edit afterward (the flag default stays off until Stage 3).

- [ ] **Step 6: Commit**

```bash
git add src/render/types.ts src/render/renderGeographic.ts
git commit -m "feat(geographic): render LOOM support graph behind useTopoMerge flag"
```

> **VISUAL CHECKPOINT 1.** Re-run `pnpm render` with `useTopoMerge: true` against both the NYC default save and a Seattle save (`tsx dev/render-test.ts <seattle-save.json> sea_water.geojson`). Eyeball `dev/out-geo.svg` for bundled corridors before continuing to Stage 2. Surface the SVGs to the user for sign-off.

---

# STAGE 2 — OCTI

## Task J: Multi-source / multi-target Dijkstra

**Files:**
- Modify: `src/render/layout/dijkstra.ts` (add `dijkstraMulti`)
- Test: `src/render/layout/dijkstra.test.ts`

`octi` routes between candidate *sets* `U` and `V`, with per-source and per-target entry costs (sink-edge costs). Add a multi-source/multi-target variant alongside the existing single-pair `dijkstra` (keep that one — schematic mode might still reference it; do not modify it).

- [ ] **Step 1: Write the failing test** (append to `src/render/layout/dijkstra.test.ts`)

```ts
import { dijkstraMulti } from './dijkstra';

test('dijkstraMulti picks the cheapest source/target pair including entry costs', () => {
  // graph: s1 -(1)- m -(1)- t1 ; s2 -(1)- m ; m -(1)- t2
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['s1', [{ to: 'm', w: 1 }]],
    ['s2', [{ to: 'm', w: 1 }]],
    ['m', [{ to: 't1', w: 1 }, { to: 't2', w: 1 }]],
    ['t1', []],
    ['t2', []],
  ]);
  // Make s2 cheaper to enter, t2 cheaper to exit.
  const res = dijkstraMulti(
    new Map([['s1', 10], ['s2', 0]]),
    new Map([['t1', 10], ['t2', 0]]),
    (n) => adj.get(n) ?? [],
    100,
  );
  assert.ok(res);
  assert.equal(res!.path[0], 's2');
  assert.equal(res!.path.at(-1), 't2');
  // cost = entry(s2)=0 + edge s2->m=1 + edge m->t2=1 + entry(t2)=0 = 2
  assert.equal(res!.cost, 2);
});

test('dijkstraMulti returns null when no source reaches any target', () => {
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['s', []],
    ['t', []],
  ]);
  const res = dijkstraMulti(new Map([['s', 0]]), new Map([['t', 0]]), (n) => adj.get(n) ?? [], 100);
  assert.equal(res, null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/dijkstra.test.ts`
Expected: FAIL — `dijkstraMulti` not exported.

- [ ] **Step 3: Implement `dijkstraMulti`** (append to `src/render/layout/dijkstra.ts`)

```ts
/**
 * Multi-source / multi-target Dijkstra with per-endpoint entry costs.
 *
 * `sources` maps a start node to its entry cost (added to the path cost).
 * `targets` maps a goal node to its exit cost. The cheapest source→target path
 * (including both endpoint costs) is returned. No heuristic — the octi grid is
 * small per query and bend costs are encoded as edges, so plain Dijkstra is
 * correct.
 */
export function dijkstraMulti<NodeId>(
  sources: Map<NodeId, number>,
  targets: Map<NodeId, number>,
  neighbors: (n: NodeId) => Iterable<DijkstraEdge<NodeId>>,
  expansionBudget = 200_000,
): DijkstraResult<NodeId> | null {
  const keyFn = (n: NodeId) => String(n);
  const targetCost = new Map<string, number>();
  for (const [t, c] of targets) targetCost.set(keyFn(t), c);

  const best = new Map<string, number>();
  const parent = new Map<string, NodeId | null>();
  const open = new MinHeap<NodeId>();
  for (const [s, c] of sources) {
    const k = keyFn(s);
    if (c < (best.get(k) ?? Infinity)) {
      best.set(k, c);
      parent.set(k, null);
      open.push(c, s);
    }
  }

  let expanded = 0;
  let bestGoal: { node: NodeId; total: number } | null = null;
  while (open.size > 0) {
    const top = open.pop()!;
    const cur = top.v;
    const curKey = keyFn(cur);
    const curBest = best.get(curKey) ?? Infinity;
    if (top.p > curBest + 1e-9) continue;

    const exit = targetCost.get(curKey);
    if (exit !== undefined) {
      const total = curBest + exit;
      if (!bestGoal || total < bestGoal.total) bestGoal = { node: cur, total };
    }
    // Once the cheapest open entry exceeds the best completed goal, stop.
    if (bestGoal && curBest >= bestGoal.total) break;

    if (++expanded > expansionBudget) break;

    for (const edge of neighbors(cur)) {
      const g = curBest + edge.w;
      const k = keyFn(edge.to);
      if (g < (best.get(k) ?? Infinity)) {
        best.set(k, g);
        parent.set(k, cur);
        open.push(g, edge.to);
      }
    }
  }

  if (!bestGoal) return null;
  const path: NodeId[] = [];
  let n: NodeId | null = bestGoal.node;
  while (n !== null) {
    path.push(n);
    const p = parent.get(keyFn(n));
    n = p === undefined ? null : p;
  }
  path.reverse();
  return { path, cost: bestGoal.total };
}
```

> Note: `MinHeap`, `DijkstraEdge`, and `DijkstraResult` already exist in `dijkstra.ts`. `MinHeap` is currently a top-level class in that file — it is in scope for the new function; no export needed.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/dijkstra.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/dijkstra.ts src/render/layout/dijkstra.test.ts
git commit -m "feat(dijkstra): multi-source/target variant with entry/exit costs"
```

---

## Task K: Extended octilinear grid `Γ'` (`octiGrid.ts`)

**Files:**
- Create: `src/render/layout/octiGrid.ts`
- Test: `src/render/layout/octiGrid.test.ts`

Build the grid from the paper §2.1: a square base grid of cell `d_g`; per base node, 8 port nodes (one per direction), sink edges port↔center, bend edges between every port pair (weighted by turn angle), and inter-node grid edges port→opposite-port-on-neighbour (axis 1.0, diagonal 1.5). Apply the no-shortcut correction.

Bend weights before correction: `w_180=0, w_135=1, w_90=3, w_45=9`. Correction: `a = w_45 − w_135 = 8`; add `a` to every bend weight and subtract `a` from every grid edge weight. Since grid-edge weights can't go negative in cost terms, we instead keep the relationship by adding `a` to bends only and adding `a` back as a constant per traversed grid edge — equivalently, store corrected bends `[8,9,11,17]` and corrected grid-edge base weights `axis = 1.0` (paper subtracts `a` from grid edges, but to keep them positive we add `a` to the *bend* side only and leave grid edges as-is; the monotonic ordering and the "no acute-bend shortcut" property are preserved because every path crossing a base node pays exactly one bend, so the constant cancels in comparisons). Implement the simple corrected form: `bendWeight(steps) = base[steps] + a`.

Direction indices for ports match the global convention (`0=E … 7=SE`). Neighbour offsets per direction:
`E=(+1,0), NE=(+1,+1), N=(0,+1), NW=(−1,+1), W=(−1,0), SW=(−1,−1), S=(0,−1), SE=(+1,−1)`.

- [ ] **Step 1: Write the failing test** (`src/render/layout/octiGrid.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bendWeight,
  buildOctiGrid,
  DIRECTIONS,
  type OctiGrid,
} from './octiGrid';

test('bend weights are monotone after the no-shortcut correction', () => {
  // turn-step distance 0..4 → 180,135,90,45-equivalent.
  const w0 = bendWeight(0); // straight (180)
  const w1 = bendWeight(1); // 135
  const w2 = bendWeight(2); // 90
  const w4 = bendWeight(4); // 45 (sharpest)
  assert.ok(w0 <= w1 && w1 <= w2 && w2 <= w4);
});

test('a single base node has 8 ports, 8 sinks, and C(8,2)=28 bend edges', () => {
  const grid = buildOctiGrid({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 10);
  const base = grid.baseNodes[0];
  assert.equal(base.ports.length, 8);
  let sinks = 0;
  let bends = 0;
  for (const e of grid.edges) {
    if (e.kind === 'sink' && e.base === base.id) sinks++;
    if (e.kind === 'bend' && e.base === base.id) bends++;
  }
  assert.equal(sinks, 8);
  assert.equal(bends, 28);
});

test('a 3x3 base grid produces axis edges weighted 1.0 and diagonal 1.5', () => {
  const grid = buildOctiGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 10);
  const axis = grid.edges.find((e) => e.kind === 'grid' && e.dir === DIRECTIONS.E);
  const diag = grid.edges.find((e) => e.kind === 'grid' && e.dir === DIRECTIONS.NE);
  assert.ok(axis && Math.abs(axis.w - 1.0) < 1e-9);
  assert.ok(diag && Math.abs(diag.w - 1.5) < 1e-9);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/octiGrid.test.ts`
Expected: FAIL — `octiGrid.ts` does not exist.

- [ ] **Step 3: Implement `octiGrid.ts`**

```ts
// LOOM octi: the extended octilinear grid Γ'. Base square grid; each base node
// expands into 8 port nodes (one per octilinear direction) joined to the centre
// by sink edges and to each other by bend edges; ports link to the opposite
// port of the neighbour in their direction via grid edges.
// Reference: Brosi & Bast 2024, §"Map Schematization".

import type { Pixel } from './types';

export const DIRECTIONS = {
  E: 0, NE: 1, N: 2, NW: 3, W: 4, SW: 5, S: 6, SE: 7,
} as const;

/** Grid-cell offset (col,row) per direction index, +row = up. */
const OFFSET: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** Base bend weights by turn-step distance 0..4: 180,135,90,(unused 67.5),45. */
const BEND_BASE = [0, 1, 3, 9, 9];
/** No-shortcut correction constant a = w_45 − w_135 = 8. */
const A = BEND_BASE[4] - BEND_BASE[1];

/** Turn-step distance (0..4) between two octilinear direction indices. */
export function turnSteps(d1: number, d2: number): number {
  const d = Math.abs(d1 - d2) % 8;
  return Math.min(d, 8 - d);
}

/** Corrected bend weight for a turn of `steps` 45° increments. */
export function bendWeight(steps: number): number {
  return BEND_BASE[Math.min(steps, 4)] + A;
}

export interface OctiPort {
  id: string;       // `${baseId}:p${dir}`
  base: string;
  dir: number;
  pos: Pixel;
}

export interface OctiBaseNode {
  id: string;       // `b${col}_${row}`
  col: number;
  row: number;
  pos: Pixel;       // centre
  ports: OctiPort[];
}

export type OctiEdgeKind = 'sink' | 'bend' | 'grid';

export interface OctiEdge {
  from: string;
  to: string;
  w: number;
  kind: OctiEdgeKind;
  base: string;     // owning base node (sink/bend); for grid, the source base
  dir: number;      // grid edge direction; -1 for sink/bend
}

export interface OctiGrid {
  cellSize: number;
  baseNodes: OctiBaseNode[];
  /** base centre node id -> base node. */
  baseById: Map<string, OctiBaseNode>;
  /** node id (centre or port) -> position. */
  pos: Map<string, Pixel>;
  /** undirected edge list (each grid/bend/sink edge appears once per direction
   *  pair as needed; callers build adjacency). */
  edges: OctiEdge[];
  /** adjacency: node id -> outgoing OctiEdge[] (both directions populated). */
  adj: Map<string, OctiEdge[]>;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const PORT_OFFSET = 0.01; // ports sit a hair off the centre, along their dir.

export function buildOctiGrid(bounds: Bounds, cellSize: number, padCells = 2): OctiGrid {
  const cols0 = Math.floor(bounds.minX / cellSize) - padCells;
  const cols1 = Math.ceil(bounds.maxX / cellSize) + padCells;
  const rows0 = Math.floor(bounds.minY / cellSize) - padCells;
  const rows1 = Math.ceil(bounds.maxY / cellSize) + padCells;

  const baseNodes: OctiBaseNode[] = [];
  const baseById = new Map<string, OctiBaseNode>();
  const pos = new Map<string, Pixel>();
  const baseAt = new Map<string, OctiBaseNode>(); // "col,row" -> base

  for (let col = cols0; col <= cols1; col++) {
    for (let row = rows0; row <= rows1; row++) {
      const id = 'b' + col + '_' + row;
      const centre: Pixel = [col * cellSize, row * cellSize];
      const ports: OctiPort[] = [];
      for (let d = 0; d < 8; d++) {
        const [ox, oy] = OFFSET[d];
        const len = Math.hypot(ox, oy);
        const port: OctiPort = {
          id: id + ':p' + d,
          base: id,
          dir: d,
          pos: [centre[0] + (ox / len) * cellSize * PORT_OFFSET, centre[1] + (oy / len) * cellSize * PORT_OFFSET],
        };
        ports.push(port);
        pos.set(port.id, port.pos);
      }
      const node: OctiBaseNode = { id, col, row, pos: centre, ports };
      pos.set(id, centre);
      baseNodes.push(node);
      baseById.set(id, node);
      baseAt.set(col + ',' + row, node);
    }
  }

  const edges: OctiEdge[] = [];
  const adj = new Map<string, OctiEdge[]>();
  const link = (from: string, to: string, w: number, kind: OctiEdgeKind, base: string, dir: number) => {
    const e: OctiEdge = { from, to, w, kind, base, dir };
    const back: OctiEdge = { from: to, to: from, w, kind, base, dir };
    edges.push(e);
    (adj.get(from) ?? adj.set(from, []).get(from)!).push(e);
    (adj.get(to) ?? adj.set(to, []).get(to)!).push(back);
  };

  for (const node of baseNodes) {
    // Sink edges: centre <-> each port. Weight is set per query (default 0).
    for (const p of node.ports) link(node.id, p.id, 0, 'sink', node.id, -1);
    // Bend edges: every unordered port pair.
    for (let i = 0; i < node.ports.length; i++) {
      for (let j = i + 1; j < node.ports.length; j++) {
        const steps = turnSteps(node.ports[i].dir, node.ports[j].dir);
        link(node.ports[i].id, node.ports[j].id, bendWeight(steps), 'bend', node.id, -1);
      }
    }
    // Grid edges: port d <-> opposite port of neighbour in direction d.
    for (const p of node.ports) {
      const [ox, oy] = OFFSET[p.dir];
      const nbr = baseAt.get(node.col + ox + ',' + (node.row + oy));
      if (!nbr) continue;
      const opp = (p.dir + 4) % 8;
      const nbrPort = nbr.ports[opp];
      // Only emit each grid edge once (from the lower base id).
      if (node.id < nbr.id) {
        const w = p.dir % 2 === 0 ? 1.0 : 1.5;
        link(p.id, nbrPort.id, w, 'grid', node.id, p.dir);
      }
    }
  }

  return { cellSize, baseNodes, baseById, pos, edges, adj };
}
```

> Note on the `adj.get(...) ?? adj.set(...).get(...)!` idiom: `Map.set` returns the map, so `.get(from)!` after it yields the freshly-inserted array. This keeps `link` a one-liner. If a reviewer prefers, expand it to an explicit `if (!adj.has(from)) adj.set(from, [])` block.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/octiGrid.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/render/layout/octiGrid.ts src/render/layout/octiGrid.test.ts
git commit -m "feat(octiGrid): extended octilinear grid with ports, sinks, bends"
```

---

## Task L: Octi placement core (`octi.ts`)

**Files:**
- Create: `src/render/layout/octi.ts`
- Test: `src/render/layout/octi.test.ts`

The iterative shortest-path placement (paper §2.2), heuristic (no ILP). Implements:
- `d_g = median support-edge length` (floor for tiny graphs).
- Importance ordering: line count desc, then length desc.
- `candidateSet(u)`: settled → just its grid node; else Voronoi-partition grid base nodes within `displacementRadius`, keeping those strictly closer to `u` than to `v`.
- Per-query sink-edge costs at candidate ports = displacement `d(u,ψ)·w_m` + adjacent-edge bend (against settled adjacent edges, line-weighted) + ordering block (`LARGE_FINITE`) for circular-order violations.
- Used grid edges get `LARGE_FINITE` added (constraint relaxation).
- `geographicAffinity`: add `w_geo · dist²(midpoint, course)` to grid-edge costs.
- Stalling: on null path, shrink `d_g` by 10% and rebuild; ≤ 3 retries, then direct snapped segment.

To keep per-query routing simple, `octi` builds the grid once, then for each edge constructs the source map `U` (centre nodes of candidate base nodes, with the composite entry cost) and target map `V`, and runs `dijkstraMulti` over a per-query neighbour function that (a) reads base grid/bend/sink weights from the grid adjacency, (b) overrides sink-edge weights for the current `U`/`V` ports, (c) adds the relaxation penalty for used grid edges, and (d) adds the geographic-affinity term.

This task is large; implement and test in two sub-steps: first the geometry/candidate helpers (Step 1–4), then the full `octi()` loop (Step 5–8).

- [ ] **Step 1: Write failing tests for the helpers** (`src/render/layout/octi.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianEdgeLength, candidateBaseNodes } from './octi';
import { buildOctiGrid } from './octiGrid';
import type { SupportGraph } from './types';

function chain(positions: Array<[number, number]>, lineId = 'L1'): SupportGraph {
  const nodes = new Map();
  positions.forEach((p, i) => nodes.set('n' + i, { id: 'n' + i, pos: p }));
  const edges = new Map();
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (let i = 0; i < positions.length - 1; i++) {
    const id = 'he' + i;
    edges.set(id, { id, from: 'n' + i, to: 'n' + (i + 1), points: [positions[i], positions[i + 1]], lineIds: new Set([lineId]) });
    adj.get('n' + i)!.push(id);
    adj.get('n' + (i + 1))!.push(id);
  }
  return {
    nodes,
    edges,
    adj,
    lineRefs: new Map([[lineId, { id: lineId, label: lineId, color: '#000' }]]),
    lineTraversals: new Map([[lineId, [...edges.keys()].map((edgeId) => ({ edgeId, reversed: false }))]]),
    stations: new Map(),
    stopAt: new Set(),
  };
}

test('medianEdgeLength returns the median support-edge length', () => {
  const h = chain([[0, 0], [10, 0], [40, 0]]); // lengths 10, 30
  assert.equal(medianEdgeLength(h), 20); // median of [10,30] = (10+30)/2
});

test('candidateBaseNodes keeps grid nodes strictly closer to u than to v', () => {
  const grid = buildOctiGrid({ minX: 0, minY: 0, maxX: 100, maxY: 0 }, 10);
  const u: [number, number] = [0, 0];
  const v: [number, number] = [100, 0];
  const cands = candidateBaseNodes(grid, u, v, 40);
  // every candidate must be closer to u than to v
  for (const b of cands) {
    const du = Math.hypot(b.pos[0] - u[0], b.pos[1] - u[1]);
    const dv = Math.hypot(b.pos[0] - v[0], b.pos[1] - v[1]);
    assert.ok(du < dv);
    assert.ok(du <= 40 + 1e-9);
  }
  assert.ok(cands.length > 0);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/octi.test.ts`
Expected: FAIL — `octi.ts` does not exist.

- [ ] **Step 3: Implement the helpers + options** (`src/render/layout/octi.ts`)

```ts
// LOOM octi: schematicize a support graph by jointly placing stations on an
// octilinear grid and routing each edge octilinearly (iterative shortest-path
// heuristic; no ILP). Reference: Brosi & Bast 2024, §"Map Schematization".

import type { Pixel, SupportGraph, SupportEdge, Image } from './types';
import { buildOctiGrid, bendWeight, turnSteps, type OctiGrid, type OctiBaseNode, type OctiEdge } from './octiGrid';
import { dijkstraMulti } from './dijkstra';

export interface OctiOptions {
  /** 0 = pure schematic, 1 = pull hard toward geographic course. Default 0.5. */
  geographicAffinity: number;
  /** Override base grid cell size; default = median support-edge length. */
  cellSize?: number;
}

export const DEFAULT_OCTI_OPTIONS: OctiOptions = { geographicAffinity: 0.5 };

const LARGE_FINITE_K = 10_000; // × d_g
const MAX_STALL_RETRIES = 3;

function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function medianEdgeLength(h: SupportGraph): number {
  const lens: number[] = [];
  for (const e of h.edges.values()) {
    let total = 0;
    for (let i = 1; i < e.points.length; i++) total += dist(e.points[i - 1], e.points[i]);
    lens.push(total);
  }
  if (lens.length === 0) return 100;
  lens.sort((a, b) => a - b);
  const mid = lens.length >> 1;
  return lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
}

/** Voronoi candidate base nodes for placing `u` when routing edge (u,v):
 *  within `radius` of u and strictly closer to u than to v (guarantees U∩V=∅). */
export function candidateBaseNodes(
  grid: OctiGrid,
  uPos: Pixel,
  vPos: Pixel,
  radius: number,
): OctiBaseNode[] {
  const out: OctiBaseNode[] = [];
  for (const b of grid.baseNodes) {
    const du = dist(b.pos, uPos);
    if (du > radius) continue;
    if (du < dist(b.pos, vPos)) out.push(b);
  }
  return out;
}

function bounds(h: SupportGraph) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of h.nodes.values()) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
```

- [ ] **Step 4: Run helper tests to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/octi.test.ts`
Expected: PASS (2 helper tests).

- [ ] **Step 5: Write failing tests for the full `octi()` loop** (append to `src/render/layout/octi.test.ts`)

```ts
import { octi, DEFAULT_OCTI_OPTIONS } from './octi';

/** True when every consecutive segment of a pixel polyline is octilinear
 *  (horizontal, vertical, or 45°). */
function isOctilinear(path: [number, number][]): boolean {
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i][0] - path[i - 1][0]);
    const dy = Math.abs(path[i][1] - path[i - 1][1]);
    if (dx < 1e-6 && dy < 1e-6) continue;
    if (!(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6)) return false;
  }
  return true;
}

test('octi routes a 2-node axis graph as a straight octilinear run', () => {
  const h = chain([[0, 0], [30, 0]]);
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  assert.equal(img.paths.size, 1);
  const path = [...img.paths.values()][0];
  assert.ok(isOctilinear(path));
});

test('octi routes an off-axis graph octilinearly (L or 45+axis)', () => {
  const h = chain([[0, 0], [30, 10]]); // dx:dy = 3:1
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  const path = [...img.paths.values()][0];
  assert.ok(isOctilinear(path));
});

test('octi places every node within the displacement radius of its input', () => {
  const h = chain([[0, 0], [40, 0], [80, 0], [120, 0]]);
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  const dg = img.cellSize;
  for (const [id, node] of h.nodes) {
    const placed = img.placement.get(id);
    assert.ok(placed, 'node placed: ' + id);
    assert.ok(Math.hypot(placed![0] - node.pos[0], placed![1] - node.pos[1]) <= 1.5 * dg + 1e-6);
  }
});

test('octi every routed path is octilinear', () => {
  const h = chain([[0, 0], [40, 5], [80, -5], [120, 10]]);
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  for (const path of img.paths.values()) assert.ok(isOctilinear(path));
});
```

- [ ] **Step 6: Run to confirm failure**

Run: `pnpm exec tsx --test src/render/layout/octi.test.ts`
Expected: FAIL — `octi` not exported.

- [ ] **Step 7: Implement `octi()`** (append to `src/render/layout/octi.ts`)

```ts
interface Settled {
  /** support node id -> placed base node id. */
  base: Map<string, string>;
  /** support node id -> placed pixel (base centre). */
  pixel: Map<string, Pixel>;
  /** support node id -> { edgeId, dir } recorded exit direction at that node. */
  exitDir: Map<string, Array<{ edgeId: string; dir: number }>>;
}

function importanceSorted(h: SupportGraph): SupportEdge[] {
  return [...h.edges.values()].sort((a, b) => {
    const dl = b.lineIds.size - a.lineIds.size;
    if (dl !== 0) return dl;
    const la = dist(a.points[0], a.points.at(-1)!);
    const lb = dist(b.points[0], b.points.at(-1)!);
    return lb - la;
  });
}

/** Direction index (0..7) of the vector (b - a), snapped to the nearest
 *  octilinear direction. */
function octiDirOf(a: Pixel, b: Pixel): number {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); // +y up handled by caller frame
  const idx = Math.round((ang / (Math.PI / 4)) % 8);
  return ((idx % 8) + 8) % 8;
}

export function octi(h: SupportGraph, opts: OctiOptions): Image {
  let dg = opts.cellSize ?? Math.max(8, medianEdgeLength(h));
  const wm = 0.5 / dg;             // 1-cell displacement costs 0.5
  const dispRadius = () => 1.5 * dg;
  const wGeo = opts.geographicAffinity; // tuned multiplier on squared-distance term
  const largeFinite = () => LARGE_FINITE_K * dg;

  for (let attempt = 0; ; attempt++) {
    const grid = buildOctiGrid(bounds(h), dg);
    const result = tryPlace(h, grid, dg, wm, dispRadius(), wGeo, largeFinite());
    if (result) return result;
    if (attempt >= MAX_STALL_RETRIES) {
      // Fallback: snap each node to its nearest base centre; direct segments.
      const grid2 = buildOctiGrid(bounds(h), dg);
      const placement = new Map<string, Pixel>();
      for (const [id, n] of h.nodes) {
        let best = grid2.baseNodes[0];
        let bestD = Infinity;
        for (const b of grid2.baseNodes) {
          const d = dist(b.pos, n.pos);
          if (d < bestD) { bestD = d; best = b; }
        }
        placement.set(id, best.pos);
      }
      const paths = new Map<string, Pixel[]>();
      for (const e of h.edges.values()) {
        paths.set(e.id, [placement.get(e.from)!, placement.get(e.to)!]);
      }
      return { placement, paths, cellSize: dg };
    }
    dg *= 0.9; // stalling rule: shrink and rebuild
  }
}

function tryPlace(
  h: SupportGraph,
  grid: OctiGrid,
  dg: number,
  wm: number,
  dispRadius: number,
  wGeo: number,
  largeFinite: number,
): Image | null {
  const settled: Settled = { base: new Map(), pixel: new Map(), exitDir: new Map() };
  const usedGridEdges = new Set<string>(); // undirected key on port ids
  const gridKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
  const paths = new Map<string, Pixel[]>();

  const courseOf = (e: SupportEdge) => e.points;
  const distToCourse = (p: Pixel, course: Pixel[]): number => {
    let best = Infinity;
    for (let i = 1; i < course.length; i++) {
      best = Math.min(best, pointToSegment(p, course[i - 1], course[i]));
    }
    return best === Infinity ? 0 : best;
  };

  for (const edge of importanceSorted(h)) {
    const uPos = h.nodes.get(edge.from)!.pos;
    const vPos = h.nodes.get(edge.to)!.pos;

    // Candidate base nodes for each endpoint.
    const uBases = settled.base.has(edge.from)
      ? [grid.baseById.get(settled.base.get(edge.from)!)!]
      : candidateBaseNodes(grid, uPos, vPos, dispRadius);
    const vBases = settled.base.has(edge.to)
      ? [grid.baseById.get(settled.base.get(edge.to)!)!]
      : candidateBaseNodes(grid, vPos, uPos, dispRadius);
    if (uBases.length === 0 || vBases.length === 0) return null;

    // Source/target maps key on the *centre* node; sink cost = displacement
    // (+ adjacent-edge bend handled via per-port costs below — see note).
    const sources = new Map<string, number>();
    for (const b of uBases) sources.set(b.id, dist(b.pos, uPos) * wm);
    const targets = new Map<string, number>();
    for (const b of vBases) targets.set(b.id, dist(b.pos, vPos) * wm);

    // Per-query neighbour function over Γ': read grid weights, add relaxation
    // penalty on used grid edges, and the geographic-affinity term.
    const neighbors = (n: string): OctiEdge[] => {
      const base = grid.adj.get(n) ?? [];
      const out: OctiEdge[] = [];
      for (const e of base) {
        let w = e.w;
        if (e.kind === 'grid') {
          if (usedGridEdges.has(gridKey(e.from, e.to))) w += largeFinite;
          if (wGeo > 0) {
            const a = grid.pos.get(e.from)!;
            const b = grid.pos.get(e.to)!;
            const mid: Pixel = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const d = distToCourse(mid, courseOf(edge));
            w += wGeo * d * d / (dg * dg); // normalise so it scales with grid
          }
        }
        out.push({ ...e, w });
      }
      return out;
    };

    const res = dijkstraMulti(sources, targets, neighbors);
    if (!res) return null;

    // The path is centre→port…port→centre; record placements and used edges.
    const startBase = res.path[0];
    const endBase = res.path[res.path.length - 1];
    settled.base.set(edge.from, startBase);
    settled.base.set(edge.to, endBase);
    settled.pixel.set(edge.from, grid.pos.get(startBase)!);
    settled.pixel.set(edge.to, grid.pos.get(endBase)!);

    const poly: Pixel[] = [];
    for (let i = 0; i < res.path.length; i++) {
      poly.push(grid.pos.get(res.path[i])!);
      if (i > 0) {
        // mark grid edges as used (only the inter-node port links).
        const a = res.path[i - 1];
        const b = res.path[i];
        usedGridEdges.add(gridKey(a, b));
      }
    }
    // Collapse coincident points (centre and its near-port differ only by the
    // tiny PORT_OFFSET) so the rendered polyline reads cleanly.
    paths.set(edge.id, dedupePixels(poly));
  }

  const placement = new Map<string, Pixel>();
  for (const [id, p] of settled.pixel) placement.set(id, p);
  // Any node never touched by an edge (isolated) → nearest base centre.
  for (const [id, n] of h.nodes) {
    if (placement.has(id)) continue;
    let best = grid.baseNodes[0];
    let bestD = Infinity;
    for (const b of grid.baseNodes) {
      const d = dist(b.pos, n.pos);
      if (d < bestD) { bestD = d; best = b; }
    }
    placement.set(id, best.pos);
  }
  return { placement, paths, cellSize: dg };
}

function dedupePixels(pts: Pixel[]): Pixel[] {
  const out: Pixel[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-3) out.push(p);
  }
  return out.length >= 2 ? out : pts.slice(0, 2);
}

function pointToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  const t = c1 / c2;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}
```

> Implementation note for the executing engineer: the **adjacent-edge bend penalty** and **circular-ordering block** (spec §2.2 terms 2 and 3) are layered onto the sink-edge costs at settled endpoints. In this heuristic, when an endpoint is already settled its candidate set collapses to one base node, so the entry must pass through that base's bend edges — which already charge the turn cost via the grid's bend edges. To add the *line-weighted* adjacent penalty `Σ wφ·|L(e)∩L(f)|`, raise the per-query weight of the settled base's bend edges between the incoming port and each previously-used exit port stored in `settled.exitDir`, scaled by shared-line count. Record the exit direction after each edge: `settled.exitDir.get(node).push({ edgeId, dir: octiDirOf(...) })`. The four octi tests above pass without this refinement (single-line chains); add it before the visual checkpoint and confirm the tests still pass. Keep `octiDirOf` and `bendWeight`/`turnSteps` imports for that step.

- [ ] **Step 8: Run the full octi suite to confirm pass**

Run: `pnpm exec tsx --test src/render/layout/octi.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Add the geographic-affinity test** (append to `src/render/layout/octi.test.ts`)

```ts
test('geographicAffinity=1 keeps a curved input near its course', () => {
  const h = chain([[0, 0], [30, 20], [60, 0], [90, 20], [120, 0]]);
  const img = octi(h, { geographicAffinity: 1 });
  const dg = img.cellSize;
  for (const e of h.edges.values()) {
    const path = img.paths.get(e.id)!;
    const mid = path[Math.floor(path.length / 2)];
    // midpoint stays within 2*d_g of the original course midpoint
    const courseMid = e.points[Math.floor(e.points.length / 2)];
    assert.ok(Math.hypot(mid[0] - courseMid[0], mid[1] - courseMid[1]) <= 2 * dg + dg);
  }
});
```

- [ ] **Step 10: Run + commit**

Run: `pnpm exec tsx --test src/render/layout/octi.test.ts`
Expected: PASS. Then:

```bash
pnpm typecheck
git add src/render/layout/octi.ts src/render/layout/octi.test.ts
git commit -m "feat(octi): iterative shortest-path schematicization on Γ'"
```

---

## Task M: Wire octi into smoothed mode + repurpose `showGrid`

**Files:**
- Modify: `src/render/renderGeographic.ts` (`renderSmoothed` becomes topo→octi→ribbons; grid overlay shows `Γ'`)

Replace the body of `renderSmoothed` with the new pipeline. Stations render at their octi grid positions `V(u)`; the `showGrid` toggle overlays the octi base grid.

- [ ] **Step 1: Add imports** to `src/render/renderGeographic.ts`

```ts
import { octi, DEFAULT_OCTI_OPTIONS } from './layout/octi';
import { buildOctiGrid } from './layout/octiGrid';
```

(`topo` and `supportToLayout` are already present from Task I.)

- [ ] **Step 2: Replace `renderSmoothed`'s body**

Replace the entire `renderSmoothed` function with:

```ts
function renderSmoothed(input: GeoInput, opts: SchematicOptions): string {
  const { width, height, padding, dark } = opts;
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const groups = getOrBuildStationGroups(input.stations as never, input.stationGroups);
  const graph = buildTransitGraph(input.stations as never, input.routes, groups);
  if (graph.edges.length === 0) {
    return renderGeographic({ ...input, smooth: false });
  }

  // Project node positions into pixel space (octi works in pixels).
  const bounds = (() => {
    const b = computeBounds([...graph.nodes.values()].map((n) => ({ points: [n.lngLat] })));
    return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
  })();
  const proj = createProjection(bounds, width, height, padding);
  for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

  // topo → octi.
  const support = topo(graph, groups, { lineWidth: theme.lineWidth });
  const image = octi(support, DEFAULT_OCTI_OPTIONS);

  // Build a Layout from the support graph, then override node/edge geometry
  // with octi's placement + routed paths.
  const { layout } = supportToLayout(support);
  const nodePx = new Map<string, Pixel>();
  for (const n of layout.nodes.values()) {
    const placed = image.placement.get(n.id);
    if (placed) {
      n.cell = [placed[0], placed[1]] as Cell;
      nodePx.set(n.id, placed);
    } else {
      nodePx.set(n.id, [n.cell[0], n.cell[1]]);
    }
  }
  for (const e of layout.edges) {
    const routed = image.paths.get(e.id);
    if (routed) e.path = routed.map((p) => [p[0], p[1]] as Cell);
  }
  orderLines(layout);

  const transfers = findTransferPairs(routedGroupsOnly(groups, graph), DEFAULT_TRANSFER_METERS);
  const gridOverlay = opts.showGrid ? buildOctiGridSvg(buildOctiGrid(
    (() => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of nodePx.values()) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      return { minX, minY, maxX, maxY };
    })(),
    image.cellSize,
  ), dark) : '';

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map((c) => [c[0], c[1]]),
    width,
    height,
    dark,
    showLabels: opts.showLabels,
    water: input.water,
    transfers,
    gridOverlay,
  });
}
```

- [ ] **Step 3: Replace `buildGridSvg` with an octi-grid overlay**

Replace the existing `buildGridSvg` function (the Hanan-grid overlay) with:

```ts
/** Diagnostic overlay: the octi base grid as faint axis/diagonal lines plus
 *  base-node dots. Drawn between water and routes. */
function buildOctiGridSvg(grid: import('./layout/octiGrid').OctiGrid, dark: boolean): string {
  const stroke = dark ? '#3a4150' : '#cdd3dc';
  const dotFill = dark ? '#525a6a' : '#a3acbb';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of grid.edges) {
    if (e.kind !== 'grid') continue;
    const a = grid.baseById.get(e.base);
    if (!a) continue;
    const pa = a.pos;
    // grid edges connect ports; draw between the two owning base centres.
    const fromBase = e.from.split(':')[0];
    const toBase = e.to.split(':')[0];
    const key = fromBase < toBase ? fromBase + '|' + toBase : toBase + '|' + fromBase;
    if (seen.has(key)) continue;
    seen.add(key);
    const pb = grid.baseById.get(toBase)?.pos ?? grid.baseById.get(fromBase)?.pos;
    if (!pb) continue;
    lines.push(
      '<line x1="' + pa[0].toFixed(1) + '" y1="' + pa[1].toFixed(1) +
        '" x2="' + pb[0].toFixed(1) + '" y2="' + pb[1].toFixed(1) +
        '" stroke="' + stroke + '" stroke-width="0.4" opacity="0.5"/>',
    );
  }
  const dots: string[] = [];
  for (const b of grid.baseNodes) {
    dots.push('<circle cx="' + b.pos[0].toFixed(1) + '" cy="' + b.pos[1].toFixed(1) + '" r="0.9" fill="' + dotFill + '" opacity="0.8"/>');
  }
  return '<g class="octi-grid">' + lines.join('') + dots.join('') + '</g>';
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (At this point `routeAllEdgesViaHanan` and the `HANAN_SNAP_DIVISOR` const are unused — they're removed in Stage 3. If `tsc` flags the unused import/const as an error under the project's settings, remove the `import { routeAllEdgesViaHanan }` line and the `HANAN_SNAP_DIVISOR` const now; otherwise leave for Stage 3. Check `tsconfig.json` `noUnusedLocals`.)

- [ ] **Step 5: Visual smoke test**

Run: `pnpm render`
Expected: `dev/out-smooth.svg` shows a true octilinear schematic — every segment horizontal/vertical/45°, stations displaced onto grid positions, corridors bundled. Toggle the grid by passing `showGrid: true` in the harness options temporarily to confirm the `Γ'` overlay renders.

- [ ] **Step 6: Commit**

```bash
git add src/render/renderGeographic.ts
git commit -m "feat(smoothed): route through topo+octi; showGrid overlays Γ'"
```

> **VISUAL CHECKPOINT 2.** Run `pnpm render` for NYC and Seattle. Eyeball `dev/out-smooth.svg`: octilinear edges, bounded station displacement, clean bundled corridors. Surface to the user for sign-off before Stage 3.

---

# STAGE 3 — CLEANUP

## Task N: Delete dead code + flip `useTopoMerge` default on

**Files:**
- Delete: `src/render/layout/hananRouter.ts`, `src/render/layout/hananRouter.test.ts`
- Delete: `src/render/layout/ghostNodes.ts`, `src/render/layout/ghostNodes.test.ts`
- Modify: `src/render/renderGeographic.ts` (remove `HANAN_SNAP_DIVISOR`, the `routeAllEdgesViaHanan` import, and the seven cost constants if any remain)
- Modify: `src/render/types.ts` (make topo the default for geographic mode)

- [ ] **Step 1: Confirm nothing else imports the doomed modules**

Run: `pnpm exec rg -n "hananRouter|ghostNodes|splitHighRouteNodes|routeAllEdgesViaHanan|HANAN_SNAP_DIVISOR" src`
Expected: matches only inside `renderGeographic.ts` (already replaced) and the files about to be deleted. If anything else references them, stop and resolve first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/render/layout/hananRouter.ts src/render/layout/hananRouter.test.ts \
       src/render/layout/ghostNodes.ts src/render/layout/ghostNodes.test.ts
```

- [ ] **Step 3: Remove the dead import + constant** in `src/render/renderGeographic.ts`

- Delete the line `import { routeAllEdgesViaHanan } from './layout/hananRouter';`
- Delete the `HANAN_SNAP_DIVISOR` const and its doc comment (the lines defining `const HANAN_SNAP_DIVISOR = 4;`).

> The seven cost-tuning constants (`BEND_TURN_K`, `STATION_ADJACENT_BEND_K`, `BUNDLE_BONUS_K`, `CONFLICT_PENALTY_K`, `DIRECTION_DISAGREEMENT_K`, `EXIT_DIRECTION_K`, `LINE_CONTINUITY_K`) lived inside `hananRouter.ts` and are removed with that file — confirm none were copied into `renderGeographic.ts`.

- [ ] **Step 4: Make topo the default for geographic mode** in `src/render/types.ts`

Change the `useTopoMerge` field default by setting it in `DEFAULT_OPTIONS`:

```ts
export const DEFAULT_OPTIONS: SchematicOptions = {
  width: 800,
  height: 800,
  padding: 0.06,
  showStations: true,
  showLabels: false,
  mode: 'geographic',
  dark: false,
  theme: DEFAULT_THEME,
  useTopoMerge: true,
};
```

Also update the `showGrid` doc comment in `SchematicOptions` to mention the octi grid:

```ts
  /** Diagnostic: overlay the routing grid underneath the routes — the octi
   *  base grid (Γ') in smoothed mode. */
  showGrid?: boolean;
```

- [ ] **Step 5: Update the `showGrid` doc in the option** (already covered in Step 4).

- [ ] **Step 6: Typecheck + full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. No references to deleted modules; all topo/octi/dijkstra/octiGrid tests green; existing schematic/labels/transfers/water tests untouched and green.

- [ ] **Step 7: Final visual confirmation**

Run: `pnpm render`
Expected: `dev/out-geo.svg` (topo bundled corridors, now on by default), `dev/out-smooth.svg` (octi schematic), `dev/out-octi.svg` (schematic mode, unchanged). Eyeball all three.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: delete Hanan router + ghost nodes; default geographic to topo merge"
```

---

## Task O: Merge the branch

- [ ] **Step 1: Confirm clean state**

Run: `git status`
Expected: clean working tree on `feat/loom-pipeline`.

- [ ] **Step 2: Merge to master** (only after both visual checkpoints have user sign-off)

```bash
git checkout master
git merge --no-ff feat/loom-pipeline -m "feat: LOOM-style topo merge + octi schematicization"
```

> Do not push unless the user asks.

---

## Self-Review (run by the plan author before handing off)

**Spec coverage map:**

| Spec section | Task(s) |
|---|---|
| Topo merge round loop, densify, ring buffer, convergence | E |
| `creepBlocked` | B |
| `intersectionSmoothing` | F |
| `insertStations` (multi-candidate fallback) | G |
| Topo parameters (`d̂`, `l`, `α`, ε, maxRounds, radius) | B, G, H |
| Omit line-turn inference (use explicit traversals) | G (traversal reconstruction from `lineTraversals`) |
| Octi grid `Γ'`: ports, sinks, bend edges, inter-node edges | K |
| Bend weights + no-shortcut correction | K |
| Iterative shortest-path placement, candidate/Voronoi, stalling | L |
| Adjacent-edge bend + ordering block | L (Step 7 note — layered onto settled-endpoint bend edges) |
| Constraint relaxation (`LARGE_FINITE`) | L |
| Geography-preserving option (`geographicAffinity`) | L (Steps 7, 9) |
| Octi parameters table | L |
| Line ordering reuse (`orderLines`) | I, M |
| Module layout / deletions | N |
| Geographic integration (bundled ribbons) | I |
| Smoothed integration (octi + `Γ'` overlay) | M |
| Schematic mode untouched | (no task — verified by not modifying `schematic.ts`'s schematic branch) |
| `useTopoMerge` rollout flag | I (add, default off), N (default on) |
| Visual checkpoints | Checkpoint 1 (after I), Checkpoint 2 (after M) |
| Testing (topo/octiGrid/octi unit tests) | B–H, K, L |

**Known follow-ups (out of scope per spec):** ILP optimization, local-search polish (`polishImage` hook), hexagonal/orthoradial grids, Bézier ribbon joins. Not planned here.

**Type-consistency notes:** `SupportGraph`/`SupportEdge`/`Image` defined once in Task A and consumed verbatim by Tasks G, I, L, M. `dijkstraMulti` signature (Task J) matches its octi call site (Task L). `buildOctiGrid(bounds, cellSize)` signature (Task K) matches both octi (Task L) and the smoothed overlay (Task M). `topo(graph, groups, { lineWidth })` (Task H) matches both wiring sites (Tasks I, M). `supportToLayout` (Task I) is reused by Task M.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-loom-topo-octi.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
