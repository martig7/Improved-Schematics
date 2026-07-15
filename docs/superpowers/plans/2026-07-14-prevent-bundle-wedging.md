> **SUPERSEDED (2026-07-14).** This plan targeted the block-algebra *seed*, which
> the investigation falsified as the cause. The wedge was in `rescueTwists`; the
> shipped fix is bundle-granularity twist migration. See the design doc's
> "Diagnosis" and "Fix" sections for what actually landed. The `coTravel.ts`
> module and the `dev/` rulers below were reused; the seed-integration tasks were
> not. Kept for the ruler/metric definitions and the falsification record.

# Prevent bundle wedging (and the downstream V-split) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the bundle-blocks orderer from seating a foreign line inside a co-traveling bundle at dense hubs, which removes the downstream capsule V-split.

**Architecture:** Add a pure, deterministic co-travel grouping module. In `seedBlock`, after the existing exit-key sort, constrain the order so lines that share many downstream corridors stay contiguous, reusing the existing `reorderToGroups`. Joins and the residual branch are untouched in the main path. A `dev/` wedge census is the pinned ruler; a hard corpus gate (planned + residual crossings must not increase) can veto the change.

**Tech stack:** TypeScript, Node's built-in test runner (`tsx --test`), the existing `src/render/layout` bundle-blocks code.

**Design reference:** `docs/superpowers/specs/2026-07-14-prevent-bundle-wedging-design.md`

---

## File structure

- Create `src/render/layout/coTravel.ts` — pure grouping: per-line corridor sets, pairwise strength, threshold components. No `Layout`-mutation, no floating point beyond what it is handed.
- Create `src/render/layout/tests/coTravel.test.ts` — unit tests for the module.
- Modify `src/render/layout/bundleOrder.ts` — build per-line corridor sets once; use co-travel components inside `seedBlock`.
- Modify `src/render/layout/tests/bundleOrder.test.ts` — one integration test (seed keeps a fork-and-reconverge pair contiguous; membership + idempotence preserved).
- Create `dev/_wedge_census.ts` (gitignored `dev/`) — the wedge ruler over the map dumps.
- Modify `src/render/mapCache.ts` — bump `VERSION` so cached layouts regenerate.

---

## Task 1: Wedge census ruler (`dev/_wedge_census.ts`)

Built first: it is the falsifiable ruler for every later gate, and its wedge
definition is deliberately **independent** of the fix module (pure geometry of
the drawn order), so it cannot flatter the change.

**Wedge definition (module-independent):** on an edge, a line `L` at lateral
position `i` is *wedged* when its two lateral neighbours `order[i-1]` and
`order[i+1]` both continue past the edge's shared endpoint into the **same**
next corridor while `L` continues into a **different** one (or terminates).
That is exactly "a line splitting a pair that stays together".

**Files:**
- Create: `dev/_wedge_census.ts`

- [ ] **Step 1: Write the census script**

```ts
// scratch (dev/, gitignored): count "wedged" lines across the map dumps. A
// line is wedged on an edge when both its lateral neighbours exit the shared
// node toward the SAME next corridor and the line does not. Module-independent
// ruler for the bundle-wedging fix; run before and after to size the effect.
import { readFileSync, readdirSync } from 'fs';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import { buildCorridors } from '../src/render/layout/bundleOrder';

const dumps = readdirSync('testdata').filter((f) => /^improvedschematics-map-.*\.json$/.test(f));

for (const file of dumps.sort()) {
  const j = JSON.parse(readFileSync(`testdata/${file}`, 'utf-8'));
  const d = j.inputDump;
  if (!d) continue;
  const options = { ...d.options, mode: 'smoothed', megaFallback: 'curve', dark: false, stationDesign: 'london', showLabels: true, showStations: true };
  const pre: any = precomputeSmoothedSchematic({ routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups, geography: d.geography, options });
  drawSmoothedSchematic(pre, options);
  const layout = pre.layout;
  const cs = buildCorridors(layout);

  // next corridor id for `line` leaving node `nd` along the edge whose corridor
  // is `here`: the incident corridor at nd, other than `here`, that carries line
  const corrAt = (edgeId: string) => cs.byEdge.get(edgeId);
  const nextCorr = (nd: string, here: number, line: string): number | null => {
    for (const c of cs.atNode.get(nd) ?? []) {
      if (c.id === here) continue;
      if (c.lines.includes(line)) return c.id;
    }
    return null;
  };

  let wedges = 0;
  const worst: Array<{ edge: string; order: string[] }> = [];
  for (const e of layout.edges as any[]) {
    const order: string[] = e.lineOrder ?? e.lines.map((l: any) => l.id);
    if (order.length < 3) continue;
    const here = corrAt(e.id);
    if (!here) continue;
    let edgeWedged = false;
    for (let i = 1; i + 1 < order.length; i++) {
      // evaluate at BOTH endpoints; a wedge at either end counts once
      for (const nd of [e.from, e.to]) {
        const nl = nextCorr(nd, here.id, order[i - 1]);
        const nr = nextCorr(nd, here.id, order[i + 1]);
        const nm = nextCorr(nd, here.id, order[i]);
        if (nl !== null && nl === nr && nm !== nl) { wedges++; edgeWedged = true; break; }
      }
    }
    if (edgeWedged) worst.push({ edge: e.id, order });
  }
  console.log(`WEDGE_JSON ${JSON.stringify({ city: file, wedges, edges: worst.length, worst: worst.slice(0, 6) })}`);
}
```

- [ ] **Step 2: Run it and record the baseline**

Run (slow; background it): `npx tsx dev/_wedge_census.ts`
Expected: one `WEDGE_JSON` line per dump. Record the `wedges` count per city;
this is the pre-change baseline. Confirm the NYC dump shows a nonzero count and
that its `worst` list includes the 6-line 9St/14St corridor with the PATH pair
split by the B (order contains `... JSQ B HOB ...` bullets' ids).

- [ ] **Step 3: Commit the ruler**

`dev/` is gitignored, so nothing to commit here. Note the baseline numbers in
the task tracker / commit body of Task 3 instead.

---

## Task 2: Co-travel grouping module (`coTravel.ts`)

Pure and deterministic: integer set-intersections, union-find, total tie-breaks.
No `Layout` import beyond the read-only types it is handed. Mirrors
`blockAlgebra.ts`'s contract.

**Files:**
- Create: `src/render/layout/coTravel.ts`
- Test: `src/render/layout/tests/coTravel.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coTravelComponents } from '../coTravel';

// synthetic strength matrix: two tight pairs {A,B},{C,D} (share 5), a foreign
// line X that shares 2 with A only, everything else shares 1 (the universal
// baseline). tie() is a total order used only to break ties deterministically.
const mk = (m: Record<string, Record<string, number>>) => (a: string, b: string) =>
  a === b ? Infinity : (m[a]?.[b] ?? m[b]?.[a] ?? 0);

const S = mk({
  A: { B: 5, C: 1, D: 1, X: 2 },
  B: { C: 1, D: 1, X: 1 },
  C: { D: 5, X: 1 },
  D: { X: 1 },
});
const tie = (l: string) => l.charCodeAt(0);

test('coTravel: tight pairs group, weak-shared foreign line stays out (T=3)', () => {
  const comp = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 3);
  assert.equal(comp.get('A'), comp.get('B'), 'A,B together');
  assert.equal(comp.get('C'), comp.get('D'), 'C,D together');
  assert.notEqual(comp.get('A'), comp.get('C'), 'the two pairs are distinct groups');
  assert.notEqual(comp.get('X'), comp.get('A'), 'X (shares only 2 < 3) is not pulled into A,B');
});

test('coTravel: a low threshold merges the weak link (T=2 pulls X in)', () => {
  const comp = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 2);
  assert.equal(comp.get('X'), comp.get('A'), 'at T=2 the A-X link (=2) joins X to A');
});

test('coTravel: deterministic under input line reordering', () => {
  const c1 = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 3);
  const c2 = coTravelComponents(['X', 'D', 'C', 'B', 'A'], S, tie, 3);
  // component ids are assigned by first appearance in SORTED-by-tie order, so
  // the partition (grouping) is identical regardless of input order
  const part = (c: Map<string, number>) => {
    const g = new Map<number, string[]>();
    for (const [l, id] of c) (g.get(id) ?? g.set(id, []).get(id)!).push(l);
    return [...g.values()].map((ls) => ls.sort().join('')).sort();
  };
  assert.deepEqual(part(c1), part(c2));
});

test('coTravel: singletons when nothing clears the threshold', () => {
  const comp = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 6);
  assert.equal(new Set(comp.values()).size, 5, 'all isolated at T=6');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/tests/coTravel.test.ts`
Expected: FAIL — `coTravelComponents` not found.

- [ ] **Step 3: Implement the module**

```ts
// src/render/layout/coTravel.ts
// Co-travel grouping for the bundle-blocks seed order. Two lines co-travel to
// the extent they traverse the same corridors; keeping strong co-travelers
// contiguous at the seed stops a foreign line from wedging into a bundle that
// forks and reconverges downstream. Pure and deterministic: integer set
// intersections, union-find, total tie-breaks. No floating point.

import type { Layout } from './types';
import type { CorridorSet } from './bundleOrder';

/** Per line, the set of corridor ids its traversal rides. Built once. */
export function buildLineCorridorSets(
  layout: Layout,
  cs: CorridorSet,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [lineId, steps] of layout.lineTraversals) {
    const s = new Set<number>();
    for (const step of steps) {
      const c = cs.byEdge.get(step.edgeId);
      if (c) s.add(c.id);
    }
    out.set(lineId, s);
  }
  return out;
}

/** |corridors(a) ∩ corridors(b)|, the co-travel strength. */
export function sharedCorridorCount(sets: Map<string, Set<number>>): (a: string, b: string) => number {
  return (a: string, b: string): number => {
    const sa = sets.get(a);
    const sb = sets.get(b);
    if (!sa || !sb) return 0;
    const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    let n = 0;
    for (const c of small) if (large.has(c)) n++;
    return n;
  };
}

/** Partition `lines` into co-travel components: connected components of the
 *  graph whose edges are line pairs with strength >= threshold. Union by a
 *  total order (tie) so ids are a pure function of inputs, independent of the
 *  `lines` argument order. Returns line id -> small integer component id, ids
 *  assigned by first appearance in tie order. */
export function coTravelComponents(
  lines: string[],
  strength: (a: string, b: string) => number,
  tie: (l: string) => number,
  threshold: number,
): Map<string, number> {
  const ls = [...lines].sort((a, b) => tie(a) - tie(b) || (a < b ? -1 : a > b ? 1 : 0));
  const parent = new Map<string, string>();
  for (const l of ls) parent.set(l, l);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const p = parent.get(x)!; parent.set(x, r); x = p; }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // attach the tie-larger root under the tie-smaller, for a stable forest
    const [lo, hi] = tie(ra) < tie(rb) || (tie(ra) === tie(rb) && ra < rb) ? [ra, rb] : [rb, ra];
    parent.set(hi, lo);
  };
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 1; j < ls.length; j++) {
      if (strength(ls[i], ls[j]) >= threshold) union(ls[i], ls[j]);
    }
  }
  const idOf = new Map<string, number>();
  const out = new Map<string, number>();
  for (const l of ls) {
    const r = find(l);
    let id = idOf.get(r);
    if (id === undefined) { id = idOf.size; idOf.set(r, id); }
    out.set(l, id);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test src/render/layout/tests/coTravel.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/coTravel.ts src/render/layout/tests/coTravel.test.ts
git commit -F <tmpfile>   # message: "feat(layout): co-travel grouping module for seed ordering"
```

---

## Task 3: Constrain the seed to keep co-travel groups contiguous

Wire the module into `seedBlock`. The change is small: sort by the existing
exit key, then apply `reorderToGroups` with co-travel components as the groups,
ranked so each group appears at its earliest exit-key position (contiguity
without disturbing the geometric orientation the seed already computed).

**Files:**
- Modify: `src/render/layout/bundleOrder.ts` (imports; `orderByBlocks` body; `seedBlock`)
- Modify: `src/render/layout/tests/bundleOrder.test.ts` (add one integration test)

- [ ] **Step 1: Write the failing integration test**

Add to `bundleOrder.test.ts`. Fork-and-reconverge shape: trunk `t {P1,P2,X}`
is the widest corridor (seeded first). At `j`, P1 and X take corridor `u`,
P2 takes `v`; both reach `k`. At `k`, P1 and P2 reconverge onto the long tail
`w1→w2→w3` while X leaves on `xb`. P1 and P2 share four corridors (t,w1,w2,w3);
P1 and X share two (t,u). With threshold 3 the seed must keep P1,P2 contiguous.

```ts
test('blocks: seed keeps a fork-and-reconverge pair contiguous (anti-wedge)', () => {
  const layout = makeLayout(
    [
      ['r', 0, 0], ['j', 20, 0], ['ku', 35, -8], ['kv', 35, 8], ['k', 50, 0],
      ['w1n', 65, 0], ['w2n', 80, 0], ['w3n', 95, 0], ['xe', 60, -20],
    ],
    [
      { id: 't', from: 'r', to: 'j', lines: ['P1', 'P2', 'X'] },
      { id: 'u', from: 'j', to: 'ku', lines: ['P1', 'X'] },
      { id: 'u2', from: 'ku', to: 'k', lines: ['P1', 'X'] },
      { id: 'v', from: 'j', to: 'kv', lines: ['P2'] },
      { id: 'v2', from: 'kv', to: 'k', lines: ['P2'] },
      { id: 'w1', from: 'k', to: 'w1n', lines: ['P1', 'P2'] },
      { id: 'w2', from: 'w1n', to: 'w2n', lines: ['P1', 'P2'] },
      { id: 'w3', from: 'w2n', to: 'w3n', lines: ['P1', 'P2'] },
      { id: 'xb', from: 'k', to: 'xe', lines: ['X'] },
    ],
    {
      P1: [
        { edgeId: 't', reversed: false }, { edgeId: 'u', reversed: false }, { edgeId: 'u2', reversed: false },
        { edgeId: 'w1', reversed: false }, { edgeId: 'w2', reversed: false }, { edgeId: 'w3', reversed: false },
      ],
      P2: [
        { edgeId: 't', reversed: false }, { edgeId: 'v', reversed: false }, { edgeId: 'v2', reversed: false },
        { edgeId: 'w1', reversed: false }, { edgeId: 'w2', reversed: false }, { edgeId: 'w3', reversed: false },
      ],
      X: [
        { edgeId: 't', reversed: false }, { edgeId: 'u', reversed: false }, { edgeId: 'u2', reversed: false },
        { edgeId: 'xb', reversed: false },
      ],
    },
  );
  orderByBlocks(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  const pos = new Map(t.lineOrder.map((l, i) => [l, i]));
  assert.equal(Math.abs(pos.get('P1')! - pos.get('P2')!), 1,
    `co-traveling pair adjacent on the seed, X not wedged (got ${t.lineOrder})`);
  // membership + idempotence unchanged
  assert.deepEqual([...t.lineOrder].sort(), ['P1', 'P2', 'X']);
  const first = layout.edges.map((e) => [...e.lineOrder]);
  orderByBlocks(layout);
  assert.deepEqual(layout.edges.map((e) => [...e.lineOrder]), first, 'idempotent');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/layout/tests/bundleOrder.test.ts`
Expected: FAIL on the adjacency assertion — the current greedy seed sorts X
between P1 and P2 (P1 and X share the `u` branch, so the exit key interleaves
them). Record the observed `t.lineOrder` (expected `P1,X,P2` or its mirror).

- [ ] **Step 3: Add imports and build the corridor sets once**

In `bundleOrder.ts`, add to the existing import block from `./coTravel`:

```ts
import { buildLineCorridorSets, sharedCorridorCount, coTravelComponents } from './coTravel';
```

Inside `orderByBlocks`, right after `const flows = classifyFlows(layout, cs);`,
add:

```ts
  // co-travel grouping input: per-line corridor sets and their intersection
  // strength, built once and shared by every seed. The seed keeps lines that
  // ride many of the same corridors contiguous so a foreign line cannot wedge
  // into a bundle that forks and reconverges downstream.
  const lineCorr = buildLineCorridorSets(layout, cs);
  const strength = sharedCorridorCount(lineCorr);
  // grouping threshold: minimum shared-corridor count for two lines to be held
  // together at a seed. Tuning knob (behavior, not debug); see the ablation
  // ruler dev/_wedge_census.ts.
  const CO_TRAVEL_MIN = 3;
```

- [ ] **Step 4: Constrain `seedBlock`**

Replace the tail of `seedBlock` (from the `ls.sort(...)` line through the
`return`) with:

```ts
    ls.sort((a, b) => cmpKeys(keys.get(a)!, keys.get(b)!) || (a < b ? -1 : 1));
    // hold co-travel groups contiguous without disturbing the exit-key
    // orientation: rank each group by its earliest exit-key position, then
    // reorder-to-groups (stable within a group). The exit-key rank is a total
    // order over lines, reused as the group tie-break.
    const rankOfLine = new Map(ls.map((l, i) => [l, i]));
    const comp = coTravelComponents(ls, strength, (l) => rankOfLine.get(l)!, CO_TRAVEL_MIN);
    if (new Set(comp.values()).size < ls.length) {
      const groupRank: number[] = [];
      const seen = new Set<number>();
      for (const l of ls) { const g = comp.get(l)!; if (!seen.has(g)) { seen.add(g); groupRank.push(g); } }
      ls.splice(0, ls.length, ...reorderToGroups(ls, comp, groupRank).order);
    }
    return travelAB ? ls : ls.reverse(); // canonical storage frame
```

(`reorderToGroups` is already imported. `coTravelComponents`'s `tie` is the
exit-key rank, so groups keep their exit-key orientation; ties are total.)

- [ ] **Step 5: Run the integration test**

Run: `npx tsx --test src/render/layout/tests/bundleOrder.test.ts`
Expected: PASS — P1,P2 adjacent on `t`, membership and idempotence intact, and
every other block test in the file still green (frame invariance, join
lookahead, triangle cycle, write-back parity, round-trip).

- [ ] **Step 6: Full unit suite**

Run: `npm test`
Expected: all pass (the prior count was 575; this adds tests). If any block
test regresses, the seed constraint changed a settled order — stop and inspect
before proceeding; do not loosen the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/render/layout/bundleOrder.ts src/render/layout/tests/bundleOrder.test.ts
git commit -F <tmpfile>   # "feat(layout): keep co-travel bundles contiguous at the seed"
```

---

## Task 4: Corpus measurement and threshold tuning (HARD GATE)

The seed feeds every map, so the change is validated against the corpus, not
the synthetic fixture. This gate can VETO the change.

**Files:** none modified except possibly `CO_TRAVEL_MIN` in `bundleOrder.ts`.

- [ ] **Step 1: Re-run the wedge ruler**

Run (background): `npx tsx dev/_wedge_census.ts`
Compare `wedges` per city to the Task 1 baseline. Expected: NYC wedges drop
(the PATH pair and the 6th-Ave group no longer split); no city increases.

- [ ] **Step 2: Re-run the crossing counters**

For each dump, capture the `[blocks] planned-crossings=.. cycle-residuals=..`
summary (set `OCTI_DEBUG=1`; the line is emitted by `debugBlocks`). Compare
`planned + residual` per city to a pre-change capture (run once on the prior
commit if not already recorded).
**Gate:** `planned + residual` must NOT increase on any dump. If it does on some
city while NYC improves, raise `CO_TRAVEL_MIN` (fewer, tighter groups) and
repeat Steps 1-2. If no threshold both reduces NYC wedges and holds crossings
flat corpus-wide, STOP: the seed-only fix is insufficient — proceed to the
contingent residual work in Task 6 rather than shipping a crossing regression.

- [ ] **Step 3: Re-run the mega/zig census**

Run: `npx tsx dev/_ablate_census.ts`
Expected: no regression in `mega`/`zig` counts vs. the current committed
baseline (the ordering change must not manufacture new unseatable stations).

- [ ] **Step 4: Record the tuned threshold**

Note the final `CO_TRAVEL_MIN` and the before/after wedge + crossing numbers in
the Task 3 commit body (amend) or a follow-up commit message.

---

## Task 5: Bump the cache version and render checkpoint

**Files:**
- Modify: `src/render/mapCache.ts`

- [ ] **Step 1: Bump the cache version**

In `mapCache.ts`, increment the `VERSION` constant by one (cached layouts must
regenerate against the new seed order).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: Render NYC and SF for review**

Rasterize the smoothed NYC-jul-14 and SF-jul-14 dumps (SVG → PNG via the dev
harness), NYC with the NYC station design. Surface both at a decision
checkpoint: confirm the 9St/14St PATH pair (JSQ/HOB) is contiguous with no B
wedged between them, and that the capsule V-split is gone. Confirm SF shows no
new ordering artifacts.

- [ ] **Step 4: Commit**

```bash
git add src/render/mapCache.ts
git commit -F <tmpfile>   # "chore(render): regenerate cached layouts for co-travel seed"
```

---

## Task 6 (contingent): Residual reconciliation

Only if Task 4 Step 2 shows seeds still disagreeing on a wedge after the seed
fix (residual inversions persist that grouping did not remove). Do NOT
implement pre-emptively — it touches the historically fragile residual branch.

**Files:**
- Modify: `src/render/layout/bundleOrder.ts` (the back-edge branch in `processJunction`)

- [ ] **Step 1: Confirm the residual is real**

With `OCTI_BLOCKS_TRACE=<wedged line id>`, confirm a `BACKEDGE ... inv>0`
remains on the wedged corridor after Task 3, i.e. two seeds still fight.

- [ ] **Step 2: Design the tie-break against the ruler**

When two visited regions disagree at a back-edge, adopt the more-contiguous
seed (fewer co-travel-group splits) for the corridor whose block is not yet
frozen by a downstream commitment. Gate every candidate against the Task 1
ruler and the Task 4 crossing counter. If it does not strictly reduce wedges
without adding crossings, delete it — leading with the seed keeps us off the
falsified merge axis unless the data forces us onto it.

---

## Self-review notes

- **Spec coverage:** wedge metric (Task 1), co-travel group module (Task 2),
  seed integration (Task 3), the measured tradeoff / crossing gate (Task 4),
  cache bump + render checkpoint (Task 5), contingent residual (Task 6). All
  spec sections map to a task.
- **Determinism:** `coTravelComponents` sorts by a total `tie` order and unions
  by root order; `sharedCorridorCount` is integer set intersection. No
  `Date.now`/`Math.random`; no new floating point in the ordering path.
- **Type consistency:** `CorridorSet`, `Corridor`, `LineFlow`, `Layout`,
  `TraversalStep` are the exported shapes in `bundleOrder.ts`/`types.ts`;
  `reorderToGroups(order, groupOf, groupRank)` matches `blockAlgebra.ts`.
- **Blast radius / veto:** Task 4 is an explicit hard gate that can stop the
  change; the fix is not assumed correct, it is measured.
