# Bundle-Blocks Line Ordering — Rebuild Design

**Date:** 2026-07-04
**Status:** Draft for user review.
**Branch:** `experiment/bundle-blocks` (off `experiment/bundle-straight-lock` @ `be50fd9`).
**Replaces (behind a knob, pending A/B):** `src/render/layout/untangle.ts` — the LOOM-ported scorer/optimizer and all its accreted machinery (partner blocks, Y-stack rewrites + seam scoring, corner factors + straight-lock, orientation passes, hill climb / exhaustive / Held-Karp search).

## 1. Why rebuild

The LOOM model optimizes free per-line permutations under penalties, and every aesthetic rule we actually want has had to be bolted on as a weight, a lock, a rewrite pass, or a write-back repair — each with its own blind spots (seam braids invisible to the scorer; partner expansion leaking member-vs-foreign flips; locks freezing the hill climb when widened). The 2026-07-04 experiments measured the ceiling of that approach: NYC still carries 13 straight-node braids that no pricing regime removes, and the module is 1300+ lines tuned to specific maps.

The target aesthetic (the MTA map) has a simpler grammar: **lines travel in rigid bundles; a bundle's internal order never changes on open track; order changes exist only where bundles join, split, or turn a real corner.** The rebuild makes that grammar the *data model* instead of an emergent property of penalties. User rules:

1. Optimize to keep bundles together — structurally, not via color penalties. Family adjacency (express/local pairs) must EMERGE from "they joined together" rather than being priced.
2. Crossings/overlaps confined to bundle joins/splits and ≥90° turns (turns are the last resort).

## 2. The model — recursive blocks

A corridor carries a **block**: an ordered sequence whose items are lines or nested blocks. Three operations, nothing else:

- **join(A, B) → [A, B] | [B, A]** — two corridors merge; the merged block nests both operands intact. One binary choice (the *side*). A join with k>2 simultaneous feeders stacks them in **angular order** at the junction (deterministic, no choice).
- **split(block, exitSets) → slices** — a corridor divides. If each exit's line-set is a contiguous slice of the block, the split is free. Otherwise, the minimum adjacent-transposition sequence that makes the exits contiguous is computed directly (bubble distance between the current order and the nearest exit-contiguous order) and those crossings are **planned at the split node** — an allowed location by rule 2.
- **mirror(block)** — a whole block flips end-over-end across a node (orientation bookkeeping, free; identical to today's rev handling).

There is deliberately **no representation** for an in-bundle swap on open track: the model cannot express the defect class we spent the straight-lock experiment suppressing.

### 2.1 The pair-ownership theorem (what makes B tractable)

For any two lines p, q that ever share a corridor: their relative order is **decided exactly once** — at the join where their bundles last merged (their "merge-LCA") — and **consumed exactly once** — at the split where they separate (or at a cycle closure, §2.3). Every corridor in between preserves it by block rigidity.

Consequence: join-side choices are **independent per join**. The side chosen at join J affects only pairs (a ∈ A, b ∈ B), and the only place those pairs' order matters is their separation split (or a cycle edge). So the "optimization" in approach B is: for each join, walk each side-choice forward to the A×B separation point, count forced crossings there, pick the cheaper side; ties break by junction geometry (the angular rule). No global search, no weights, no hill climbing. Lookahead depth is structurally 1 (one separation event per pair-class); deeper lookahead has nothing to look at.

### 2.2 Junction taxonomy

Per node, classify each line's corridor→corridor transition from `lineTraversals` (the same flow derivation as today's `connOccurs`), then decompose the node into:

- **Pure join** — ≥2 corridors in, 1 out (for the flows involved).
- **Pure split** — 1 in, ≥2 out. Exit slice assignment to branches follows junction geometry (clockwise sweep), which is what makes contiguous splits crossing-free in the drawn fan.
- **Join+split (transfer node)** — process **split-first, then join**: peel the exiting slices off each through-corridor, then attach entering blocks on their geometric sides. The peel and attach each follow the pure rules.
- **Terminal attach/detach** — a line starting/ending mid-map is a 1-line block joining/leaving; same rules, k=1.
- **Coincident-but-independent** — corridors sharing a node with no exchanged lines don't interact.

### 2.3 Cycles

Blocks propagate over a **spanning forest** of the corridor graph (BFS from the widest corridor per component; deterministic tie-breaks). Each non-tree corridor closes a cycle: the block arrives at it from both ends independently, and the two arrivals may disagree. The disagreement's inversion count is **forced** — no ordering regime can remove it — and gets **placed** by the relief-valve rule:

1. a junction on that corridor (crossings at joins/splits are allowed), else
2. the sharpest ≥90° bend on the corridor (rule 2's last resort), else
3. the least-bad spot on a featureless corridor — now *provably unavoidable* and tagged as such in diagnostics, rather than mysteriously chosen by a scorer.

Same placement rule applies if a non-contiguous split's crossings would collide with the split fan: they may retreat one node upstream to a better relief valve.

### 2.4 Where line order originally comes from

Nothing is seeded by color, barycenter, or destination heuristics. Lines are born solo at their terminals; every order on the map is the composition of join decisions plus forced-crossing plans. A terminal yard where k lines begin on one corridor with no upstream structure is ordered by its first downstream split (the lookahead rule, applied k-way: order the flat block so that split is contiguous), tie-break angular.

## 3. Pipeline

New module `src/render/layout/bundleOrder.ts` (+ `bundleOrder.test.ts`), consuming the same `Layout` and writing the same `edge.lineOrder` — a drop-in alternative to `untangleLineOrder`:

1. **Corridor contraction** — maximal runs of layout edges through deg-2 nodes with identical line sets (today's OptGraph contraction, minus Y-rewrites; Y-joins are native).
2. **Flow classification** — per junction, per line: in-corridor → out-corridor transitions from `lineTraversals`; decompose per §2.2.
3. **Forest orientation** — BFS from the root corridor; classify tree/back corridors; deterministic order everywhere (sorted ids; no `Math.hypot`; quantized `atan2` for angular sweeps, same primitives as the rest of the pipeline).
4. **Block propagation** — process junctions in BFS order applying §2.2 ops; join sides by §2.1 lookahead (geometry tie-break); accumulate planned crossings from non-contiguous splits.
5. **Cycle reconciliation** — diff back-corridor arrivals; place residuals per §2.3.
6. **Write-back** — flatten each corridor's block to `edge.lineOrder` per layout edge (mirror per part orientation — the one piece of today's write-back that survives); realize planned crossings as order changes across their chosen node. No partner expansion, no stack composition, no orientation repair passes — flattening is the whole job because the block already IS the order.

**Diagnostics carried over:** the composed-order flip counter (`OCTI_DEBUG` / `OCTI_FLIP_DETAIL=1`) and `OCTI_TRACE`/`OCTI_TRACE1` work on `edge.lineOrder` and stay as-is — they are the A/B measuring stick. New counter: planned crossings by location class (`join/split/corner/forced-straight`) — the invariant "no crossing outside allowed locations except tagged residuals" must hold **by construction**, and the counter proves it per render.

## 4. Rollout, A/B, and deprecation

- **Knob:** `OCTI_ORDER=blocks|loom` (default `blocks` on this branch; `loom` = call the existing `untangleLineOrder`). The game runtime takes the default; offline A/B uses the env.
- **Gates (NYC-Jul-4, NYC-EXTRA-DIFFICULT, LON-3, SEA-2):** full suite green; contig 0 new gaps; capsule/mega gates unchanged or better; flip counter — `blocks` must beat `loom`'s 13 on NYC-Jul-4 with all remaining flips tagged as cycle residuals; visual crops of the war-story spots (36 St, Franklin Av, Eastern Pkwy, Jay St-Metrotech, 103 St, Washington Hts-168 St); perf — block propagation is linear-ish and must beat the hill climb's wall time (expect a large win; measure).
- **Deprecation policy (user rule, 2026-07-04):** deprecated code moves to a repo-root **`old/`** folder — it must not linger in the live tree confusing investigation. If/when `blocks` wins sign-off: in the SAME commit that removes the knob (or flips it permanently), move `src/render/layout/untangle.ts`, `untangle.test.ts`, and any untangle-only helpers to `old/src/render/layout/…` with an `old/README.md` naming the replacement and the sign-off date. Imports must break loudly; nothing in the live tree may import from `old/`. `lineOrder.ts` (the pre-LOOM barycenter pass untangle already superseded) moves to `old/` in the same sweep if nothing else consumes it.
- Schema bump on any default flip (placement consumes lineOrder).

## 5. Testing

Unit (`bundleOrder.test.ts`), all fixtures tiny and deterministic:
- join/mirror algebra: two corridors merge, internal orders survive, side choice honored; k-way angular stacking.
- contiguous split: zero planned crossings; slices match branch geometry.
- non-contiguous split: minimal transposition count, planned AT the split node.
- lookahead: a join whose geometric side would make the next split non-contiguous chooses the other side (discriminating fixture: geometry says [A,B], separation demands [B,A]).
- family emergence: express/local pairs sharing a full edge-set ride adjacent with NO color logic present (the colorFrag test scenario reproduced without colors).
- cycle: a triangle of corridors with incompatible orders yields exactly the forced inversion count, placed at the corner, not the straight run.
- transfer node: split-then-join produces both peels and attaches correctly.
- write-back parity: mirrored parts, idempotence, line-membership preservation (port the existing untangle write-back tests' assertions).
- the straight-lock migration test (pinned corridor) reformulated: the crossing lands at the bend by placement rule, not by pricing.

Integration: the §4 gates; determinism double-run (`fp` unchanged between two renders).

## 6. Out of scope

- Deleting untangle in this pass (it stays callable via `OCTI_ORDER=loom` until the user signs off the A/B; deletion = the `old/` move per §4).
- Junction-interior crossing DRAWING (where a planned crossing at a join/split visually lands within the fan — current draw behavior applies; the gap-proportional taper from `7339b7c` already localizes it).
- Out-and-back self-pairs (a line's two passes through one corridor): treated per traversal-run, self-pairs skipped — same as today. Watch-item, not a blocker.
- Any change to placement/rendering downstream of `edge.lineOrder`.

## 7. Open questions (to resolve during implementation, not blockers)

- Root-corridor orientation is arbitrary per component (two global mirrorings score identically); pick lowest-id-first for determinism.
- Exact bubble-distance realization when a non-contiguous split has multiple minimal transposition sequences: pick the lexicographically-least sequence (determinism), placement identical.
- Whether the k-way terminal-yard lookahead (§2.4) needs the angular tie-break often enough to matter — measure on SEA (ferry terminals).
