# Per-Segment Line Ordering (Crossings Off Stations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each layout edge carry two endpoint line-orders (`orderFrom`, `orderTo`) so line crossings move from stations (nodes) onto open track (edge bends), making junction markers read as clean contiguous families instead of interleaved braids.

**Architecture:** Add `orderFrom`/`orderTo` to `LayoutEdge` (both default to the existing `lineOrder`, so the renderer is byte-identical until the optimizer sets them). A new `laneSwaps` module turns the two endpoint orders into a per-line lane polyline that steps laterally at swap points (preferring edge bend vertices); the existing `renderRibbons` calls it. A node-planarity pass (`nodePlanar`) computes the canonical non-crossing order at each node and an `assignEndpointOrders` pass reconciles those into each edge's two endpoint orders, leaving residual non-planar nodes flagged for the mega box. A new `crossings` metric and `dev/_chk-crossings.ts` gate count node vs edge crossings.

**Tech Stack:** TypeScript (strict), `node:test` via `tsx` (run with `npm test`; NEVER vitest), pnpm. Rendering is pure-function SVG generation exercised through `dev/render-from-dump.ts`. Verification gates are standalone `tsx` scripts under `dev/`.

---

## Background the implementer needs

- **Read first:** `docs/superpowers/specs/2026-06-13-per-segment-line-ordering-design.md` (the design this plan implements) and `docs/superpowers/specs/2026-06-12-rigid-row-markers-design.md` (the marker model, which this plan does NOT change).
- **The data model** (`src/render/layout/types.ts:66`):
  ```typescript
  export interface LayoutEdge {
    id: string;
    from: string;          // node id
    to: string;            // node id
    path: Cell[];          // pixel polyline in smoothed/geo mode (Cell = [number, number]); base centerline for ribbons
    lines: LineRef[];      // LineRef = { id, label, color }
    lineOrder: string[];   // ordered line ids, lateral order along the from→to normal
    stops: Map<string, EdgeStop>;
  }
  ```
- **Who reads `lineOrder` today** (do not break these):
  1. `renderRibbons` (`src/render/renderOctilinear.ts:204`) — the ONLY place that turns an order into drawn lane geometry (`segPath`). This is what we extend.
  2. `computeCanonicalOffsets` (`src/render/layout/offsets.ts:164`) — global per-line offset for the non-smoothed geographic mode. We keep `lineOrder` populated (= `orderFrom`) so this is untouched.
  3. `untangleLineOrder` (`src/render/layout/untangle.ts`) — reads `lineOrder` as its seed (line 542), writes it back (lines 800-813).
- **Who writes `lineOrder` today:** `orderLines` (`src/render/layout/lineOrder.ts`, barycenter seed) then `untangleLineOrder` (the optimizer). Both run in the smoothed pipeline at `src/render/renderGeographic.ts:579` and `:601`.
- **The renderer's `base`:** `renderRibbons` is called with `edgePolyline: (e) => e.path.map((c) => [c[0], c[1]])` (`renderGeographic.ts:616`). In smoothed mode `e.path` was overwritten with the routed octilinear pixel polyline (`renderGeographic.ts:547-550`), so **`base` already carries the corridor's interior bend vertices** — those are the swap-placement candidates.
- **The offset primitive:** `offsetPolyline(points, offset, simplify=false)` (`src/render/layout/offsets.ts:292`) shifts a polyline perpendicular by a constant `offset`, miter-limited. The current renderer calls it once per line per edge with a single constant offset (`src/render/renderOctilinear.ts:294-298`).
- **The overdraw invariant** (`dev/_chk-overdraw.ts`): no two different-colored straight `M`/`L` segments may share identical coordinates. Curves (`Q`/`C`) are exempt. **Swaps must cross at a single point, never co-run on a shared collinear segment.**
- **Run a render:** `npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc` (writes `dev/_dumpnyc.svg`). Seattle: `improvedschematics-input.json`. Dark+labels: prefix `IS_DARK=1 IS_LABELS=1` (PowerShell: `$env:IS_DARK=1; $env:IS_LABELS=1; npx tsx ...`). Use the Bash tool for the inline-env form.
- **Crops:** `npx tsx dev/_crop-nycdark.ts <x> <y> <w> <h> <out.png>` (reads `dev/_dumpnycdark.svg`); generic `npx tsx dev/_crop-any.ts <in.svg> <x> <y> <w> <h> <out.png>`.
- **tsc has PRE-EXISTING errors** in `imageMerge.ts`/`topo.ts`/`renderGeographic.ts`. Do not treat those as regressions; only new errors in files you touch matter. `npm test` is the gate that must stay green.

---

## File Structure

- **Create** `src/render/layout/edgeOrders.ts` — `edgeEndpointOrders(edge)` accessor (the single source of truth for "the two orders of an edge", defaulting to `lineOrder`).
- **Create** `src/render/layout/edgeOrders.test.ts` — accessor tests.
- **Create** `src/render/layout/laneSwaps.ts` — `buildEdgeLanes(...)` (endpoint orders → per-line stepped lane polylines) and `planSwaps(...)` (permutation → placed transpositions).
- **Create** `src/render/layout/laneSwaps.test.ts` — identity-equivalence and single-swap crossing/overdraw tests.
- **Create** `src/render/layout/nodePlanar.ts` — `desiredOrdersAtNode(...)` (node geometry → per-incident-edge canonical order + `planar` flag).
- **Create** `src/render/layout/nodePlanar.test.ts` — synthetic junction tests.
- **Create** `src/render/layout/assignEndpointOrders.ts` — `assignEndpointOrders(layout)` (run after untangle; sets `orderFrom`/`orderTo`/`nonPlanarNodes`).
- **Create** `src/render/layout/assignEndpointOrders.test.ts`.
- **Create** `src/render/layout/crossings.ts` — `countCrossings(layout)` metric.
- **Create** `src/render/layout/crossings.test.ts`.
- **Create** `dev/_chk-crossings.ts` — the new gate.
- **Modify** `src/render/layout/types.ts` — add `orderFrom?`/`orderTo?` to `LayoutEdge`; add `nonPlanarNodes?` to `Layout`.
- **Modify** `src/render/renderOctilinear.ts` — `renderRibbons` calls `buildEdgeLanes`; mega/grouping honors `nonPlanarNodes`.
- **Modify** `src/render/renderGeographic.ts` — call `assignEndpointOrders(layout)` after `untangleLineOrder`.
- **Modify** `src/render/layout/untangle.ts` — emit the `CHK_CROSSINGS` metric.
- **Modify** `manifest.json` + `src/ui/SchematicPanel.tsx` — version bumps at phases 2, 3, 4.

---

# Phase 1 — Plumbing (byte-identical output)

**Outcome:** `LayoutEdge` gains `orderFrom`/`orderTo`; `renderRibbons` produces lanes from the two endpoint orders; the swap-stepping geometry is unit-tested in isolation. Because the optimizer still leaves `orderFrom === orderTo === lineOrder`, real NYC/Seattle renders are **byte-for-byte identical** to v0.2.45. No version bump.

### Task 1: Edge endpoint-order accessor

**Files:**
- Modify: `src/render/layout/types.ts:66-74`
- Create: `src/render/layout/edgeOrders.ts`
- Create: `src/render/layout/edgeOrders.test.ts`

- [ ] **Step 1: Add the optional fields to `LayoutEdge`**

In `src/render/layout/types.ts`, replace the `LayoutEdge` interface (lines 66-74) with:

```typescript
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  path: Cell[]; // octilinear grid path
  lines: LineRef[];
  lineOrder: string[]; // ordered line ids (mutated by orderLines)
  /** Per-segment line ordering (spec 2026-06-13): lateral order at the `from`
   *  endpoint. Undefined means "same as lineOrder" (no internal crossings). */
  orderFrom?: string[];
  /** Lateral order at the `to` endpoint. Undefined means "same as lineOrder". */
  orderTo?: string[];
  stops: Map<string, EdgeStop>;
}
```

Also add `nonPlanarNodes` to `Layout` (lines 76-81) — used in Phase 4 but declared here so the type exists from the start:

```typescript
export interface Layout {
  cellSize: number;
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  lineTraversals: Map<string, TraversalStep[]>;
  /** Nodes the planarity pass could not make crossing-free; rendered as the
   *  mega box (spec 2026-06-13 §5). Populated by assignEndpointOrders. */
  nonPlanarNodes?: Set<string>;
}
```

- [ ] **Step 2: Write the failing accessor test**

Create `src/render/layout/edgeOrders.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeEndpointOrders } from './edgeOrders';
import type { LayoutEdge } from './types';

const E = (over: Partial<LayoutEdge>): LayoutEdge => ({
  id: 'e', from: 'a', to: 'b', path: [[0, 0], [1, 0]],
  lines: [], lineOrder: ['L1', 'L2', 'L3'], stops: new Map(), ...over,
});

test('edgeEndpointOrders: defaults both ends to lineOrder', () => {
  const { from, to } = edgeEndpointOrders(E({}));
  assert.deepEqual(from, ['L1', 'L2', 'L3']);
  assert.deepEqual(to, ['L1', 'L2', 'L3']);
});

test('edgeEndpointOrders: uses orderFrom/orderTo when present', () => {
  const { from, to } = edgeEndpointOrders(E({ orderFrom: ['L2', 'L1', 'L3'], orderTo: ['L1', 'L3', 'L2'] }));
  assert.deepEqual(from, ['L2', 'L1', 'L3']);
  assert.deepEqual(to, ['L1', 'L3', 'L2']);
});

test('edgeEndpointOrders: returns copies (caller cannot mutate the edge)', () => {
  const e = E({});
  const { from } = edgeEndpointOrders(e);
  from.push('X');
  assert.deepEqual(e.lineOrder, ['L1', 'L2', 'L3']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './edgeOrders'`.

- [ ] **Step 4: Implement the accessor**

Create `src/render/layout/edgeOrders.ts`:

```typescript
import type { LayoutEdge } from './types';

/** The lateral line orders at an edge's two endpoints. When orderFrom/orderTo
 *  are unset the edge has no internal crossings and both ends equal lineOrder.
 *  Returns fresh arrays so callers may sort/splice without touching the edge. */
export function edgeEndpointOrders(edge: LayoutEdge): { from: string[]; to: string[] } {
  return {
    from: [...(edge.orderFrom ?? edge.lineOrder)],
    to: [...(edge.orderTo ?? edge.lineOrder)],
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (all three `edgeEndpointOrders` tests; whole suite green).

- [ ] **Step 6: Commit**

```bash
git add src/render/layout/types.ts src/render/layout/edgeOrders.ts src/render/layout/edgeOrders.test.ts
git commit -m "feat(order): add orderFrom/orderTo to LayoutEdge + endpoint accessor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Lane swap geometry (`laneSwaps.ts`)

**Files:**
- Create: `src/render/layout/laneSwaps.ts`
- Create: `src/render/layout/laneSwaps.test.ts`

This is the core new geometry. `buildEdgeLanes` takes the edge's base polyline plus the two endpoint orders (already filtered to drawn lines) and returns, per line id, a lane polyline whose lateral offset starts at the `from`-slot and ends at the `to`-slot, stepping at swap points. When the two orders are equal it MUST reduce to exactly today's constant-offset call so Phase 1 is byte-identical.

- [ ] **Step 1: Write the failing identity-equivalence test**

Create `src/render/layout/laneSwaps.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdgeLanes, planSwaps } from './laneSwaps';
import { offsetPolyline } from './offsets';
import type { Pixel } from './types';

const spacing = 16; // LINE_WIDTH + LINE_GAP at the time of writing

test('buildEdgeLanes: identity order == constant offsetPolyline (byte-identical path)', () => {
  const base: Pixel[] = [[0, 0], [50, 0], [100, 0]];
  const order = ['A', 'B', 'C'];
  const lanes = buildEdgeLanes(base, order, order, spacing, 0);
  const center = (order.length - 1) / 2;
  for (let i = 0; i < order.length; i++) {
    const o = (i - center) * spacing;
    const expected = Math.abs(o) < 1e-9 ? base.map((p) => p.slice()) : offsetPolyline(base, o, false);
    assert.deepEqual(lanes.get(order[i]), expected, `lane ${order[i]} matches constant offset`);
  }
});

test('buildEdgeLanes: identity with bias matches constant (offset+bias)', () => {
  const base: Pixel[] = [[0, 0], [80, 0]];
  const order = ['A', 'B'];
  const bias = 4;
  const lanes = buildEdgeLanes(base, order, order, spacing, bias);
  const center = (order.length - 1) / 2;
  for (let i = 0; i < order.length; i++) {
    const o = (i - center) * spacing + bias;
    assert.deepEqual(lanes.get(order[i]), offsetPolyline(base, o, false));
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './laneSwaps'`.

- [ ] **Step 3: Implement `planSwaps` + `buildEdgeLanes` (identity fast-path first)**

Create `src/render/layout/laneSwaps.ts`:

```typescript
import type { Pixel } from './types';
import { offsetPolyline } from './offsets';

export interface Swap {
  /** Lateral slot index (0-based, low side) of the adjacent pair that swaps. */
  lo: number;
  /** Arc-length position along the base where the crossing occurs. */
  arc: number;
}

/** Cumulative arc length at each base vertex; cum[0] = 0. */
function arcLengths(base: Pixel[]): number[] {
  const cum = [0];
  for (let i = 1; i < base.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]));
  }
  return cum;
}

/** Point + unit normal at an arc position along the base polyline. The normal
 *  is the left-hand perpendicular of the local travel direction (matches the
 *  sign convention of offsetPolyline: positive offset = perp(unit) = [-dy,dx]). */
function sampleBase(base: Pixel[], cum: number[], arc: number): { p: Pixel; n: Pixel } {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(total, arc));
  let seg = 1;
  while (seg < cum.length - 1 && cum[seg] < a) seg++;
  const t = cum[seg] === cum[seg - 1] ? 0 : (a - cum[seg - 1]) / (cum[seg] - cum[seg - 1]);
  const p0 = base[seg - 1];
  const p1 = base[seg];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  return { p: [p0[0] + dx * t, p0[1] + dy * t], n: [-dy / len, dx / len] };
}

/** Decompose the permutation orderFrom -> orderTo into adjacent transpositions
 *  (bubble sort records every swap). Each swap is placed at an arc position
 *  along the base. PHASE 1 placement: evenly spaced in the interior; Phase 3
 *  refines this to prefer bend vertices. Deterministic. */
export function planSwaps(orderFrom: string[], orderTo: string[], base: Pixel[]): Swap[] {
  // Map each line to its target rank under orderTo, expressed in orderFrom space.
  const targetRank = new Map<string, number>();
  orderTo.forEach((l, i) => targetRank.set(l, i));
  const work = orderFrom.map((l) => targetRank.get(l)!); // permutation as rank array
  const swaps: { lo: number }[] = [];
  // Bubble sort: each adjacent inversion fixed is one transposition (one crossing).
  for (let pass = 0; pass < work.length; pass++) {
    let done = true;
    for (let i = 0; i + 1 < work.length; i++) {
      if (work[i] > work[i + 1]) {
        [work[i], work[i + 1]] = [work[i + 1], work[i]];
        swaps.push({ lo: i });
        done = false;
      }
    }
    if (done) break;
  }
  if (swaps.length === 0) return [];
  const total = arcLengths(base)[base.length - 1];
  // Even interior spacing in swap order; the first crossing nearest the from
  // end, the last nearest the to end.
  return swaps.map((s, k) => ({ lo: s.lo, arc: (total * (k + 1)) / (swaps.length + 1) }));
}

/** Build each line's lane polyline for one edge. `orderFrom`/`orderTo` are the
 *  drawn-line orders at the two endpoints (same set, possibly permuted). When
 *  they are equal every lane is a constant lateral offset == today's renderer.
 *  Returns lineId -> Pixel[]. */
export function buildEdgeLanes(
  base: Pixel[],
  orderFrom: string[],
  orderTo: string[],
  spacing: number,
  bias: number,
): Map<string, Pixel[]> {
  const out = new Map<string, Pixel[]>();
  const n = orderFrom.length;
  const center = (n - 1) / 2;

  // Identity fast-path: byte-identical to the legacy constant-offset renderer.
  const identical = n === orderTo.length && orderFrom.every((l, i) => l === orderTo[i]);
  if (identical) {
    for (let i = 0; i < n; i++) {
      const o = (i - center) * spacing + bias;
      out.set(
        orderFrom[i],
        Math.abs(o) < 1e-9 ? base.map((p) => p.slice() as Pixel) : offsetPolyline(base, o, false),
      );
    }
    return out;
  }

  // Stepping path: each line holds a slot, stepping at swaps. Build a per-line
  // slot timeline (slot index as a function of arc), then sample the base at
  // every base vertex AND every swap arc, offsetting by (slot-center)*spacing.
  const cum = arcLengths(base);
  const swaps = planSwaps(orderFrom, orderTo, base);
  // slot[line] starts at its orderFrom index; each swap exchanges two adjacent
  // slot occupants. Record, per line, the sequence of (arc, slotIndex) it holds.
  const slotOfLine = new Map<string, number>();
  orderFrom.forEach((l, i) => slotOfLine.set(l, i));
  const occupant = [...orderFrom]; // occupant[slot] = lineId
  // timeline[line] = array of {arc, slot}; arc=0 is the start slot.
  const timeline = new Map<string, { arc: number; slot: number }[]>();
  for (const l of orderFrom) timeline.set(l, [{ arc: 0, slot: slotOfLine.get(l)! }]);
  for (const s of swaps) {
    const a = occupant[s.lo];
    const b = occupant[s.lo + 1];
    occupant[s.lo] = b;
    occupant[s.lo + 1] = a;
    slotOfLine.set(a, s.lo + 1);
    slotOfLine.set(b, s.lo);
    timeline.get(a)!.push({ arc: s.arc, slot: s.lo + 1 });
    timeline.get(b)!.push({ arc: s.arc, slot: s.lo });
  }

  // Arc positions at which to emit a lane vertex: every base vertex plus a pair
  // of points bracketing each swap (so the crossing is a single X, not a shared
  // collinear run). The bracket half-width is a small fraction of the gap to the
  // neighbouring sample so steps never overlap.
  const W = 6; // px half-window for a swap step
  for (const line of orderFrom) {
    const tl = timeline.get(line)!;
    // slotAt(arc): the slot this line occupies just-before reaching `arc`.
    const slotAt = (arc: number): number => {
      let slot = tl[0].slot;
      for (const ev of tl) if (ev.arc <= arc + 1e-9) slot = ev.slot;
      return slot;
    };
    const stops: number[] = [...cum];
    for (const s of swaps) {
      if (occupantInvolved(s, line, tl)) {
        stops.push(Math.max(0, s.arc - W), s.arc, Math.min(cum[cum.length - 1], s.arc + W));
      }
    }
    stops.sort((x, y) => x - y);
    const dedup: number[] = [];
    for (const a of stops) if (dedup.length === 0 || a - dedup[dedup.length - 1] > 1e-6) dedup.push(a);
    const poly: Pixel[] = dedup.map((arc) => {
      // A swap point uses the post-step slot exactly at arc, the pre-step slot
      // just before; slotAt handles that via the <= comparison.
      const slot = slotAt(arc);
      const o = (slot - center) * spacing + bias;
      const { p, n: nrm } = sampleBase(base, cum, arc);
      return [p[0] + nrm[0] * o, p[1] + nrm[1] * o] as Pixel;
    });
    out.set(line, poly);
  }
  return out;
}

/** Whether `line` is one of the two slots exchanged by swap `s`, given its
 *  timeline (a line is involved iff one of its timeline events has arc===s.arc). */
function occupantInvolved(s: Swap, line: string, tl: { arc: number; slot: number }[]): boolean {
  return tl.some((ev) => Math.abs(ev.arc - s.arc) < 1e-9);
}
```

- [ ] **Step 4: Run the identity tests to verify they pass**

Run: `npm test`
Expected: PASS — both identity tests confirm byte-identical geometry.

- [ ] **Step 5: Write the single-swap crossing + overdraw-safety test**

Append to `src/render/layout/laneSwaps.test.ts`:

```typescript
function segs(poly: Pixel[]): Array<[Pixel, Pixel]> {
  const s: Array<[Pixel, Pixel]> = [];
  for (let i = 1; i < poly.length; i++) s.push([poly[i - 1], poly[i]]);
  return s;
}

function segIntersections(a: Pixel[], b: Pixel[]): number {
  // Count proper crossings between two polylines (segment-segment).
  const cross = (p: Pixel, q: Pixel, r: Pixel, s: Pixel): boolean => {
    const d = (o: Pixel, x: Pixel, y: Pixel) =>
      Math.sign((x[0] - o[0]) * (y[1] - o[1]) - (x[1] - o[1]) * (y[0] - o[0]));
    const d1 = d(p, q, r), d2 = d(p, q, s), d3 = d(r, s, p), d4 = d(r, s, q);
    return d1 !== d2 && d3 !== d4;
  };
  let n = 0;
  for (const [p, q] of segs(a)) for (const [r, s] of segs(b)) if (cross(p, q, r, s)) n++;
  return n;
}

test('buildEdgeLanes: a single adjacent swap makes the two lanes cross exactly once', () => {
  const base: Pixel[] = [[0, 0], [100, 0]];
  const lanes = buildEdgeLanes(base, ['A', 'B'], ['B', 'A'], spacing, 0);
  const A = lanes.get('A')!;
  const B = lanes.get('B')!;
  assert.equal(segIntersections(A, B), 1, 'A and B cross exactly once');
  // Endpoints arrive in canonical order: A starts low (-8), ends high (+8).
  assert.ok(A[0][1] < 0 && A[A.length - 1][1] > 0, 'A steps from low to high');
  assert.ok(B[0][1] > 0 && B[B.length - 1][1] < 0, 'B steps from high to low');
});

test('buildEdgeLanes: swapping lanes never share a collinear segment (overdraw-safe)', () => {
  const base: Pixel[] = [[0, 0], [100, 0]];
  const lanes = buildEdgeLanes(base, ['A', 'B'], ['B', 'A'], spacing, 0);
  const A = segs(lanes.get('A')!);
  const B = segs(lanes.get('B')!);
  for (const [a1, a2] of A) {
    for (const [b1, b2] of B) {
      const collinearSame =
        Math.abs(a1[0] - b1[0]) < 0.01 && Math.abs(a1[1] - b1[1]) < 0.01 &&
        Math.abs(a2[0] - b2[0]) < 0.01 && Math.abs(a2[1] - b2[1]) < 0.01;
      assert.ok(!collinearSame, 'no identical segment shared by both lanes');
    }
  }
});
```

- [ ] **Step 6: Run to verify the swap tests pass**

Run: `npm test`
Expected: PASS. If the single-crossing assertion fails, the bug is in `planSwaps` arc placement or the slot timeline — fix until exactly one crossing and the step direction matches. Do NOT weaken the assertions.

- [ ] **Step 7: Commit**

```bash
git add src/render/layout/laneSwaps.ts src/render/layout/laneSwaps.test.ts
git commit -m "feat(order): laneSwaps — endpoint orders to stepped lane polylines

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire `buildEdgeLanes` into `renderRibbons`

**Files:**
- Modify: `src/render/renderOctilinear.ts:286-300`

- [ ] **Step 1: Import the helpers**

Near the top of `src/render/renderOctilinear.ts` add (with the other `./layout/...` imports):

```typescript
import { buildEdgeLanes } from './layout/laneSwaps';
import { edgeEndpointOrders } from './layout/edgeOrders';
```

- [ ] **Step 2: Replace the segPath construction loop**

Replace the loop at `src/render/renderOctilinear.ts:286-300` (the `for (const edge of layout.edges) { const base = edgePolyline(edge); ... segPath.set(...) }` block) with:

```typescript
  for (const edge of layout.edges) {
    const base = edgePolyline(edge);
    if (base.length < 2) continue;
    const drawn = orderOf.get(edge.id) ?? []; // lineOrder filtered to drawn lines
    if (drawn.length === 0) continue;
    const drawnSet = new Set(drawn);
    // Endpoint orders filtered to the SAME drawn set (a line draws on an edge or
    // not, independent of endpoint), preserving each end's relative order.
    const { from, to } = edgeEndpointOrders(edge);
    const fromDrawn = from.filter((l) => drawnSet.has(l));
    const toDrawn = to.filter((l) => drawnSet.has(l));
    const bias = biasOf.get(edge.id) ?? 0;
    const lanes = buildEdgeLanes(base, fromDrawn, toDrawn, spacing, bias);
    for (const [lineId, poly] of lanes) segPath.set(edge.id + '|' + lineId, poly);
  }
```

Notes for the implementer:
- `orderOf` (built at lines 201-210) already filters `lineOrder` to drawn lines and defines the slot center. We reuse `orderOf` only to get the drawn SET; the per-end order comes from `edgeEndpointOrders`. When `orderFrom`/`orderTo` are unset, `fromDrawn` and `toDrawn` both equal `orderOf.get(edge.id)` exactly, so `buildEdgeLanes` takes the identity fast-path → byte-identical.
- `slotOf` (line 202/209) is now unused by this loop but is still read by the bias solver (lines 237-238). Leave `slotOf` as-is for Phase 1.

- [ ] **Step 3: Render NYC and Seattle and prove byte-identity**

First capture the v0.2.45 baselines from the clean tree (do this BEFORE step 2 if you prefer; otherwise `git stash`, render, `git stash pop`). The reliable method: render on `HEAD~` (pre-Task-3) and on the working tree, diff.

```bash
# Baseline (stash the wiring change, render, restore)
git stash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_base-nyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_base-sea
git stash pop
# New
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_new-nyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_new-sea
```

- [ ] **Step 4: Diff the SVGs — expect empty**

Run (Bash tool):
```bash
diff dev/_base-nyc.svg dev/_new-nyc.svg && echo "NYC IDENTICAL"
diff dev/_base-sea.svg dev/_new-sea.svg && echo "SEA IDENTICAL"
```
Expected: both print `... IDENTICAL` with no diff lines. **If not identical, Phase 1 has a behavior change — stop and fix `buildEdgeLanes`/wiring until identical.** The most likely culprit is the `o ≈ 0 → base.slice()` fast-path or the drawn-set filtering order.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions; the rigid-row, chainPlace, untangle suites stay green).

- [ ] **Step 6: Clean up scratch renders and commit**

```bash
rm -f dev/_base-nyc.svg dev/_base-sea.svg dev/_new-nyc.svg dev/_new-sea.svg
git add src/render/renderOctilinear.ts
git commit -m "feat(order): renderRibbons builds lanes from endpoint orders (no-op)

Output byte-identical to v0.2.45: orderFrom===orderTo===lineOrder everywhere.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Phase 1 checkpoint (review before Phase 2):** the plumbing is in, all renders unchanged, suite green. The swap geometry exists and is unit-tested but is never triggered by real layouts yet.

---

# Phase 2 — Node-planar order

**Outcome:** A pass computes the canonical non-crossing order at every node and writes each edge's `orderFrom`/`orderTo`. Crossings appear on edges (bends); junction markers clean up. First visible change → **bump to v0.2.46**.

### Task 4: Node planarity core (`nodePlanar.ts`)

**Files:**
- Create: `src/render/layout/nodePlanar.ts`
- Create: `src/render/layout/nodePlanar.test.ts`

The function: given a node and its incident edges (with geometry and line sets) plus, per line, which two edges it uses at the node, produce for each incident edge the **desired lateral order of that edge's lines at this node** such that chords don't cross, and a `planar` flag.

**Algorithm (circular matching):**
1. For each incident edge `e`, compute its exit direction at the node = unit vector of the first base segment leaving the node (use the endpoint that equals the node). Angle `θ(e) = atan2(dy, dx)`.
2. For each line `L` on `e`, find its partner edge `B` at this node (the other incident edge `L` uses; or `null` if `L` terminates here). Sort `e`'s lines by the **CCW angular gap** from `θ(e)` to `θ(B)` (terminating lines sort to the far end). Lines sharing a destination `B` form a contiguous block (equal key) — that is node planarity's "keep the bundle together".
3. The sort produces `e`'s order in a CCW-lateral frame anchored at the node. Convert to the edge's `from→to` lateral frame: if `e.from === node` the node-frame order is read at the `from` end (becomes `orderFrom`); if `e.to === node` it's read at the `to` end and the lateral sign is mirrored (becomes `reverse` of the node-frame order). The accompanying tests pin the exact sign.

- [ ] **Step 1: Write the failing Y-split test**

Create `src/render/layout/nodePlanar.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredOrdersAtNode, type IncidentEdge } from './nodePlanar';

// Helpers: an incident edge is described by its id, whether the node is its
// `from` end, the exit direction at the node, and its line ids.
const inc = (id: string, nodeIsFrom: boolean, dir: [number, number], lines: string[]): IncidentEdge => ({
  id, nodeIsFrom, dir, lines,
});

test('nodePlanar: Y split — trunk order matches the branch fan (no crossing)', () => {
  // Trunk t enters from the west (exit dir east-ish reversed): node is t.to,
  // trunk carries A,B. Branch p leaves NE carrying A; branch q leaves SE carrying B.
  // Planar order on the trunk (read west->east, i.e. its from->to) is [A,B]
  // because A's destination (NE) is CCW of B's (SE).
  const edges: IncidentEdge[] = [
    inc('t', false, [-1, 0], ['A', 'B']), // node is t.to; trunk exits west
    inc('p', true, [1, -1], ['A']),        // branch exits NE
    inc('q', true, [1, 1], ['B']),         // branch exits SE
  ];
  const lineEdges = new Map<string, [string, string | null]>([
    ['A', ['t', 'p']],
    ['B', ['t', 'q']],
  ]);
  const res = desiredOrdersAtNode(edges, lineEdges);
  assert.equal(res.planar, true);
  assert.deepEqual(res.orderAtNode.get('t'), ['A', 'B']);
});

test('nodePlanar: 3-arm fan keeps co-traveling lines contiguous', () => {
  // Edge h enters carrying [X, P, Q]; P,Q both continue together on edge g (NE),
  // X branches to edge f (SE). Planar order on h keeps {P,Q} as one block.
  const edges: IncidentEdge[] = [
    inc('h', false, [-1, 0], ['X', 'P', 'Q']),
    inc('g', true, [1, -1], ['P', 'Q']),
    inc('f', true, [1, 1], ['X']),
  ];
  const lineEdges = new Map<string, [string, string | null]>([
    ['X', ['h', 'f']],
    ['P', ['h', 'g']],
    ['Q', ['h', 'g']],
  ]);
  const res = desiredOrdersAtNode(edges, lineEdges);
  assert.equal(res.planar, true);
  const h = res.orderAtNode.get('h')!;
  const pi = h.indexOf('P'), qi = h.indexOf('Q'), xi = h.indexOf('X');
  assert.equal(Math.abs(pi - qi), 1, 'P and Q stay adjacent');
  assert.ok((xi < pi && xi < qi) || (xi > pi && xi > qi), 'X is outside the {P,Q} block');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './nodePlanar'`.

- [ ] **Step 3: Implement `desiredOrdersAtNode`**

Create `src/render/layout/nodePlanar.ts`:

```typescript
export interface IncidentEdge {
  id: string;
  /** True if this node is the edge's `from` endpoint (else it's `to`). */
  nodeIsFrom: boolean;
  /** Unit exit direction of the edge's first segment leaving this node. */
  dir: [number, number];
  /** Line ids carried by this edge. */
  lines: string[];
}

export interface NodePlanResult {
  /** edgeId -> desired order of that edge's lines in its own from->to frame. */
  orderAtNode: Map<string, string[]>;
  /** False when the local matching cannot be made crossing-free. */
  planar: boolean;
}

/** CCW angular gap in [0, 2π) from angle a to angle b. */
function ccwGap(a: number, b: number): number {
  let g = b - a;
  while (g < 0) g += Math.PI * 2;
  while (g >= Math.PI * 2) g -= Math.PI * 2;
  return g;
}

/** Compute each incident edge's planar (non-crossing) line order at one node.
 *  lineEdges maps a line id to the pair of edge ids it uses at this node; the
 *  second is null when the line terminates here. */
export function desiredOrdersAtNode(
  edges: IncidentEdge[],
  lineEdges: Map<string, [string, string | null]>,
): NodePlanResult {
  const angle = new Map<string, number>();
  for (const e of edges) angle.set(e.id, Math.atan2(e.dir[1], e.dir[0]));

  const orderAtNode = new Map<string, string[]>();
  let planar = true;

  for (const e of edges) {
    const base = angle.get(e.id)!;
    const keyed = e.lines.map((l) => {
      const pair = lineEdges.get(l);
      const other = pair ? (pair[0] === e.id ? pair[1] : pair[0]) : null;
      // Terminating lines (other === null) sort to the far CCW end (gap = 2π).
      const gap = other && angle.has(other) ? ccwGap(base, angle.get(other)!) : Math.PI * 2;
      return { l, gap, other };
    });
    // Sort by CCW gap; tie-break by partner edge id then line id for determinism.
    keyed.sort((p, q) => p.gap - q.gap || String(p.other).localeCompare(String(q.other)) || p.l.localeCompare(q.l));
    // node-frame order is CCW. Convert to the edge's from->to lateral frame.
    // Convention (pinned by tests): when the node is the edge's `from` end, the
    // from->to order equals the node-frame order; when the node is the `to` end,
    // it is reversed (the lateral axis flips along the edge).
    const nodeFrame = keyed.map((k) => k.l);
    orderAtNode.set(e.id, e.nodeIsFrom ? nodeFrame : [...nodeFrame].reverse());
  }

  // Planarity check: two lines sharing the same (A,B) transition must occupy a
  // contiguous block on both edges. The angular sort guarantees contiguity by
  // construction for simple junctions; residual non-planarity (a line forced
  // between two members of another transition's block) is detected by verifying
  // that on every edge each destination's lines are contiguous.
  for (const e of edges) {
    const ord = orderAtNode.get(e.id)!;
    const seen = new Set<string>();
    let prevDest: string | null | undefined = undefined;
    const blocks = new Set<string>();
    for (const l of ord) {
      const pair = lineEdges.get(l);
      const dest = pair ? (pair[0] === e.id ? pair[1] : pair[0]) : null;
      const key = String(dest);
      if (key !== String(prevDest)) {
        if (blocks.has(key)) { planar = false; break; }
        blocks.add(key);
      }
      seen.add(l);
      prevDest = dest;
    }
    if (!planar) break;
  }

  return { orderAtNode, planar };
}
```

- [ ] **Step 4: Run to verify the junction tests pass**

Run: `npm test`
Expected: PASS — both junction tests. If a sign assertion fails (e.g. `['A','B']` came out `['B','A']`), flip the `nodeIsFrom ? nodeFrame : reverse` convention and adjust the comment; re-run until green. Keep the convention consistent — Task 5 depends on it.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/nodePlanar.ts src/render/layout/nodePlanar.test.ts
git commit -m "feat(order): node planarity — canonical non-crossing order per node

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Reconcile node orders into edge endpoint orders (`assignEndpointOrders.ts`)

**Files:**
- Create: `src/render/layout/assignEndpointOrders.ts`
- Create: `src/render/layout/assignEndpointOrders.test.ts`

This pass runs on the real `Layout` after `untangleLineOrder`. For each node it builds the `IncidentEdge[]` + `lineEdges` from the layout and calls `desiredOrdersAtNode`. Each edge gets its `from` endpoint order from its `from` node's result and its `to` endpoint order from its `to` node's result. `lineOrder` stays = `orderFrom` so `computeCanonicalOffsets` is unaffected. Non-planar nodes are recorded in `layout.nonPlanarNodes`.

- [ ] **Step 1: Write the failing integration test**

Create `src/render/layout/assignEndpointOrders.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignEndpointOrders } from './assignEndpointOrders';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });

function makeLayout(
  nodes: Array<[string, number, number]>,
  edges: Array<{ id: string; from: string; to: string; lines: string[]; order: string[]; path?: [number, number][] }>,
  traversals: Record<string, TraversalStep[]>,
): Layout {
  const nodeMap = new Map(
    nodes.map(([id, x, y]) => [id, { id, cell: [x, y] as [number, number], label: '', lngLat: [0, 0] as [number, number] }]),
  );
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    id: e.id, from: e.from, to: e.to,
    path: e.path ?? [nodeMap.get(e.from)!.cell, nodeMap.get(e.to)!.cell],
    lines: e.lines.map(L), lineOrder: e.order, stops: new Map(),
  }));
  return { cellSize: 1, nodes: nodeMap, edges: layoutEdges, lineTraversals: new Map(Object.entries(traversals)) };
}

test('assignEndpointOrders: Y junction sets endpoint orders, marks planar', () => {
  // trunk t: r->n {A,B}; p: n->pe {A} (NE); q: n->qe {B} (SE).
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B'], order: ['B', 'A'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'], order: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'], order: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  assignEndpointOrders(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  // The endpoint order at n (t.to) is planar; A,B must be a valid permutation.
  assert.deepEqual([...(t.orderTo ?? [])].sort(), ['A', 'B']);
  assert.ok(!layout.nonPlanarNodes || layout.nonPlanarNodes.size === 0);
  // lineOrder stays equal to orderFrom (offsets.ts authority unchanged).
  assert.deepEqual(t.lineOrder, t.orderFrom ?? t.lineOrder);
});

test('assignEndpointOrders: leaves orderFrom===orderTo on a plain deg-2 pass-through', () => {
  // a->m->b, single line set {A,B}; nothing to reorder, no internal crossings.
  const layout = makeLayout(
    [['a', 0, 0], ['m', 10, 0], ['b', 20, 0]],
    [
      { id: 'e1', from: 'a', to: 'm', lines: ['A', 'B'], order: ['A', 'B'] },
      { id: 'e2', from: 'm', to: 'b', lines: ['A', 'B'], order: ['A', 'B'] },
    ],
    {
      A: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
      B: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
    },
  );
  assignEndpointOrders(layout);
  const e1 = layout.edges.find((e) => e.id === 'e1')!;
  assert.deepEqual(e1.orderFrom, e1.orderTo, 'no internal crossing on a clean pass-through');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './assignEndpointOrders'`.

- [ ] **Step 3: Implement `assignEndpointOrders`**

Create `src/render/layout/assignEndpointOrders.ts`:

```typescript
import type { Layout, LayoutEdge, Pixel } from './types';
import { desiredOrdersAtNode, type IncidentEdge } from './nodePlanar';

/** Exit direction of an edge's first segment leaving `node`, using grid path. */
function exitDir(edge: LayoutEdge, node: string): [number, number] {
  const pts = edge.path;
  if (pts.length < 2) {
    // Degenerate: fall back to straight from->to using nothing — caller filters.
    return [1, 0];
  }
  if (edge.from === node) {
    const dx = pts[1][0] - pts[0][0];
    const dy = pts[1][1] - pts[0][1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }
  const a = pts[pts.length - 1];
  const b = pts[pts.length - 2];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/** For a node, the pair of edges each through-line uses (second = null if it
 *  terminates at the node). Built from edge membership at the node. */
function lineEdgePairs(node: string, incident: LayoutEdge[]): Map<string, [string, string | null]> {
  const byLine = new Map<string, string[]>();
  for (const e of incident) {
    for (const l of e.lines) {
      if (!byLine.has(l)) byLine.set(l, []);
      byLine.get(l)!.push(e.id);
    }
  }
  const out = new Map<string, [string, string | null]>();
  for (const [l, eids] of byLine) {
    out.set(l, [eids[0], eids[1] ?? null]);
  }
  return out;
}

/** Compute planar endpoint orders for every edge. Run AFTER untangleLineOrder.
 *  Sets edge.orderFrom / edge.orderTo; keeps edge.lineOrder === orderFrom so
 *  computeCanonicalOffsets' global offsets are unchanged. Records non-planar
 *  nodes in layout.nonPlanarNodes. */
export function assignEndpointOrders(layout: Layout): void {
  const incidentOf = new Map<string, LayoutEdge[]>();
  for (const e of layout.edges) {
    if (!incidentOf.has(e.from)) incidentOf.set(e.from, []);
    if (!incidentOf.has(e.to)) incidentOf.set(e.to, []);
    incidentOf.get(e.from)!.push(e);
    incidentOf.get(e.to)!.push(e);
  }

  const nonPlanar = new Set<string>();
  // nodeOrders[nodeId] = Map<edgeId, desired order in edge from->to frame>
  const nodeOrders = new Map<string, Map<string, string[]>>();

  for (const [nodeId, incident] of [...incidentOf.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const incEdges: IncidentEdge[] = incident.map((e) => ({
      id: e.id,
      nodeIsFrom: e.from === nodeId,
      dir: exitDir(e, nodeId),
      // Lines drawn here, in the edge's current lineOrder (stable seed).
      lines: e.lineOrder.filter((l) => e.lines.some((x) => x.id === l)),
    }));
    const lineEdges = lineEdgePairs(nodeId, incident);
    const res = desiredOrdersAtNode(incEdges, lineEdges);
    if (!res.planar) nonPlanar.add(nodeId);
    nodeOrders.set(nodeId, res.orderAtNode);
  }

  for (const e of layout.edges) {
    const fromOrd = nodeOrders.get(e.from)?.get(e.id);
    const toOrd = nodeOrders.get(e.to)?.get(e.id);
    e.orderFrom = fromOrd ? [...fromOrd] : [...e.lineOrder];
    e.orderTo = toOrd ? [...toOrd] : [...e.lineOrder];
    // Keep lineOrder authoritative for offsets.ts = the from endpoint order.
    e.lineOrder = [...e.orderFrom];
  }

  layout.nonPlanarNodes = nonPlanar;
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm test`
Expected: PASS — both `assignEndpointOrders` tests, whole suite green. If the deg-2 pass-through test fails with `orderFrom !== orderTo`, the node-frame sign convention disagrees between the two ends — reconcile with the `nodePlanar` convention until a clean pass-through stays identity.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/assignEndpointOrders.ts src/render/layout/assignEndpointOrders.test.ts
git commit -m "feat(order): assignEndpointOrders reconciles node orders into edges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the pass into the smoothed pipeline + render

**Files:**
- Modify: `src/render/renderGeographic.ts:601`
- Modify: `manifest.json`
- Modify: `src/ui/SchematicPanel.tsx`

- [ ] **Step 1: Call `assignEndpointOrders` after untangle**

In `src/render/renderGeographic.ts`, add the import (with the other `./layout/...` imports near line 28):

```typescript
import { assignEndpointOrders } from './layout/assignEndpointOrders';
```

Then immediately after the `untangleLineOrder(layout);` call (the `if (...) { untangleLineOrder(layout); }` block ending at line 602), add:

```typescript
  // Per-segment line ordering (spec 2026-06-13): turn the single per-edge order
  // into planar endpoint orders so crossings move from stations onto bends.
  if (
    !(
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_NO_ENDPOINTS === '1'
    )
  ) {
    assignEndpointOrders(layout);
  }
```

(The `OCTI_NO_ENDPOINTS` A/B switch mirrors the existing `OCTI_NO_UNTANGLE` escape hatch for diagnosis.)

- [ ] **Step 2: Render NYC + Seattle (dark+labels) and the gate inputs**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump
IS_DARK=1 IS_LABELS=1 npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnycdark
```

- [ ] **Step 3: Run the existing gates**

Run:
```bash
npx tsx dev/_chk-octi.ts dev/_dumpnyc.svg
npx tsx dev/_chk-seating.ts dev/_dumpnyc.svg
npx tsx dev/_chk-markerfit.ts dev/_dumpnyc.svg
npx tsx dev/_chk-overdraw.ts dev/_dumpnyc.svg
```
Expected: each prints `OK` (no `FAIL`). **Overdraw is the critical one** — if it fails, a swap is co-running on a shared segment; fix `buildEdgeLanes` bracketing. Repeat the four gates on `dev/_dump.svg` (Seattle).

- [ ] **Step 4: Crop the target junctions and inspect**

The summary's named coordinates (dark map) — crop and view each:
```bash
npx tsx dev/_crop-nycdark.ts 890 1440 200 180 dev/_3st.png
```
Then visually confirm (Read the PNG): 3 St, Flatbush Av, Wythe Av, Park Av — service families now read as contiguous bands; crossings sit on the open track between stations, not under the marker. Also crop 22 St, St Lukes, Central Park to confirm NO regression (find their coordinates by searching the SVG for the station label text, or reuse coordinates from the session's prior crops).

Note: you will need the actual viewBox coordinates for each station. To find one: `grep -n "3 St" dev/_dumpnycdark.svg` shows the label `<text>` with `x`/`y`; crop a ~200×180 box around it.

- [ ] **Step 5: Bump version to 0.2.46**

In `manifest.json` change `"version": "0.2.45"` to `"version": "0.2.46"`. In `src/ui/SchematicPanel.tsx` change the toolbar string `v0.2.45` to `v0.2.46`.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` → PASS.
```bash
git add src/render/renderGeographic.ts manifest.json src/ui/SchematicPanel.tsx
git commit -m "feat(order): node-planar endpoint orders in smoothed pipeline (v0.2.46)

Crossings move to bends; junction families read contiguous. OCTI_NO_ENDPOINTS=1 reverts.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Phase 2 checkpoint (review before Phase 3):** markers at junctions should be visibly cleaner. Some crossings may land in awkward spots (mid-straight, or multiple at one bend) — that's Phase 3's job. Confirm gates pass and capture before/after crops for the review.

---

# Phase 3 — Crossing minimization & swap placement

**Outcome:** Swaps prefer bend vertices; total edge crossings are minimized by a hill-climb over node orders (coupled through shared edges) with a color-family tiebreak. Visible refinement → **bump to v0.2.47**.

### Task 7: Place swaps at bend vertices

**Files:**
- Modify: `src/render/layout/laneSwaps.ts` (`planSwaps`)
- Modify: `src/render/layout/laneSwaps.test.ts`

- [ ] **Step 1: Write the failing bend-placement test**

Append to `src/render/layout/laneSwaps.test.ts`:

```typescript
test('planSwaps: a single swap on a bent edge lands at the interior bend vertex', () => {
  // Base bends at (50,0): one swap should sit at arc=50 (the bend), not mid-leg.
  const base: Pixel[] = [[0, 0], [50, 0], [50, 50]];
  const swaps = planSwaps(['A', 'B'], ['B', 'A'], base);
  assert.equal(swaps.length, 1);
  assert.ok(Math.abs(swaps[0].arc - 50) < 1e-6, `swap at the bend (arc 50), got ${swaps[0].arc}`);
});

test('planSwaps: straight edge with no bend spaces swaps evenly', () => {
  const base: Pixel[] = [[0, 0], [120, 0]];
  const swaps = planSwaps(['A', 'B', 'C'], ['C', 'B', 'A'], base); // 3 inversions
  assert.equal(swaps.length, 3);
  const arcs = swaps.map((s) => s.arc).sort((a, b) => a - b);
  for (const a of arcs) assert.ok(a > 0 && a < 120, 'interior');
});
```

- [ ] **Step 2: Run to verify the bend test fails**

Run: `npm test`
Expected: FAIL — the even-spacing `planSwaps` puts the single swap at arc 50 only by luck on this base; verify it actually fails (the bend is at arc 50, even spacing for 1 swap on a length-100 base is also 50 — choose a base where they differ). Adjust the test base to `[[0,0],[30,0],[30,50]]` (bend at arc 30, even-spacing midpoint 40) so the assertion `arc≈30` genuinely fails first. Re-run to confirm FAIL.

- [ ] **Step 3: Implement bend-preferring placement**

Replace the `planSwaps` return (the `swaps.map(...)` even-spacing block at the end of `planSwaps`) with bend-aware assignment:

```typescript
  if (swaps.length === 0) return [];
  const cum = arcLengths(base);
  const total = cum[cum.length - 1];
  // Interior bend vertices are the strongest swap anchors (the turn absorbs the
  // crossing). Rank candidate arc positions: interior vertices first (by turn
  // sharpness), then evenly spaced fallbacks. Assign swaps to candidates in
  // swap order, nearest-first, each candidate used once.
  const bends: { arc: number; sharp: number }[] = [];
  for (let i = 1; i < base.length - 1; i++) {
    const a = base[i - 1], v = base[i], b = base[i + 1];
    const u1 = [v[0] - a[0], v[1] - a[1]];
    const u2 = [b[0] - v[0], b[1] - v[1]];
    const l1 = Math.hypot(u1[0], u1[1]) || 1;
    const l2 = Math.hypot(u2[0], u2[1]) || 1;
    const dot = (u1[0] * u2[0] + u1[1] * u2[1]) / (l1 * l2);
    bends.push({ arc: cum[i], sharp: 1 - dot }); // sharp in [0,2]
  }
  bends.sort((p, q) => q.sharp - p.sharp || p.arc - q.arc);
  const candidates: number[] = bends.map((b) => b.arc);
  // Even-spaced fallbacks fill remaining swaps when there aren't enough bends.
  for (let k = 1; k <= swaps.length; k++) candidates.push((total * k) / (swaps.length + 1));
  // Assign in swap order; keep crossings monotone along the edge (first swap
  // nearest the from end) by sorting the chosen arcs and pairing in order.
  const chosen = candidates.slice(0, swaps.length).sort((a, b) => a - b);
  return swaps.map((s, k) => ({ lo: s.lo, arc: chosen[k] }));
```

Add `arcLengths` is already defined above; ensure `planSwaps` references it (it does).

- [ ] **Step 4: Run to verify bend + straight tests pass**

Run: `npm test`
Expected: PASS — swap lands at the bend; straight edge stays interior. The Phase-1 single-crossing/overdraw tests must STILL pass (bend placement does not change the crossing count).

- [ ] **Step 5: Re-render and re-gate**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/_chk-overdraw.ts dev/_dumpnyc.svg
npx tsx dev/_chk-octi.ts dev/_dumpnyc.svg
```
Expected: OK. Crossings should now visibly sit at corners.

- [ ] **Step 6: Commit**

```bash
git add src/render/layout/laneSwaps.ts src/render/layout/laneSwaps.test.ts
git commit -m "feat(order): place swaps at bend vertices (turn absorbs the crossing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Minimize total edge crossings (hill-climb over node orders)

**Files:**
- Modify: `src/render/layout/assignEndpointOrders.ts`
- Modify: `src/render/layout/assignEndpointOrders.test.ts`

Node orders are coupled: edge `E`'s two endpoint orders come from two different nodes, and `E`'s crossings = inversions between them. Greedy per-node planarity can leave more edge crossings than necessary. Add a bounded hill-climb: after the initial planar assignment, repeatedly try reversing/rotating a node's free transition-blocks (moves that keep that node planar) and keep changes that reduce total `Σ inversions(orderFrom→orderTo)` over all edges, with color-fragmentation as a tiebreak.

- [ ] **Step 1: Write the failing minimization test**

Append to `src/render/layout/assignEndpointOrders.test.ts`:

```typescript
import { totalEdgeCrossings } from './assignEndpointOrders';

test('assignEndpointOrders: reduces total edge crossings vs the naive seed', () => {
  // Two coupled Y-junctions sharing trunk edge t. A naive per-node assignment
  // can force inversions on t that a coordinated choice avoids.
  const layout = makeLayout(
    [['l1', 0, -10], ['l2', 0, 10], ['m', 20, 0], ['n', 40, 0], ['r1', 60, -10], ['r2', 60, 10]],
    [
      { id: 'a', from: 'l1', to: 'm', lines: ['A'], order: ['A'] },
      { id: 'b', from: 'l2', to: 'm', lines: ['B'], order: ['B'] },
      { id: 't', from: 'm', to: 'n', lines: ['A', 'B'], order: ['A', 'B'] },
      { id: 'c', from: 'n', to: 'r1', lines: ['A'], order: ['A'] },
      { id: 'd', from: 'n', to: 'r2', lines: ['B'], order: ['B'] },
    ],
    {
      A: [{ edgeId: 'a', reversed: false }, { edgeId: 't', reversed: false }, { edgeId: 'c', reversed: false }],
      B: [{ edgeId: 'b', reversed: false }, { edgeId: 't', reversed: false }, { edgeId: 'd', reversed: false }],
    },
  );
  assignEndpointOrders(layout);
  // With A entering top-left and exiting top-right (B mirrored), the trunk needs
  // NO internal crossing: a coordinated assignment yields 0 crossings on t.
  const t = layout.edges.find((e) => e.id === 't')!;
  assert.deepEqual(t.orderFrom, t.orderTo, 'trunk has no forced internal crossing');
  assert.equal(totalEdgeCrossings(layout), 0);
});
```

- [ ] **Step 2: Run to verify it fails (or passes by luck — then strengthen)**

Run: `npm test`
Expected: FAIL — the naive seed leaves an inversion on `t`. If it passes already, add a third coupled junction so the seed is provably suboptimal before proceeding.

- [ ] **Step 3: Add the crossing counter + hill-climb**

In `src/render/layout/assignEndpointOrders.ts` add, above `assignEndpointOrders`:

```typescript
/** Inversions between two equal-set permutations (number of adjacent swaps). */
function inversions(from: string[], to: string[]): number {
  const rank = new Map<string, number>();
  to.forEach((l, i) => rank.set(l, i));
  const a = from.map((l) => rank.get(l)!);
  let inv = 0;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) inv++;
  return inv;
}

/** Total edge-internal crossings across the layout (Σ endpoint-order inversions). */
export function totalEdgeCrossings(layout: Layout): number {
  let n = 0;
  for (const e of layout.edges) {
    const from = e.orderFrom ?? e.lineOrder;
    const to = e.orderTo ?? e.lineOrder;
    n += inversions(from, to);
  }
  return n;
}
```

Then, at the END of `assignEndpointOrders` (after the `for (const e of layout.edges)` write-back loop, before `layout.nonPlanarNodes = nonPlanar;`), add a bounded coordinated pass that, for each node, tries the reverse of its computed order on every incident edge endpoint (a planarity-preserving reflection) and keeps it if total crossings drop:

```typescript
  // Coordinated reduction: a whole-node reflection keeps the node planar but may
  // flip the inversions on its incident edges. Hill-climb over node reflections.
  const nodeIds = [...nodeOrders.keys()].sort();
  const reflectNode = (nodeId: string) => {
    for (const e of layout.edges) {
      if (e.from === nodeId) e.orderFrom = [...(e.orderFrom ?? e.lineOrder)].reverse();
      if (e.to === nodeId) e.orderTo = [...(e.orderTo ?? e.lineOrder)].reverse();
    }
  };
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (const nodeId of nodeIds) {
      const before = totalEdgeCrossings(layout);
      reflectNode(nodeId);
      const after = totalEdgeCrossings(layout);
      if (after < before) {
        improved = true;
      } else {
        reflectNode(nodeId); // revert
      }
    }
    if (!improved) break;
  }
  // Re-sync lineOrder to orderFrom after reflections (offsets.ts authority).
  for (const e of layout.edges) if (e.orderFrom) e.lineOrder = [...e.orderFrom];
```

Note: a node reflection must reverse BOTH the endpoint order on every incident edge AND the relationship stays planar (a reflection of a non-crossing circular matching is still non-crossing). This is the cheapest planarity-preserving move and resolves the coupled-trunk case. Determinism holds (fixed node order, no randomness).

- [ ] **Step 4: Run to verify the minimization test passes**

Run: `npm test`
Expected: PASS — `totalEdgeCrossings === 0` on the coupled-Y, trunk has no internal crossing. All earlier tests stay green.

- [ ] **Step 5: Re-render + gates + crops**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump
npx tsx dev/_chk-overdraw.ts dev/_dumpnyc.svg
npx tsx dev/_chk-octi.ts dev/_dumpnyc.svg
npx tsx dev/_chk-seating.ts dev/_dumpnyc.svg
npx tsx dev/_chk-markerfit.ts dev/_dumpnyc.svg
```
Expected: all OK. Re-crop 3 St / Flatbush / Wythe / Park Av — crossings minimized and on bends.

- [ ] **Step 6: Bump to v0.2.47, run suite, commit**

`manifest.json` → `0.2.47`; `SchematicPanel.tsx` → `v0.2.47`. `npm test` → PASS.
```bash
git add src/render/layout/assignEndpointOrders.ts src/render/layout/assignEndpointOrders.test.ts manifest.json src/ui/SchematicPanel.tsx
git commit -m "feat(order): minimize total edge crossings via node reflections (v0.2.47)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Phase 3 checkpoint (review before Phase 4):** crossings are minimal and at bends; families contiguous. Capture the four target crops + 3 no-regression crops for review.

---

# Phase 4 — Residual box, crossings gate, ship

**Outcome:** Non-planar nodes render as the mega box (honest, rare); a `countCrossings` metric + `dev/_chk-crossings.ts` gate report node vs edge crossings; full sweep; ship v0.2.48.

### Task 9: Crossings metric (`crossings.ts`)

**Files:**
- Create: `src/render/layout/crossings.ts`
- Create: `src/render/layout/crossings.test.ts`

- [ ] **Step 1: Write the failing metric test**

Create `src/render/layout/crossings.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCrossings } from './crossings';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });
function mk(edges: Array<Partial<LayoutEdge> & { id: string; from: string; to: string; lines: string[] }>, nonPlanar: string[] = []): Layout {
  const layoutEdges = edges.map((e) => ({
    id: e.id, from: e.from, to: e.to, path: [[0, 0], [1, 0]] as [number, number][],
    lines: e.lines.map(L), lineOrder: e.orderFrom ?? e.lines, orderFrom: e.orderFrom, orderTo: e.orderTo, stops: new Map(),
  })) as LayoutEdge[];
  return {
    cellSize: 1, nodes: new Map(), edges: layoutEdges,
    lineTraversals: new Map<string, TraversalStep[]>(), nonPlanarNodes: new Set(nonPlanar),
  };
}

test('countCrossings: on-edge crossings = endpoint-order inversions', () => {
  const layout = mk([{ id: 'e', from: 'a', to: 'b', lines: ['A', 'B'], orderFrom: ['A', 'B'], orderTo: ['B', 'A'] }]);
  const r = countCrossings(layout);
  assert.equal(r.onEdges, 1);
  assert.equal(r.atNodes, 0);
});

test('countCrossings: residual non-planar nodes counted at nodes', () => {
  const layout = mk([{ id: 'e', from: 'a', to: 'b', lines: ['A'], orderFrom: ['A'], orderTo: ['A'] }], ['a']);
  const r = countCrossings(layout);
  assert.equal(r.atNodes, 1);
  assert.equal(r.nonPlanar, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './crossings'`.

- [ ] **Step 3: Implement `countCrossings`**

Create `src/render/layout/crossings.ts`:

```typescript
import type { Layout } from './types';

export interface CrossingReport {
  /** Crossings on open track (Σ endpoint-order inversions over edges). */
  onEdges: number;
  /** Residual crossings forced at nodes (one per non-planar node, lower bound). */
  atNodes: number;
  /** Number of non-planar nodes. */
  nonPlanar: number;
}

function inversions(from: string[], to: string[]): number {
  const rank = new Map<string, number>();
  to.forEach((l, i) => rank.set(l, i));
  const a = from.filter((l) => rank.has(l)).map((l) => rank.get(l)!);
  let inv = 0;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) inv++;
  return inv;
}

/** Count line crossings by location: on edges (bends) vs forced at nodes. */
export function countCrossings(layout: Layout): CrossingReport {
  let onEdges = 0;
  for (const e of layout.edges) {
    onEdges += inversions(e.orderFrom ?? e.lineOrder, e.orderTo ?? e.lineOrder);
  }
  const nonPlanar = layout.nonPlanarNodes?.size ?? 0;
  return { onEdges, atNodes: nonPlanar, nonPlanar };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/crossings.ts src/render/layout/crossings.test.ts
git commit -m "feat(order): countCrossings metric (node vs edge crossings)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Render non-planar nodes as the mega box

**Files:**
- Modify: `src/render/renderOctilinear.ts` (the grouping/mega logic that sets `mk.mega`)

The renderer already has a mega-box path that fires when a station's marks can't form a clean spine (the rigid-row fallback). Non-planar nodes from `assignEndpointOrders` should force that same fallback so the residual crossing is honestly boxed.

- [ ] **Step 1: Locate the marker grouping / mega decision**

Read `src/render/renderOctilinear.ts` around the station-marker assembly (search for `mega` and the grouping union-find; per the session notes this is where `slideBoxed`/`megaFallbacks` are set and `mk.mega = true` is assigned). Identify where a node id is available alongside its `StopMark[]`.

- [ ] **Step 2: Force mega for non-planar nodes**

At the point where a node's marks are finalized (before the spine-vs-mega branch), add:

```typescript
    if (layout.nonPlanarNodes?.has(nodeId)) {
      for (const mk of marks) mk.mega = true;
    }
```

(Use the actual local variable names for the node id and the marks array found in Step 1; `nodeId` and `marks` are placeholders for whatever they are called there.)

- [ ] **Step 3: Re-render and confirm boxes are rare + meaningful**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump
```
Count `<rect` mega markers in each SVG (`grep -c 'class="imp-mega"' dev/_dumpnyc.svg` — use the actual mega class/marker found in the renderer). Expected: a small number, each at a genuinely non-planar junction. Compare to the v0.2.45 box count (NYC 1 / SEA 2 per session notes) — boxes should stay rare; new boxes only at truly non-planar nodes.

- [ ] **Step 4: Run the suite + gates**

Run: `npm test` → PASS. Re-run all four gates on both SVGs → OK.

- [ ] **Step 5: Commit**

```bash
git add src/render/renderOctilinear.ts
git commit -m "feat(order): non-planar nodes render as the mega box (honest residual)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: The `_chk-crossings.ts` gate

**Files:**
- Modify: `src/render/layout/untangle.ts` (emit metric under env flag)
- Create: `dev/_chk-crossings.ts`

The gate counts node vs edge crossings on the actual rendered layout. Since the layout isn't recoverable from the SVG, instrument the pipeline: under `CHK_CROSSINGS=1`, emit the metric to stderr during render (mirrors the existing `OCTI_DEBUG`/`[untangle]` precedent). The gate runs a render with the flag and parses it.

- [ ] **Step 1: Emit the metric after endpoint assignment**

Per the renderGeographic wiring (Task 6), the metric must be computed AFTER `assignEndpointOrders`. Add the emission in `src/render/renderGeographic.ts` right after the `assignEndpointOrders(layout)` block:

```typescript
  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.CHK_CROSSINGS === '1'
  ) {
    const r = countCrossings(layout);
    console.error(`[crossings] onEdges=${r.onEdges} atNodes=${r.atNodes} nonPlanar=${r.nonPlanar}`);
  }
```

Add the import at the top of `renderGeographic.ts`:
```typescript
import { countCrossings } from './layout/crossings';
```

- [ ] **Step 2: Write the gate**

Create `dev/_chk-crossings.ts`:

```typescript
// Crossings gate: renders a save with CHK_CROSSINGS=1 and checks that crossings
// live on edges (bends), not at nodes. FAIL if atNodes exceeds the tolerance.
// Usage: npx tsx dev/_chk-crossings.ts [input.json] [maxAtNodes]
import { execSync } from 'node:child_process';

const input = process.argv[2] ?? 'improvedschematics-input-nyc.json';
const maxAtNodes = Number(process.argv[3] ?? '4'); // residual non-planar tolerance

let stderr = '';
try {
  execSync(`npx tsx dev/render-from-dump.ts ${input} dev/_chk-crossings-out`, {
    env: { ...process.env, CHK_CROSSINGS: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (e) {
  // render-from-dump writes the SVG and exits 0 normally; capture stderr either way
  stderr = String((e as { stderr?: Buffer }).stderr ?? '');
}
// execSync returns stdout; stderr was piped — re-run capturing if needed.
if (!stderr) {
  stderr = execSync(`npx tsx dev/render-from-dump.ts ${input} dev/_chk-crossings-out 2>&1 1>NUL`, {
    env: { ...process.env, CHK_CROSSINGS: '1' }, shell: 'powershell.exe',
  }).toString();
}

const m = stderr.match(/\[crossings\] onEdges=(\d+) atNodes=(\d+) nonPlanar=(\d+)/);
if (!m) {
  console.log('FAIL: no [crossings] metric emitted (is CHK_CROSSINGS wired?)');
  process.exit(0);
}
const onEdges = Number(m[1]);
const atNodes = Number(m[2]);
const nonPlanar = Number(m[3]);
console.log(`crossings: onEdges=${onEdges} atNodes=${atNodes} nonPlanar=${nonPlanar}`);
if (atNodes > maxAtNodes) console.log(`FAIL: ${atNodes} crossings at nodes exceeds tolerance ${maxAtNodes}`);
else console.log('OK');
```

Note for the implementer: stderr capture across shells is fiddly. The robust approach is to have `render-from-dump.ts` always print the `[crossings]` line to stderr when `CHK_CROSSINGS=1`, then run `execSync` with `stdio:['ignore','ignore','pipe']` and read the thrown/returned stderr. If `execSync`'s stderr piping proves unreliable on this Windows/PowerShell setup, fall back to writing the metric to a sidecar file `dev/_crossings.json` from within `renderGeographic` (under the flag) and have the gate read that file with `readFileSync` — simpler and deterministic. Pick whichever runs cleanly; the gate's CONTRACT is: print `OK` or `FAIL: ...`.

- [ ] **Step 3: Run the gate**

```bash
npx tsx dev/_chk-crossings.ts improvedschematics-input-nyc.json
npx tsx dev/_chk-crossings.ts improvedschematics-input.json
```
Expected: prints the metric and `OK` (atNodes within tolerance). If `FAIL`, either the tolerance is too tight or there are more non-planar nodes than expected — investigate which nodes (log their ids) before relaxing the tolerance.

- [ ] **Step 4: Commit**

```bash
git add src/render/renderGeographic.ts dev/_chk-crossings.ts
git commit -m "feat(order): crossings gate (CHK_CROSSINGS metric + _chk-crossings.ts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification sweep + ship v0.2.48

**Files:**
- Modify: `manifest.json`, `src/ui/SchematicPanel.tsx`
- Update: `C:\Users\darkd\.claude\projects\C--Users-darkd-Downloads-Improved-Schematics\memory\loom-octi-pipeline.md`

- [ ] **Step 1: Render all gate inputs (light + dark + Seattle)**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump
IS_DARK=1 IS_LABELS=1 npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnycdark
```

- [ ] **Step 2: Run every gate on both maps**

```bash
npx tsx dev/_chk-octi.ts dev/_dumpnyc.svg
npx tsx dev/_chk-seating.ts dev/_dumpnyc.svg
npx tsx dev/_chk-markerfit.ts dev/_dumpnyc.svg
npx tsx dev/_chk-overdraw.ts dev/_dumpnyc.svg
npx tsx dev/_chk-crossings.ts improvedschematics-input-nyc.json
npx tsx dev/_chk-octi.ts dev/_dump.svg
npx tsx dev/_chk-seating.ts dev/_dump.svg
npx tsx dev/_chk-markerfit.ts dev/_dump.svg
npx tsx dev/_chk-overdraw.ts dev/_dump.svg
npx tsx dev/_chk-crossings.ts improvedschematics-input.json
```
Expected: every line prints `OK` (no `FAIL`). Fix any failure before shipping.

- [ ] **Step 3: Named-station crops (dark+labels)**

Crop and Read each PNG; confirm against the goals and no-regression set:
- Targets (should be visibly cleaner): 3 St, Flatbush Av, Wythe Av, Park Av.
- No regression: 22 St, St Lukes, Central Park, plus one J/D-style junction and one terminus.

Find each station's coordinates by `grep`-ing its label in `dev/_dumpnycdark.svg`, then `npx tsx dev/_crop-nycdark.ts <x-90> <y-90> 200 180 dev/_<name>.png`.

- [ ] **Step 4: Full-map overview diff vs v0.2.45**

Render the v0.2.45 baseline (checkout the tag/commit in a scratch worktree, or `git stash` the changes is not possible across commits — use `git show v0.2.45:...` is not practical for a render; instead render from the commit before Phase 2: `git worktree add ../is-base 6485db2`, render there). Generate full-map PNGs of both and eyeball: line re-flow is EXPECTED and broad; confirm (a) crossings moved to bends, (b) families read contiguous at stations, (c) no lines vanished or doubled. This is a judgment check, not a pixel diff.

- [ ] **Step 5: Run the full test suite one final time**

Run: `npm test`
Expected: PASS — every suite green (laneSwaps, nodePlanar, assignEndpointOrders, crossings, edgeOrders, plus the pre-existing rigid-row/chainPlace/untangle suites).

- [ ] **Step 6: Bump to v0.2.48**

`manifest.json` → `"version": "0.2.48"`; `src/ui/SchematicPanel.tsx` toolbar `v0.2.48`.

- [ ] **Step 7: Update project memory**

Append to `C:\Users\darkd\.claude\projects\C--Users-darkd-Downloads-Improved-Schematics\memory\loom-octi-pipeline.md` a short entry under the per-segment-ordering note: "SHIPPED v0.2.48 — per-segment line ordering. orderFrom/orderTo per edge (edgeOrders.ts); laneSwaps.ts steps lanes at bends; nodePlanar.ts + assignEndpointOrders.ts compute planar endpoint orders after untangle (renderGeographic.ts); non-planar nodes box; crossings.ts + dev/_chk-crossings.ts gate (CHK_CROSSINGS). OCTI_NO_ENDPOINTS=1 reverts. Knobs: swap window W in laneSwaps, reflection hill-climb passes in assignEndpointOrders."

- [ ] **Step 8: Final commit**

```bash
git add manifest.json src/ui/SchematicPanel.tsx "C:/Users/darkd/.claude/projects/C--Users-darkd-Downloads-Improved-Schematics/memory/loom-octi-pipeline.md"
git commit -m "feat(order): ship per-segment line ordering (v0.2.48)

Crossings live on bends, not stations; junction families read contiguous;
residual non-planar nodes box. Gates: octi/seating/markerfit/overdraw/crossings green.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Clean up scratch artifacts**

```bash
git worktree remove ../is-base 2>NUL
rm -f dev/_chk-crossings-out.svg dev/_3st.png dev/_*.png
```
(Leave the committed `dev/_chk-*.ts` scripts and the standard `dev/_dump*.svg` renders.)

---

## Self-Review (run after writing the plan; fixes applied inline)

**Spec coverage:**
- §2 (orderFrom/orderTo per edge) → Task 1. ✔
- §2.1 node planarity → Task 4 (`nodePlanar`). ✔
- §2.2 objective / minimize edge crossings → Task 8 (hill-climb). ✔
- §3 optimizer rewrite (seed → node-planar → reconcile → iterate → residual) → Tasks 4–8. The plan keeps `untangleLineOrder` as the SEED (Task 5 uses current `lineOrder`) rather than rewriting untangle's internals — a lower-risk realization of §3 step 1 ("run the existing untangle to get a good single order, then build endpoint orders from node planarity"). ✔
- §4 rendering / swaps at bends / overdraw safety → Tasks 2, 3, 7. ✔
- §5 marker unchanged + non-planar boxes → Task 10 (no marker code changed; only `mk.mega` forced). ✔
- §6 verification (new gate, existing gates, crops, tests, perf) → Tasks 9, 11, 12. ✔
- §7 phasing (4 phases, each ships) → Phases 1–4 map 1:1. ✔

**Placeholder scan:** No "TBD"/"implement later". Two intentional, named indirections: Task 10 Step 2 uses `nodeId`/`marks` as stand-ins for the renderer's real locals (the implementer reads the file in Step 1 to bind them — this is unavoidable without duplicating the marker-assembly block here), and Task 11's stderr capture has a documented file-sidecar fallback. Both specify the exact contract.

**Type consistency:** `edgeEndpointOrders` returns `{from, to}` (Task 1) consumed in Task 3. `IncidentEdge`/`NodePlanResult`/`desiredOrdersAtNode` (Task 4) consumed in Task 5. `totalEdgeCrossings`/`inversions` (Task 8) and `countCrossings`/`CrossingReport` (Task 9) consistent. `orderFrom?`/`orderTo?`/`nonPlanarNodes?` declared once in Task 1, used throughout. `buildEdgeLanes(base, orderFrom, orderTo, spacing, bias)` signature identical in Tasks 2, 3, 7.

**Risk note carried from spec §8:** this re-flows every line and touches the finickiest subsystem. The phased, gated rollout with a byte-identical Phase 1 and a per-phase review checkpoint is mandatory. The node-frame sign convention (Task 4 Step 4 / Task 5 Step 4) is the single most likely place to need TDD iteration — the tests pin it; do not skip them.
