# Micro-Edge Chains C2: Rails Construction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind `OCTI_CHAIN=1` (default off), replace chain-interior lane polylines with rails derived from anchor frames, so every line touching a chain shares one frame family and interior seat seams resolve as placed transitions instead of per-node jogs.

**Architecture:** `detectChains` gains per-interior-node reach data. A new `chainRails.ts` builds, per (chain, line), a variable-offset rail over the line's interior sub-path: entry/exit seats from the bounding frames in the line's own traversal, the seat transition placed in the largest reach-free interior room (45-degree ceiling), rail geometry via a new variable-offset polyline helper, and interior `segPath` lanes replaced slice-by-slice so all downstream machinery sees ordinary lanes. Runs after joint seating, before the fan.

**Tech Stack:** TypeScript, Node built-in test runner, existing env gating (`src/env.ts`).

---

### Task 1: variable-offset polyline helper

**Files:**
- Modify: `src/render/layout/offsets.ts`
- Test: `src/render/layout/tests/offsets.test.ts` (create if absent)

- [ ] **Step 1: Failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { offsetPolylineVar } from '../offsets';
import type { Pixel } from '../types';

test('offsetPolylineVar: per-vertex offsets with miter bisectors', () => {
  // L-shaped centerline; constant offsets must match offsetPolyline's
  // corner behaviour, varying offsets must interpolate at the vertices.
  const pts: Pixel[] = [[0, 0], [50, 0], [100, 0], [100, 50]];
  const rail = offsetPolylineVar(pts, [4, 4, 4, 4]);
  assert.equal(rail.length, 4);
  assert.ok(Math.abs(rail[0][1] - 4) < 1e-6, 'start offset: ' + rail[0][1]);
  assert.ok(Math.abs(rail[3][0] - 96) < 1e-6, 'end offset: ' + rail[3][0]);
  // corner vertex offsets along the bisector (45 degrees for the right angle)
  assert.ok(rail[2][0] < 100 && rail[2][1] > 0, 'corner on the inner bisector side');
  const vary = offsetPolylineVar(pts, [0, 2, 4, 4]);
  assert.ok(Math.abs(vary[0][1]) < 1e-6, 'zero start stays');
  assert.ok(Math.abs(vary[1][1] - 2) < 1e-6, 'mid vertex at its own offset');
});
```

- [ ] **Step 2: Run to verify failure** (`npx tsx --test src/render/layout/tests/offsets.test.ts`)

- [ ] **Step 3: Implement in offsets.ts** (mirror `offsetPolyline`'s normal computation; one offset per vertex)

```ts
/** offsetPolyline with a PER-VERTEX offset (px). Same miter-bisector
 *  normals; the caller is responsible for inserting vertices at every
 *  offset-transition boundary (a transition between two vertices is
 *  linear along the segment). Does not simplify. */
export function offsetPolylineVar(pts: Pixel[], offsets: number[]): Pixel[] {
  if (pts.length < 2 || offsets.length !== pts.length) return pts.map((p) => p.slice() as Pixel);
  const out: Pixel[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    let normal: Pixel;
    if (!prev) {
      normal = perp(unit(cur, next));
    } else if (!next) {
      normal = perp(unit(prev, cur));
    } else {
      const n1 = perp(unit(prev, cur));
      const n2 = perp(unit(cur, next));
      const sum: Pixel = [n1[0] + n2[0], n1[1] + n2[1]];
      const sumLen = hyp(sum[0], sum[1]);
      if (sumLen < 1e-6) {
        normal = n1;
      } else {
        const miter = Math.max(0.5, (n1[0] * n2[0] + n1[1] * n2[1] + 1) / 2);
        normal = [sum[0] / sumLen / Math.sqrt(miter), sum[1] / sumLen / Math.sqrt(miter)];
      }
    }
    out.push([cur[0] + normal[0] * offsets[i], cur[1] + normal[1] * offsets[i]]);
  }
  return out;
}
```

- [ ] **Step 4: Tests pass, full suite passes, commit** (`feat(offsets): per-vertex variable-offset polyline`)

### Task 2: interior-node reach on Chain

**Files:**
- Modify: `src/render/chains.ts`
- Modify: `src/render/tests/chains.test.ts`

- [ ] **Step 1: Failing assertion** — extend the two-edge chain test:

```ts
assert.equal(chains[0].interiorNodes.length, 1);
assert.equal(chains[0].interiorNodes[0].node, 'C');
assert.ok(chains[0].interiorNodes[0].reach > 0);
```

- [ ] **Step 2: Implement** — `Chain` gains `interiorNodes: Array<{ node: string; reach: number }>` (the shared node between each consecutive interior edge pair, with `reachAt`); populate during the walk from the already-computed `reachAt` map.

- [ ] **Step 3: Tests pass, commit** (`feat(chains): interior-node reach data for rails`)

### Task 3: rails builder

**Files:**
- Create: `src/render/chainRails.ts`
- Test: `src/render/tests/chainRails.test.ts`

Interface:

```ts
export interface RailArgs {
  chains: Chain[];
  edgeById: Map<string, { id: string; from: string; to: string }>;
  basePoly: (edgeId: string) => Pixel[] | undefined;
  /** slot+bias lateral offset of a line's lane on an edge, in the edge's
   *  from->to frame; undefined when the line has no lane there. */
  laneOffsetOf: (edgeId: string, lineId: string) => number | undefined;
  lineTraversals: Map<string, Array<{ edgeId: string; reversed: boolean }>>;
  /** edge.id|lineId lane polylines, interior entries REPLACED in place. */
  segPath: Map<string, Pixel[]>;
  suppressed: Set<string>;
  spacing: number;
}
/** Returns the number of (chain, line) rails built. */
export function buildChainRails(args: RailArgs): number;
```

Construction per (chain, line), in sorted chain-then-line order:

1. The line's interior sub-path: the maximal contiguous run of the
   chain's `edgeIds` present in its traversal with undeleted, unsuppressed
   lanes. Orientation follows the traversal.
2. Entry seat: `laneOffsetOf(prevEdge, lineId)` where prevEdge is the
   edge before the sub-path in the traversal (the anchor when the line
   spans the whole chain), sign-mapped into the sub-path frame; when the
   line STARTS in the chain (terminus), the entry seat falls back to its
   first interior edge's own offset. Exit seat symmetric.
3. Sub-path centerline: concatenated interior base polylines (oriented,
   deduped joints). Transition span: the largest arclength interval
   between interior-node reach balls (from `interiorNodes`); its length
   is `max(|exit - entry| , spacing)` capped at the interval, centered;
   when no interval exists the transition centers on the interior node
   with the LOWEST reach (riding the turn). Insert vertices at the
   transition boundaries; per-vertex offsets = entry seat before, linear
   inside, exit seat after; rail = `offsetPolylineVar`.
4. Replace: slice the rail back into per-edge lane polylines by the
   centerline's edge-boundary arclengths and `segPath.set` each interior
   edge|line key (orientation restored to the edge's from->to).

Tests (fixtures in the chains test style, 3-lane corridor with two
interior edges as in C1's first fixture):

- rail transition lands inside the reach-free interior room and both
  anchors' end offsets are exactly the entry/exit seats;
- with interior room fully covered by reach, the transition centers on
  the lowest-reach node;
- a branch line (leaves at the interior node) gets a rail over its
  ridden edges only, and its pitch to a pass-through mate is `spacing`
  at every shared arclength (sample both rails);
- anchor lanes in segPath are untouched (byte-equal before/after).

- [ ] TDD steps as in Task 1 (fail, implement, pass, full suite, commit
  `feat(chains): anchor-frame rails over chain interiors (C2)`).

### Task 4: renderer wiring behind OCTI_CHAIN

**Files:**
- Modify: `src/render/renderOctilinear.ts`

- [ ] **Step 1:** After the joint-seating block and before the fan gate:

```ts
if (envStr('OCTI_CHAIN') === '1') {
  buildChainRails({
    chains,
    edgeById,
    basePoly: (id) => {
      const e = edgeById.get(id);
      return e ? edgePolyline(e) : undefined;
    },
    laneOffsetOf: (edgeId, lineId) => {
      const slot = slotOf.get(edgeId + '|' + lineId);
      if (slot === undefined) return undefined;
      return slot + (biasOf.get(edgeId) ?? 0);
    },
    lineTraversals: layout.lineTraversals,
    segPath,
    suppressed,
    spacing,
  });
}
```

- [ ] **Step 2:** Full suite passes; a corpus render WITHOUT the flag is
  byte-identical on the SVG output (spot-check one city's file hash).
  Commit (`feat(render): chain rails behind OCTI_CHAIN (C2, default off)`).

### Task 5: flag-on corpus A/B

- [ ] Render the 6-city corpus with `OCTI_CHAIN=1 OCTI_FANZONE=1
  OCTI_CLIPS=1 OCTI_LOOPS=1 OCTI_ZIGS=1` (background; renders are slow)
  and compare against the flag-off logs:
  - the taper-intrusion trio on the two-edge chain resolves (its seams
    become the rail transition);
  - clips/loops/zigs: no NEW entries anywhere; artifact loops stay 0
    (the self-cross plus shape is an explicit watch item);
  - skeleton-crop the trio's junction complex and the parked-ordering
    corridor for visual review (skeletons for analysis, per CLAUDE.md).
- [ ] Record results in auto-memory; report with numbers and skeletons.
  C3 (default flip + variant gates) is planned only after this A/B.
