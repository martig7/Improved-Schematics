# Box Warp Linear Calibration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The demand box warp grants what the map measurably needs instead of
saturating its growth cap: no box ever grows by merging (clip-apart), no
ceiling jumps (bounded escalation), survival demand at 1× at every slider
position, and aesthetic magnification linear in the map's own density range.
Spec: `docs/superpowers/specs/2026-07-18-box-warp-linear-calibration-design.md`.

**Architecture:** All changes inside `src/render/layout/densityBoxWarp.ts`
plus its tests. The push construction, oracles, separable layer, and
anisotropy machinery are untouched. Layout output changes ⇒ one
`cacheFingerprint` SCHEMA + `mapCache` VERSION bump in the FIRST
behavior-changing commit (the branch merges only after full verification).

**Tech stack:** TypeScript, Node built-in test runner, probe harness
`dev/_warp_probe.ts` (gitignored) as the calibration ruler, corpus census
runner `dev/_fanzone_census.ts` (gitignored), `dev/robustness-bake.ts` +
`dev/robustness-check.ts`.

**Calibration targets (from the spec — the definition of done):**
- user-min (`boxExpand 0.25, boxGrowth 1.25, boxFrac 0.8`): growth ≈ 1.0–1.1
  on every corpus city (survival only).
- defaults: DEN/LON ≈ 1.0; NYC/SF/HOR strictly below their caps, boxes
  visibly local (no map-core mega box in `[boxprobe] merged:`).
- growth monotone (non-decreasing) in the Box warp slider across
  p ∈ {−1, −0.5, 0, 0.5, 1} per city.
- slider-max may still saturate dense maps (that is the user asking).

---

### Task 1: clip-apart merge + schema/version bumps

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts` (`mergeDemandBoxes`)
- Modify: `src/render/cacheFingerprint.ts` (SCHEMA +1), `src/render/mapCache.ts` (VERSION 31 → 32)
- Test: `src/render/layout/tests/densityBoxWarp.test.ts`

- [ ] **Step 1: Write the failing tests**

New `mergeDemandBoxes` semantics to cover:

1. **No chain reactions**: a row of 6 small contraction boxes each partially
   overlapping the next, plus one large density box overlapping the first —
   result contains NO box larger than the input density box, and total box
   area ≤ input total (boxes only shrink).
2. **Containment still nests** (cross-kind): a capsule box inside a density
   box → both survive unchanged (today's behavior).
3. **Same-region union**: two same-kind boxes where the overlap covers ≥ 0.5
   of the smaller box's area → single union box (pairs concatenated).
4. **Partial overlap clips the lower rank**: a capsule box partially
   overlapping a density box → capsule keeps its full extent, density box
   loses the overlap along its axis of least area loss; result disjoint.
5. **Equal rank, light overlap**: the smaller box is clipped (tie: the later
   index); result disjoint.
6. **Sliver drop + pair migration**: a clip that would consume the clipped
   box (its remainder thinner than 1px on the clipped axis) drops it; its
   `pairs` migrate to the clipping box.
7. **Determinism**: shuffled input order yields the same result set (sort
   the outputs for comparison).

- [ ] **Step 2: Run tests, verify the new ones fail**

`npx tsx --test src/render/layout/tests/densityBoxWarp.test.ts`

- [ ] **Step 3: Implement clip-apart `mergeDemandBoxes`**

```ts
/** Overlap resolution WITHOUT union growth (spec 2026-07-18): containment
 *  nests (cross-kind), heavy same-kind overlap (>= 0.5 of the smaller box)
 *  unions as genuinely-the-same-region, and every other overlap CLIPS the
 *  lower-rank box out of the overlap along its axis of least loss, so boxes
 *  end disjoint. Total box area never grows, so the chain reactions that
 *  built map-core mega boxes are structurally impossible. A clip that
 *  consumes a box drops it and migrates its pairs to the clipping box.
 *  Deterministic fixpoint scan. */
export function mergeDemandBoxes(boxes: DemandBox[]): DemandBox[] {
  const out = boxes.map((b) => ({ ...b, pairs: [...b.pairs] }));
  const rank: Record<BoxKind, number> = { density: 0, contraction: 1, capsule: 2, corridor: 3 };
  const area = (b: DemandBox): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 0 || oy <= 0) continue; // disjoint (touching edges are fine)
        const aInB = a.x0 >= b.x0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.y0 >= b.y0 - 1e-6 && a.y1 <= b.y1 + 1e-6;
        const bInA = b.x0 >= a.x0 - 1e-6 && b.x1 <= a.x1 + 1e-6 && b.y0 >= a.y0 - 1e-6 && b.y1 <= a.y1 + 1e-6;
        if (a.kind !== b.kind && (aInB || bInA)) continue; // nest
        const smaller = area(a) <= area(b) ? a : b;
        if (a.kind === b.kind && (aInB || bInA || ox * oy >= 0.5 * area(smaller))) {
          // same region: union (the one sanctioned growth — bounded, since
          // the union of a >=50%-overlapping pair is < 3x the larger box)
          out[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
            kind: a.kind, pairs: [...a.pairs, ...b.pairs],
          };
          out.splice(j, 1);
          changed = true;
          break outer;
        }
        // clip the loser out of the overlap: lower kind rank loses; equal
        // rank -> smaller area loses; tie -> the later index (j) loses
        const loserIsA =
          rank[a.kind] !== rank[b.kind] ? rank[a.kind] < rank[b.kind]
          : area(a) !== area(b) ? area(a) < area(b)
          : false;
        const loser = loserIsA ? a : b;
        const winner = loserIsA ? b : a;
        // candidate clips: slide one loser edge to the winner's boundary;
        // pick the axis/side losing the least area
        type Clip = { x0: number; y0: number; x1: number; y1: number };
        const cands: Clip[] = [];
        if (loser.x0 < winner.x0) cands.push({ ...loser, x1: winner.x0 });
        if (loser.x1 > winner.x1) cands.push({ ...loser, x0: winner.x1 });
        if (loser.y0 < winner.y0) cands.push({ ...loser, y1: winner.y0 });
        if (loser.y1 > winner.y1) cands.push({ ...loser, y0: winner.y1 });
        let best: Clip | null = null;
        let bestA = -1;
        for (const c of cands) {
          const ca = Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0);
          if (ca > bestA) { bestA = ca; best = c; }
        }
        const MIN_EXTENT = 1; // px: a thinner remainder is a sliver, not a box
        if (!best || best.x1 - best.x0 < MIN_EXTENT || best.y1 - best.y0 < MIN_EXTENT) {
          // clip consumes the loser: drop it, migrate its pairs
          winner.pairs.push(...loser.pairs);
          out.splice(out.indexOf(loser), 1);
        } else {
          loser.x0 = best.x0; loser.y0 = best.y0; loser.x1 = best.x1; loser.y1 = best.y1;
        }
        changed = true;
        break outer;
      }
  }
  return out;
}
```

Notes for the implementer:
- The loser is fully contained same-kind → handled by the union arm (aInB/
  bInA same-kind), so the clip arm always has a non-contained loser and at
  least one candidate clip.
- `DemandBox.aes` (added in Task 3) carries through: union takes
  `Math.max(a.aes ?? 0, b.aes ?? 0)` when either is a density box; clips
  keep the loser's own value. Write the merge now with pairs only; Task 3
  threads `aes`.
- Termination: every iteration removes a box or strictly shrinks one (area
  is a strictly decreasing multiset except bounded same-kind unions, which
  strictly reduce the box COUNT) — the fixpoint terminates.

- [ ] **Step 4: SCHEMA/VERSION bumps**

`cacheFingerprint.ts` SCHEMA +1 (read the current value); `mapCache.ts`
VERSION 31 → 32. Both in THIS commit (first behavior change on the branch).

- [ ] **Step 5: Tests green, commit**

`npm test` (686 + new). Commit:
`feat(warp): clip-apart demand-box merge — no box ever grows (schema/version bump)`

### Task 2: bounded escalation

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts` (secant refinement)
- Test: `src/render/layout/tests/densityBoxWarp.test.ts`

- [ ] **Step 1: Replace the ceiling jump**

In the refinement's `eNext` computation:

```ts
// A stalled local model (need rising as fast as the gap) is no longer a
// license to jump to the ceiling: step geometrically and re-measure. With
// clip-apart boxes the region-spanning stall geometry no longer exists;
// a residual stall converges in a few bounded steps or stops mattering
// when the growth throttle binds.
if (denom <= 1e-9) return Math.min(expandMax, e * 1.5);
```

The proportional seed (`de <= 1e-9` branch) and the cleared/secant branches
stay as they are.

- [ ] **Step 2: Regression guard test**

Unit test on `buildDemandBoxWarp` with a compact 2-box graph engineered so
the first-pass demand under-clears (gap just below need): assert every
returned expand ≤ 1.5^4 × its first-pass value (no ceiling teleport), and
that a graph whose gaps all clear `need` yields growth 1,1 at userMult 1.

- [ ] **Step 3: Tests green, commit**

`feat(warp): bounded secant escalation — no expandMax jumps`

### Task 3: survival at 1×, aesthetics linear in the density range

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts` (`findDenseBoxes`,
  `boxDemand`, `buildDemandBoxWarp`, `DemandBox`)
- Test: `src/render/layout/tests/densityBoxWarp.test.ts`

- [ ] **Step 1: `findDenseBoxes` computes the normalized density**

Per component, accumulate the mean smoothed excess over its member cells
and return `DenseBox & { d: number }` with
`d = clamp((meanExcess − cutoff) / (emax − cutoff), 0, 1)` (0 when
`emax <= cutoff`, i.e. a flat map). Existing callers ignore the field.

- [ ] **Step 2: thread `aes` and reprice demand**

- `DemandBox` gains `aes?: number`; `buildDemandBoxWarp` sets it from the
  density oracle's `d` (density boxes only); the merge carries it (union:
  max; clip: keep) per Task 1's note.
- `boxDemand` drops `userMult` from survival:
  `survival = Math.max(1, need / gMed)` (empty boxes: 1), and the caller
  composes `expand = Math.min(expandMax, Math.max(survival, 1 + (userMult − 1) * (b.aes ?? 0)))`.
- Capsule pair seeds drop `userMult`:
  `seed = Math.max(seed, Math.min(expandMax, Math.max(1, t.required / d)))`.
- Behavior note (intended, from the spec): at `userMult <= 1` the aesthetic
  term is ≤ 1 and the whole left half of the Box warp slider equals the
  center — survival only. The slider's document comment in
  `SchematicPanel.tsx` (boxExpandFromPos block) is updated to say so; no
  UI control changes.

- [ ] **Step 3: Unit tests**

- A dense-box demand scales linearly: with survival cleared, `d = 0` →
  expand 1 at any userMult; `d = 1` → expand = userMult; `d = 0.5`,
  userMult 4 → 2.5.
- Survival ignores userMult: a contraction box with `need/gMed = 2` gets
  expand 2 at userMult 0.25, 1, and 4 alike.
- Flat map: all `d = 0` (emax ≈ cutoff fixture) → growth 1,1 at any slider.

- [ ] **Step 4: Tests green, commit**

`feat(warp): survival at 1x, aesthetic demand linear in the density range`

### Task 4: corpus calibration + census battery

- [ ] **Step 1: Extend `dev/_warp_probe.ts`** (scratch) with a slider sweep:
  `p ∈ {−1, −0.5, 0, 0.5, 1}` → `boxExpand = max(0.25, 4^p)`,
  `boxGrowth = max(1, 2.5·2^p)` at default frac, PLUS the existing
  default/user-min rows. Run on the 6-city corpus (background).

- [ ] **Step 2: Verify the calibration targets** (top of this plan). If a
  target misses, tune ONE thing at a time against the probe (candidates,
  in order: the same-region union threshold 0.5, the stall step 1.5, the
  d̂ anchor `cutoff`), re-run, and revert falsified tunings. No target may
  be met by reintroducing a uniform multiplier or an unbounded step.

- [ ] **Step 3: Census battery** (background):
  `RECOMPUTE=1 npx tsx dev/_fanzone_census.ts` — contiguity 0 and twists 0
  HARD (run `dev/_twist_census.ts` if the fanzone runner lacks it);
  loops/zigs 0; clips/spikes/stairs/tapers/seat-ink reviewed vs pinned
  (NYC 50/SF 37/SEA 13/HOR 32/DEN 5/LON 7 spikes, SF 1 stairs, HOR 2
  tapers, 1 same-color NYC clip, occluded marks 11): the layout reflows,
  so review deltas case-by-case; nothing may materially regress.

- [ ] **Step 4: Robustness re-bake**: `dev/robustness-bake.ts` on the NYC
  dump → `dev/robustness-check.ts dev/_robustness`; review the 8 columns
  on the same terms (contig 0 hard).

- [ ] **Step 5: Visual scrutiny**: full-map renders per city at default AND
  user-min sliders, before (master) and after (branch); crops of NYC
  Manhattan core, SF Market St, HOR core. Surface to the user: user-min
  must look near-geographic; defaults must keep hub readability.

- [ ] **Step 6: Record + report**

Update the auto-memory (probe table before/after, tuning decisions, new
census baselines) and report with the tables and renders for sign-off.
Merge to master only after that sign-off.
