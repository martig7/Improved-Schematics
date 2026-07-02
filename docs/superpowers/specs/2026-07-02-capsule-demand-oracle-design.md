# Capsule-demand oracle + nested warp boxes + overlap enforcement

**Date:** 2026-07-02
**Status:** Approved (scope chosen: capsule oracle + nesting + guard/retry; multi-cutoff density layers deferred)
**Builds on:** `2026-07-01-box-warp-parity-design.md` (demand-driven box warp) and the
`capsule-noovl` experiment branch (commits b646511, d26d4d3).

## Problem

Large station capsules overlap each other (SEA Naches Av: mn89 7-member ×
mn340 6-member × satellites) and occasionally self-cross (mn98). Root cause,
established by the pass-by-pass audit:

1. **Space scarcity is decided upstream.** A capsule needs `marks × lane
   pitch` of spine; placement can only slide dots ±24–48px along lanes. The
   demand warp's contraction oracle buys room against the OCTI threshold
   (~13px) — but interchange clusters need capsule-scale separation
   (~40–80px), so the warp under-asks exactly where capsules are biggest.
2. **The fixup passes CREATE overlap.** Mutual-slide and the dot-based
   no-overlap floor verify dot distances and octilinearity when committing
   moves, but are hull-blind to third parties: SEA goes from 4 seat-time
   crossings to 6 final (whack-a-mole), including the user-visible X.
3. Placement's masks are dot-level, so a row can seat straight through a
   neighbour's spine, and nothing checks a chain's own non-adjacent legs.

Experiment results (env-gated, both maps audited to cross=0 self=0):

| variant | SEA boxes (63 caps) | NYC-difficult boxes (191 caps) |
|---|---|---|
| baseline | 1 | 3 |
| hard reject + guard | 6 | 31 |
| + hull-masked retry | 3 | 20 |

## Goals

- Buy capsule-scale room **upstream** (in the demand warp) so interchange
  clusters rarely violate at placement; **enforce** zero capsule overlap
  downstream (guard + retry + reject) so violations are impossible, not just
  unlikely. Expected effect: the enforcement's megabox cost drops well below
  the +17 (NYC) measured without the oracle.
- Nested ("boxes within boxes") warp support, required for capsule boxes
  inside density/contraction boxes and reusable for future multi-cutoff
  density layers.
- Deterministic, cache-consistent, no new UI (rides userMult/maxGrowth).

## Non-goals

- Multi-cutoff density layers (deferred; nesting support enables them later).
- In-DP hull feasibility inside rowPlace (dot-mask retry is the accepted
  approximation; still-crossing retries box).
- Changing capsule visual design.

## Design

### 1. Capsule-demand oracle (third box source, densityBoxWarp.ts)

- Per graph node, `capsuleNeed = max(0, stopLineEstimate(n) - 1) × spacing / 2
  + margin` in pixels — the half-length of the marker row it will need.
  `stopLineEstimate` = lines through the node (the warp-weight line count,
  already computed in renderGeographic — an upper bound on stop marks;
  slack-friendly). Single-line nodes get need ≈ margin (their dot is small).
- **Pair scan over spatially near stations** (bucket grid, not graph
  adjacency — capsule collisions don't require a shared edge): flag pairs
  with `dist(A,B) < needA + needB + casing`. Union-find flagged pairs into
  clusters; bbox + pad → capsule boxes. Only nodes with ≥2 estimated marks
  participate (singles are handled fine by existing dot masks).
- Per-box demand: `expand_b = clamp(userMult · max(1, (needA+needB+casing) /
  dist) over the worst member pair, 1, expandMax)` — the expansion that lifts
  the tightest pair to its capsule separation.

### 2. Per-box need functions + generalized refinement

Boxes now carry a `kind` (density | contraction | capsule) and a **need
evaluator**: given advected node positions, return (achieved, required) for
the box — contraction: inside-edge median vs ĉ/2·slack; capsule: min member
pairwise spacing vs combined need; density: aesthetic only (no requirement).
The bounded secant refinement (≤4 passes, early-exit) solves each box against
ITS OWN target instead of the single contraction target. Same fold-free push,
same growth/cap plumbing.

### 3. Nesting-aware merge

`mergeIntersectingBoxes` becomes layer/kind-aware:
- Same-kind overlapping boxes merge to union (as today).
- A box fully CONTAINED in a different-kind box nests: both survive, pushes
  sum (sums of monotone per-axis pushes stay fold-free; the inner push adds a
  rigid translation to the outer far field — no ring, no fold).
- Partial cross-kind overlap merges to union with the max of the two needs
  (conservative; avoids double-stacked partial pushes, the original reason
  for merging).

### 4. Enforcement productionization (renderOctilinear.ts, from capsule-noovl)

Flip the experiment to defaults-on, env-gated OFF:
- **Move guard** (applySlide/rigidShift hull veto): always on.
  `OCTI_CAPSULE_GUARD=0` disables (diagnostic).
- **Seat-time check**: self-cross → reject to mega; cross → hull-masked
  retry (blocked = dot-ring-inside-hull veto, proximity = comfort ramp,
  400px hull prefilter), still-crossing → mega. Always on;
  `OCTI_CAPSULE_NOOVL=0` disables both (legacy behavior).
- `[capsovl]`/`[capsaudit]` logging stays behind OCTI_PLACE_DEBUG.
- The temporary comma-list env parsing from the experiment is replaced by
  the two boolean gates above.

### 5. Consistency

- **Determinism:** bucket grid iterated in fixed order, fully tiebroken
  sorts, `+ − × ÷ √ min max` only — as the existing oracles.
- **Cache:** layout changes (warp boxes + placement) → SCHEMA 7 → 8.
  No new fingerprint fields (capsule oracle derives from existing inputs).
- **UI:** none. Capsule boxes ride the Box warp slider (userMult) and
  maxGrowth like all boxes. Env for sweeps: OCTI_CAPS_MARGIN,
  OCTI_CAPS_CASING (defaults in code).
- **Perf:** pair scan O(n) with bucket grid (~600 stations); guard/retry
  costs measured negligible in the experiment (only violating stations
  re-solve).

## Testing & verification

- Unit (densityBoxWarp): capsule oracle flags a close 7×6-line pair and not
  a well-spaced one; nesting — contained cross-kind boxes both survive and
  compound monotonically (fold-free grid scan); partial cross-kind overlap
  unions with max need; refinement clears per-kind targets on a mixed input.
- Unit (placement): existing behavior with gates off; with defaults on, a
  synthetic crossing pair retries to a clear seat.
- Dumps: SEA + NYC-difficult with OCTI_PLACE_DEBUG — expect fewer seat-time
  violations than the no-oracle experiment (NYC 32 → target <15), final
  audit cross=0 self=0, megabox count comfortably under the +17 no-oracle
  cost; JFK/box-warp visuals unregressed (the new oracle must not fight the
  contraction oracle — nesting handles co-location); contiguity check green.
- Visual checkpoint to the user: Naches Av + one NYC hub, before/after.

## Risks

- **Over-expansion in interchange-dense cores** (many capsule boxes nesting
  in Manhattan-scale density boxes): compounding pushes could demand large
  growth; maxGrowth caps it globally, and capsule needs are tens of px —
  bounded. Watch the growth debug line on NYC.
- **Estimate error** (lines-through ≥ actual stop marks): over-asks room;
  absorbed by slack/cap. Under-ask impossible by construction.
- **Orientation unknown pre-layout:** isotropic need over-reserves for
  capsules that seat perpendicular to the pair axis. Accepted (slack).
