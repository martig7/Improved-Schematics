# Bidirectional-corridor seed interleave (6th-Ave split by 8th-Ave) — design

**Date:** 2026-07-14
**Area:** bundle-blocks line ordering seed (`src/render/layout/bundleOrder.ts`)
**Status:** diagnosis complete, design open (needs a metric before implementation)

## Problem

On the W 4 St ↔ 9 St corridor, the 6th-Ave bundle is interleaved with the
8th-Ave lines instead of staying contiguous. Drawn order:

```
c199  Broadway-Lafayette → W 4 St  [F D M B]        ← 6th Ave, clean
c14   Park Pl → W 4 St             [A C E]          ← 8th Ave, clean
c194  W 4 St → 9 St                [D F A C E M B]   ← BUG: A C E wedged into the middle
c150  9 St → 14 St                 [D F M B ...]     ← 6th Ave diverges here
c146  9 St → 14 St                 [E C ... A]       ← 8th Ave diverges here
```

The correct order is `[D F M B][A C E]` (two contiguous blocks), which is
consistent at *both* ends of `c194`. The interleave forces a crossing at both
the W 4 St and the 9 St junctions.

This is a *different* wedge from the twist-rescue one fixed on 2026-07-14: it is
in the ordering itself, present with twist rescue fully off.

## Root cause (proven from the seed keys)

`c194` carries **bidirectional through-traffic**:
- M, B, C, E travel W 4 St → 9 St and **exit at 9 St** (M/B → c150, C/E → c146).
- D, F, A originate at 9 St and travel the **opposite** way, exiting at W 4 St.

`seedBlock` picks one exit end for the whole corridor (the majority's, 9 St) and
computes every line's exit key by walking downstream from there. For the
opposite-direction lines (D, F, A) that walk is ill-posed — their flow at 9 St
points back *into* c194 itself (a turnaround). The dumped keys:

```
M, B  → first exit corridor c150   key starts  0.000
C, E  → first exit corridor c146   key starts -0.785
D, F, A → first "exit" c194 (self) key starts -3.142   ← turnaround, sorts first
```

So D, F, A sort ahead of everything, splitting the 6th-Ave group into
`[F D · A C E · M B]`.

## The metric gap (must be closed first)

The existing wedge census (a line whose two lateral neighbours exit the SAME
next corridor while it exits a different one) does **not** count this: the
boundary lines A and M have neighbours that exit *differently*. A fix needs a
new ruler that measures it — e.g. **bundle contiguity**: for each edge, count
co-travel bundles whose lines are not a single contiguous run. Build and baseline
this metric before changing the seed.

## Candidate approaches

1. **Derive the corridor instead of root-seeding it.** `c194`'s feeders already
   carry the clean blocks — `c199 = [F D M B]` and `c14 = [A C E]`. If `c194`
   were built by joining them at W 4 St (joins nest intact), it would be
   `[F D M B][A C E]`. Investigate why `c194` is chosen as a root rather than
   derived (root selection / BFS order / `hasPendingFeeder` on a bidirectional
   corridor). Most aligned with the block algebra's design; lowest conceptual
   risk if the root-selection change is contained.

2. **Two-ended seed key.** Compute each line's exit key from ITS OWN exit end,
   reconciled into one lateral frame — e.g. rank the first exit by its
   destination's perpendicular offset relative to the corridor axis, which gives
   a consistent left/right regardless of which end the line leaves by. Fixes the
   frame mismatch at the source, but must preserve the seed's frame-invariance
   guarantees.

3. **Co-travel-aware seed grouping.** Keep lines that share many corridors
   contiguous in the seed regardless of key. (Explored earlier and abandoned
   because a junction's exit-grouping overrides the seed; would need to hold the
   grouping through junctions too, so likely subsumed by option 1.)

Recommendation: start with option 1 (understand the root-vs-derive choice for
bidirectional corridors) since it reuses the existing intact-join machinery;
fall back to option 2 if root selection cannot cleanly force derivation.

## Risks

- The seed feeds every map: high blast radius. Gate every candidate on the new
  bundle-contiguity metric, the existing wedge + twist censuses, the ordering
  crossing counts (`planned + residual` must not increase), the mega/zig census,
  and the full test suite. Revert any candidate that regresses.
- Determinism must hold (no `Date.now`/`Math.random`; quantized angles;
  `Math.sqrt` not `hypot`; total tie-breaks).

## Out of scope

- The twist-rescue bundle wedge (already fixed, `2026-07-14-prevent-bundle-wedging-design.md`).
- Any capsule/marker-solver change; the V-split is a downstream symptom.
