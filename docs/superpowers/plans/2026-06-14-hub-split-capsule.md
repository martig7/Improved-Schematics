# Hub Split + Capsule Reunite — Implementation Plan (Phase 0 + Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a high-degree support-graph hub can be split into capsule-grouped sub-nodes that survive octilinearization (Phase 0 go/no-go), and ship the density "breathe" weighting that gives those splits room (Phase 1).

**Architecture:** Per the spec [`docs/superpowers/specs/2026-06-14-hub-split-capsule-design.md`](../specs/2026-06-14-hub-split-capsule-design.md). The split is a new pass on the merged support graph, run after `buildSupportGraph` and before `octi` (Approach B — topo untouched). This plan builds the foundational data-model + the octi/imageMerge survival guards, validates them with a hardcoded single-hub split (the feasibility gate), and lands the warp-sample weighting. The full split algorithm (dominant axis, hub-local order, line-level fan, recursion) and the capsule reunite are **deferred to a follow-up plan written after the Phase 0 gate** (their exact code depends on what the probe reveals).

**Tech Stack:** TypeScript (ES modules), Node test runner via `npx tsx --test`, Electron mod. No new deps.

**Scope note (decomposition):** This plan = spec Phase 0 + Phase 1. Spec Phases 2 (full `splitHubs` algorithm) and 3 (capsule reunite + ship) are outlined in the final section and will get their own bite-sized plan once Phase 0 passes — because the guard set and the hub-local-order heuristic must be proven before their code is worth writing in detail.

**Conventions for every task below:**
- Tests run from the repo root: `npx tsx --test "src/**/*.test.ts"` (whole suite) or `npx tsx --test src/render/layout/<file>.test.ts` (one file). NEVER vitest.
- Typecheck: `npx tsc --noEmit` (note: `imageMerge.ts`/`topo.ts` may show **pre-existing** unrelated errors — only your own files must be clean; filter with `npx tsc --noEmit 2>&1 | grep <yourfile>`).
- The whole feature is gated behind env `OCTI_SPLIT_HUBS` (read as `process.env.OCTI_SPLIT_HUBS === '1'`), default OFF — production behaviour is unchanged until it is explicitly turned on.
- `dev/` is gitignored (local only). The probe script in Task 4 is NOT committed; only `src/**` changes are.
- Commit only your own files (`git add <explicit paths>`); the working tree may carry the user's concurrent edits — never `git add -A`.

---

## File Structure

| File | Responsibility | This plan |
|---|---|---|
| `src/render/layout/types.ts` | Support/Layout type defs | **Modify** — add `splitGroup?`, `splitInternal?` |
| `src/render/layout/octi.ts` | Octilinearizer + its `contractShortEdges`/`combineDeg2` | **Modify** — survival guards |
| `src/render/layout/imageMerge.ts` | `mergeCoincidentPaths`, `separateFusedStations` | **Modify** — survival guards |
| `src/render/layout/splitHubs.ts` | The split pass | **Create** — minimal hardcoded split (Phase 0); generalized later |
| `src/render/layout/splitHubs.test.ts` | Split-pass tests | **Create** — grows in Phase 2 |
| `src/render/layout/warpWeight.ts` | Pure warp-sample weight fn | **Create** (Phase 1, C1) |
| `src/render/layout/warpWeight.test.ts` | Weight fn tests | **Create** (Phase 1) |
| `src/render/renderGeographic.ts` | Smoothed pipeline wiring | **Modify** — call `splitHubs` + use weight fn |
| `dev/_probe-split.ts` | Phase 0 feasibility probe | **Create (local, uncommitted)** |

---

## PHASE 0 — Feasibility slice (go/no-go gate)

Phase 0 is a **prototype + integration check**, not full unit-TDD: it proves the risky part (a split survives octi + imageMerge). The data-model and guards it lands are real, committed, and reused by Phase 2; the *split logic* here is a throwaway hardcode that Phase 2 replaces.

### Task 1: Data-model fields

**Files:**
- Modify: `src/render/layout/types.ts` (`SupportNode` ~113, `SupportEdge` ~120, `LayoutNode` ~59)

- [ ] **Step 1: Add the optional fields**

In `SupportNode`:
```ts
export interface SupportNode {
  id: string;
  pos: Pixel;
  /** All sub-nodes split from one hub share this id (= the station-group id
   *  when the hub was a station). Lets the renderer reunite them under one
   *  capsule and lets octi/imageMerge guards preserve them. */
  splitGroup?: string;
}
```

In `SupportEdge`:
```ts
export interface SupportEdge {
  id: string;
  from: string;
  to: string;
  points: Pixel[];
  lineIds: Set<string>;
  /** A spine/fan edge internal to a split hub. Must not be contracted or
   *  merged away (octi.combineDeg2 / contractShortEdges / imageMerge skip it). */
  splitInternal?: boolean;
}
```

In `LayoutNode`:
```ts
export interface LayoutNode {
  id: string;
  cell: Cell;
  label: string;
  lngLat: Coordinate;
  /** Carried through from the support node so the renderer can group a
   *  split hub's sub-nodes into one capsule. */
  splitGroup?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "types.ts"`
Expected: no output (additive optional fields don't break existing code).

- [ ] **Step 3: Commit**

```bash
git add src/render/layout/types.ts
git commit -m "feat(types): splitGroup/splitInternal fields for hub-split"
```

### Task 2: octi survival guards

**Files:**
- Modify: `src/render/layout/octi.ts` (`contractShortEdges` ~107–146; `combineDeg2` ~409)

Both functions collapse short / degree-2 structure and would silently undo a split. Mirror the existing `stationNodes` guard.

- [ ] **Step 1: Guard `contractShortEdges`**

In `octi.ts`, the short-edge loop already skips terminal station stubs (octi.ts:141–146). Extend the skip to split-internal structure. Immediately after the `if (polyLen(e.points) >= minLen) continue;` line (octi.ts:137), add:
```ts
    // Hub-split guard: never contract a spine/fan edge or merge a split
    // sub-node back into its sibling — the split must survive to the renderer.
    if (e.splitInternal || nodes.get(e.from)?.splitGroup || nodes.get(e.to)?.splitGroup) {
      continue;
    }
```

- [ ] **Step 2: Guard `combineDeg2`**

`combineDeg2` (octi.ts ~409) collapses degree-2 nodes whose two edges share a line set. A binary split leaf is degree-2 (one external edge + the spine) and would be collapsed. At the very top of its per-node decision (where it picks a node to collapse), add a skip:
```ts
      // Hub-split guard: a split sub-node is intentionally low-degree; collapsing
      // it would re-merge the hub. Skip nodes tagged splitGroup or edges tagged
      // splitInternal.
      if (node.splitGroup) continue;
      if (e1.splitInternal || e2.splitInternal) continue;
```
(Use whatever the local variable names are for the node and its two incident edges; the condition is: skip if the node has `splitGroup`, or either incident edge has `splitInternal`.)

- [ ] **Step 3: Build a guard test fixture**

Create `src/render/layout/splitHubs.test.ts` with a helper that builds a tiny support graph containing a degree-2 split leaf, runs octi, and asserts the leaf survives. (octi's internals aren't exported, so this is an integration assertion through the public `octi()` + the layout build — see Task 4 for the full pipeline path; if asserting survival through `octi()` alone is awkward, defer this assertion to the Task 4 probe and leave Task 2 verified by Step 4 typecheck + the probe.)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// NOTE: this test file is fleshed out in Task 4 / Phase 2 once the minimal
// splitHubs + pipeline access exists. For Task 2, the guards are verified
// end-to-end by the Task 4 probe (the spec's go/no-go gate).
test('splitHubs guards: placeholder until Task 4 wires the pipeline', () => {
  assert.ok(true);
});
```

- [ ] **Step 4: Typecheck + run suite (no regressions)**

Run: `npx tsc --noEmit 2>&1 | grep -E "octi.ts"` → expected: no output.
Run: `npx tsx --test "src/**/*.test.ts"` → expected: all pass (guards are dormant — nothing sets `splitGroup`/`splitInternal` yet).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/octi.ts src/render/layout/splitHubs.test.ts
git commit -m "feat(octi): contraction guards for split sub-nodes (dormant)"
```

### Task 3: imageMerge survival guards

**Files:**
- Modify: `src/render/layout/imageMerge.ts` (`mergeCoincidentPaths` ~73 / `nodeVerts` ~115; `separateFusedStations` ~319)

- [ ] **Step 1: Preserve split sub-nodes in `mergeCoincidentPaths`**

`mergeCoincidentPaths` deduplicates grid vertices but preserves "original" nodes via the `nodeVerts` set (imageMerge.ts ~115). Add every `splitGroup` support node to that preserved set exactly as station nodes are preserved, so two sub-nodes that octi placed in adjacent cells are never deduped into one. Find where `nodeVerts` (or the equivalent original-node guard) is populated and add: for each `n` in `h.nodes.values()` where `n.splitGroup`, mark its vertex preserved.

- [ ] **Step 2: Don't re-fuse split siblings in `separateFusedStations`**

`separateFusedStations` (imageMerge.ts ~319) re-splits fused stations; ensure it never *fuses* two nodes that carry the same `splitGroup`. At the point where it decides two stations occupy one node, add: if both carry the same `splitGroup`, leave them separate (they are an intentional split, not an accidental fusion).

- [ ] **Step 3: Typecheck + run suite**

Run: `npx tsc --noEmit 2>&1 | grep -E "imageMerge.ts"` → expected: no NEW errors beyond any pre-existing ones (compare against `git stash` baseline if unsure).
Run: `npx tsx --test "src/**/*.test.ts"` → expected: all pass (dormant).

- [ ] **Step 4: Commit**

```bash
git add src/render/layout/imageMerge.ts
git commit -m "feat(imageMerge): preserve split sub-nodes through merge (dormant)"
```

### Task 4: Minimal `splitHubs` + probe (THE GATE)

**Files:**
- Create: `src/render/layout/splitHubs.ts`
- Modify: `src/render/renderGeographic.ts` (between `buildSupportGraph` ~497 and `octi` ~579)
- Create (local, uncommitted): `dev/_probe-split.ts`

- [ ] **Step 1: Minimal hardcoded split**

Create `src/render/layout/splitHubs.ts`. For Phase 0 it does ONE thing: find the highest-line-degree station node and split it once, perpendicular, into two sub-nodes joined by a spine, distributing its incident edges by the sign of their bearing's projection onto the perpendicular axis, and tag everything with `splitGroup`/`splitInternal`. Real, but single-level and not yet line-level-fan (that's Phase 2).

```ts
import type { SupportGraph, SupportNode, SupportEdge, Pixel } from './types';

const enabled = (): boolean =>
  typeof process !== 'undefined' &&
  (process as { env?: Record<string, string> }).env?.OCTI_SPLIT_HUBS === '1';

/** ldeg(n) = total line-occupancy across incident edges. */
function ldeg(h: SupportGraph, nodeId: string): number {
  let n = 0;
  for (const eid of h.adj.get(nodeId) ?? []) n += h.edges.get(eid)?.lineIds.size ?? 0;
  return n;
}

/** Bearing of edge e leaving node nodeId (using the polyline's near segment). */
function bearingAt(h: SupportGraph, e: SupportEdge, nodeId: string): number {
  const pts = e.from === nodeId ? e.points : [...e.points].reverse();
  const a = pts[0];
  const b = pts[1] ?? pts[0];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/**
 * PHASE 0 ONLY: split the single highest-ldeg station node once, perpendicular
 * to its dominant axis, into two splitGroup sub-nodes joined by a spine.
 * Behind OCTI_SPLIT_HUBS. Returns the (mutated) graph for chaining.
 */
export function splitHubs(h: SupportGraph): SupportGraph {
  if (!enabled()) return h;
  // pick the highest-ldeg station node
  let target: string | null = null;
  let best = -1;
  for (const st of h.stations.values()) {
    const d = ldeg(h, st.nodeId);
    if (d > best) { best = d; target = st.nodeId; }
  }
  if (!target || best < 6) return h; // nothing worth splitting

  const node = h.nodes.get(target)!;
  const incident = [...(h.adj.get(target) ?? [])].map((id) => h.edges.get(id)!).filter(Boolean);
  // dominant axis = line-weighted mean bearing direction
  let mx = 0, my = 0;
  for (const e of incident) {
    const th = bearingAt(h, e, target);
    const w = e.lineIds.size;
    mx += Math.cos(2 * th) * w; my += Math.sin(2 * th) * w; // doubled angle: axis, not direction
  }
  const axis = Math.atan2(my, mx) / 2;
  const perp: Pixel = [-Math.sin(axis), Math.cos(axis)];
  const groupId = (() => {
    for (const st of h.stations.values()) if (st.nodeId === target) return st.id;
    return target;
  })();

  const OFFSET = 8;
  const plus: SupportNode = { id: target + '__sp+', pos: [node.pos[0] + perp[0] * OFFSET, node.pos[1] + perp[1] * OFFSET], splitGroup: groupId };
  const minus: SupportNode = { id: target + '__sp-', pos: [node.pos[0] - perp[0] * OFFSET, node.pos[1] - perp[1] * OFFSET], splitGroup: groupId };
  h.nodes.set(plus.id, plus);
  h.nodes.set(minus.id, minus);
  h.adj.set(plus.id, []);
  h.adj.set(minus.id, []);

  // reattach incident edges: + side if bearing projects onto +perp, else −.
  for (const e of incident) {
    const th = bearingAt(h, e, target);
    const side = Math.cos(th) * perp[0] + Math.sin(th) * perp[1] >= 0 ? plus : minus;
    if (e.from === target) { e.from = side.id; e.points[0] = side.pos; }
    if (e.to === target) { e.to = side.id; e.points[e.points.length - 1] = side.pos; }
    h.adj.get(side.id)!.push(e.id);
  }

  // spine edge plus—minus carrying the union of lines (Phase 0 approximation)
  const spineLines = new Set<string>();
  for (const e of incident) for (const l of e.lineIds) spineLines.add(l);
  const spine: SupportEdge = {
    id: target + '__spine', from: plus.id, to: minus.id,
    points: [plus.pos, minus.pos], lineIds: spineLines, splitInternal: true,
  };
  h.edges.set(spine.id, spine);
  h.adj.get(plus.id)!.push(spine.id);
  h.adj.get(minus.id)!.push(spine.id);

  // remove the old hub node + repoint its station record onto the split group
  h.nodes.delete(target);
  h.adj.delete(target);
  for (const st of h.stations.values()) {
    if (st.nodeId === target) { st.nodeId = plus.id; (st as { splitNodeIds?: string[] }).splitNodeIds = [plus.id, minus.id]; }
  }
  return h;
}
```

- [ ] **Step 2: Wire into the pipeline**

In `src/render/renderGeographic.ts`, import and call between `buildSupportGraph` (line ~497) and the `octi(...)` call (line ~579). Add the import near the other layout imports:
```ts
import { splitHubs } from './layout/splitHubs';
```
Then right after `const support = buildSupportGraph(graph, groups, topoParams);` (line 497):
```ts
  splitHubs(support); // behind OCTI_SPLIT_HUBS; no-op otherwise
```

- [ ] **Step 3: Build the probe (local, uncommitted)**

Create `dev/_probe-split.ts` (mirrors `dev/render-from-dump.ts` but asserts split survival). It renders SEA with the flag and checks the two sub-nodes reached the final SVG.

```ts
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const d = dump['debug-render-input'] ?? dump;
const svg = generateSchematicSVG({
  routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false, dark: process.env.IS_DARK === '1' },
});
writeFileSync('dev/_probe-split.svg', svg);
writeFileSync('dev/_probe-split.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng());
// survival check: the split sub-node ids carry the "__sp" marker into stop/lane data-attrs
const hits = (svg.match(/__sp[+-]/g) ?? []).length;
console.log(`split-survival markers in SVG: ${hits} (expect > 0 with OCTI_SPLIT_HUBS=1)`);
console.log('wrote dev/_probe-split.svg / .png');
```
(If sub-node ids don't appear in `data-*` attrs, instead add a temporary `console.error` in `supportToLayout`/render logging the surviving node ids and grep that — the point is to confirm both `__sp+` and `__sp-` reach the layout.)

- [ ] **Step 4: Run the probe — baseline vs split**

Run baseline: `npx tsx dev/_probe-split.ts` → note it renders normally (flag off).
Run split: `OCTI_SPLIT_HUBS=1 IS_DARK=1 npx tsx dev/_probe-split.ts` → expected: `split-survival markers ... > 0`, and the PNG shows the chosen hub as TWO nodes joined by a short connector (not collapsed back to one).

- [ ] **Step 5: GO/NO-GO decision (record it)**

Inspect `dev/_probe-split.png` and the survival count. **GO** if: both sub-nodes survive octi + imageMerge (markers > 0 / both ids in layout), octi did not blow up violations around them (run `npx tsx dev/_chk-octi.ts dev/_probe-split.svg` → still `0 non-octilinear` or only the split's own minor delta), and the render is sane. **NO-GO** if the split silently reverts (markers 0) or octi violations spike — then the guards are insufficient and Phase 2 must rethink the representation before more investment.

Record the outcome (GO/NO-GO + notes) in the project memory `loom-octi-pipeline.md` and STOP if NO-GO.

- [ ] **Step 6: Commit (src only — probe stays local)**

```bash
git add src/render/layout/splitHubs.ts src/render/renderGeographic.ts
git commit -m "feat(splitHubs): minimal perpendicular hub split behind OCTI_SPLIT_HUBS (Phase 0)"
```

---

## PHASE 1 — C1 warp weighting (TDD, shippable)

Independent of the gate: makes split-candidate hubs breathe. Pure, tested, flag-gated.

### Task 5: `splitWarpWeight` pure function

**Files:**
- Create: `src/render/layout/warpWeight.ts`
- Create: `src/render/layout/warpWeight.test.ts`

- [ ] **Step 1: Write the failing test**

`src/render/layout/warpWeight.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWarpWeight } from './warpWeight';

test('splitWarpWeight: off-flag keeps the legacy min(4, ldeg) cap', () => {
  assert.equal(splitWarpWeight(2, false), 2);
  assert.equal(splitWarpWeight(9, false), 4); // capped at 4 when split disabled
  assert.equal(splitWarpWeight(0, false), 1); // floor of 1
});

test('splitWarpWeight: on-flag lifts the cap toward expected leaves', () => {
  // expectedLeaves ~= ceil(ldeg / TARGET_LINES_PER_LEAF=3); cap WARP_CAP=10
  assert.ok(splitWarpWeight(9, true) > splitWarpWeight(9, false), 'busier hub breathes more');
  assert.equal(splitWarpWeight(9, true), 3); // ceil(9/3)
  assert.equal(splitWarpWeight(30, true), 10); // capped at WARP_CAP
  assert.equal(splitWarpWeight(2, true), 1); // small hub: ceil(2/3)=1
});

test('splitWarpWeight: monotonic non-decreasing in ldeg (on-flag)', () => {
  let prev = 0;
  for (let d = 0; d <= 40; d++) {
    const w = splitWarpWeight(d, true);
    assert.ok(w >= prev, `non-decreasing at ldeg=${d}`);
    prev = w;
  }
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx tsx --test src/render/layout/warpWeight.test.ts`
Expected: FAIL — `Cannot find module './warpWeight'`.

- [ ] **Step 3: Implement**

`src/render/layout/warpWeight.ts`:
```ts
// Warp-sample weight per hub. Off: the legacy min(4, ldeg) cap. On
// (OCTI_SPLIT_HUBS): weight by how many sub-nodes the hub is expected to split
// into, so the density warp dilates around it proportionally (spec C1).
const TARGET_LINES_PER_LEAF = 3;
const WARP_CAP = 10;
const LEGACY_CAP = 4;

export function splitWarpWeight(ldeg: number, splitEnabled: boolean): number {
  if (!splitEnabled) return Math.max(1, Math.min(LEGACY_CAP, ldeg));
  const expectedLeaves = Math.ceil(Math.max(0, ldeg) / TARGET_LINES_PER_LEAF);
  return Math.max(1, Math.min(WARP_CAP, expectedLeaves));
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx tsx --test src/render/layout/warpWeight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/warpWeight.ts src/render/layout/warpWeight.test.ts
git commit -m "feat(warp): splitWarpWeight — breathe weighting for split hubs"
```

### Task 6: Wire weighting into the pipeline

**Files:**
- Modify: `src/render/renderGeographic.ts` (warp-sample loop, lines 444–453)

- [ ] **Step 1: Replace the inline cap with the weight fn**

Add the import:
```ts
import { splitWarpWeight } from './layout/warpWeight';
```
Replace the body of the warp-sample loop (renderGeographic.ts 444–453) so the weight comes from the helper, gated by the flag:
```ts
  const splitEnabled =
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_SPLIT_HUBS === '1';
  const warpSamples: Pixel[] = [];
  for (const n of graph.nodes.values()) {
    const p = baseProj.toSVG(n.lngLat);
    const lines = new Set<string>();
    for (const eid of graph.adj.get(n.id) ?? []) {
      const e = graph.edges.find((x) => x.id === eid);
      if (e) for (const l of e.lines) lines.add(l.id);
    }
    const w = splitWarpWeight(lines.size, splitEnabled);
    for (let i = 0; i < w; i++) warpSamples.push(p);
  }
```

- [ ] **Step 2: Verify no behaviour change with flag OFF**

Run: `npx tsx --test "src/**/*.test.ts"` → expected: all pass (existing `densityWarp` tests unaffected; the off-flag path is byte-identical to the old `min(4, lines.size)`).
Render baseline: `IS_DARK=1 npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_w_base` → confirm unchanged vs a pre-change render (water/transit identical; flag off).

- [ ] **Step 3: Verify breathe with flag ON**

Run: `OCTI_SPLIT_HUBS=1 IS_DARK=1 npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_w_split` → expected: busy hubs occupy more area (more dilation around interchanges); `npx tsx dev/_chk-octi.ts dev/_w_split.svg` still `0 non-octilinear` (warp stays monotone/fold-free).

- [ ] **Step 4: Commit**

```bash
git add src/render/renderGeographic.ts
git commit -m "feat(warp): weight hub samples by expected split size (flag-gated)"
```

---

## Self-review (done while writing — recorded here)

- **Spec coverage (Phase 0+1):** C1 → Tasks 5–6. Data model → Task 1. octi guards → Task 2. imageMerge guards → Task 3. Feasibility gate → Task 4. Flag gating → every task. Phases 2–3 → explicitly deferred (below). ✔
- **Type consistency:** `splitGroup?: string` on `SupportNode`/`LayoutNode`; `splitInternal?: boolean` on `SupportEdge`; `splitHubs(h: SupportGraph): SupportGraph`; `splitWarpWeight(ldeg: number, splitEnabled: boolean): number`. Used consistently across Tasks 1/2/3/4/5/6. ✔
- **Placeholder honesty:** the Task 2/Step 3 test is an intentional stand-in because octi internals aren't exported — the guards are verified by the Task 4 integration probe (the spec's go/no-go), not a unit test. This is called out, not hidden. The `combineDeg2` guard names local vars generically because the exact identifiers must be read in-file. These are the two spots needing in-file judgement; everything else is concrete.

---

## DEFERRED — Phase 2 & Phase 3 (separate plan, after the gate)

Authored only if Task 4 is **GO**. Outline so the shape is clear:

**Phase 2 — full `splitHubs` algorithm** (replaces the Task-1 hardcode in `splitHubs.ts`):
- `dominantAxis(n)`, `hubLocalOrder(n, axis)` (exit-bearing sort), `splitAtCountMidpoint` — each its own TDD unit on synthetic graphs (the 4/5 partition, through-lines-only on the spine, straddle-split, termination, degenerate no-op).
- Line-level fan representation (retained fork point + `H→+`/`H→−` fan edges; split straddling outgoing edges).
- Binary recursion under `DEG_CAP`/`LDEG_CAP` (env `OCTI_SPLIT_DEGCAP`/`OCTI_SPLIT_LDEGCAP`).
- Gates on SEA + NYC; success metric = **mega-box count drops** with octi/seating/overdraw/markerfit unchanged.

**Phase 3 — capsule reunite + ship** (`renderOctilinear.ts`/`stops.ts`):
- `StMarks.nodeId` → `nodeIds: string[]`; gather marks across the `splitGroup`; `solveRows` over the union; `boxOf`/mega fallback across the union; carry `splitGroup` onto `LayoutNode` in `supportToLayout`.
- Local↔global order reconciliation (seed `orderLines` from the hub-local order, or accept rare residual crossing — decide from Phase 0 data).
- Named before/after crops (NYC midtown, Flatbush, Park Av; Seattle downtown), full sweep, default `OCTI_SPLIT_HUBS` on after sign-off, version bump.

---

## Execution Handoff

(Filled in by the writing-plans handoff step.)
