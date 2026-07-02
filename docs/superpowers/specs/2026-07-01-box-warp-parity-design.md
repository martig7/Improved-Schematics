# Box-warp parity with detail areas — demand-driven expansion + canvas growth

**Date:** 2026-07-01
**Status:** Approved

## Problem

The detail-area popout (cropSubgraph + re-sim in DetailInset) resolves dense
clusters far better than the in-map box warp, for three reasons:

1. **Fresh pixel budget** — the crop spreads over its own full canvas (~6–10×
   linear). The box warp is zero-sum: `growthCap` defaults to 1.2 and the
   normalize + content-refit steps claw the raw expansion back into the
   original `width × height`, leaving ~2.5–3× net core magnification.
2. **Regenerated octi grid** — the popout recomputes
   `cellSize = max(12, medLen/divisor)` from the crop's own median edge
   length, so its grid matches the cluster's spacing. On the main map the
   global median sets one cellSize; a dense core's edges sit far below it and
   octi contracts them (< cellSize/2) into megaboxes regardless of how the
   warp shapes space — unless the warp stretches them past the threshold.
3. **Rescaled pixel constants** — dHat (≥16px), line width, markers, labels
   are fixed pixel sizes; the popout's magnification makes them relatively
   small, the warp's limited net gain does not.

Additionally, box discovery (`findDenseBoxes`) thresholds on
fraction-of-peak **density**, which misses small pinned clusters: the JFK
case (5 terminals 8px apart) is a huge contraction problem but a negligible
density bump, so it never gets a box.

## Goals

- Dense clusters on the main map survive octi uncontracted and read close to
  what the popout produces, **in place and fully seamless** (one continuous
  map, one octi solve, no stitching, no insets).
- Extra room comes from (a) growing the overall canvas and (b) warp
  expansion sized to what the layout actually needs. The sparse periphery is
  **never compressed** (consistent with the existing minScale=1 stance).
- Deterministic (bit-identical cross-V8), cache-consistent, octi cost
  unchanged.

## Non-goals

- Far-field compression to fund the cores (rejected).
- Locally variable octi grids or stitched local re-layouts (conflicts with
  seamlessness; rejected as approach C).
- Changing the popout/areas feature itself.

## Design

### 1. Box discovery: density oracle ∪ contraction oracle

Keep `findDenseBoxes` (density peaks; still honours the Box density cutoff
slider). Add a **contraction oracle** using data already computed in
renderGeographic (projected `nodePos`, graph adjacency, neighbour gaps):

- Estimate the octi threshold pre-warp:
  `ĉ = max(12, medianProjectedEdgeLen / divisor)` with the divisor picked by
  the same edge-count regime rule as the real layout. `ĉ` is an estimate (the
  real cellSize is computed post-warp from the support graph), so apply a
  safety factor (~1.3).
- Collect every graph edge whose projected length < `ĉ/2 · safety`.
- Union-find their endpoints into clusters (insertion-ordered iteration for
  determinism); each cluster with ≥2 nodes becomes an axis-aligned box.
- Union with the density boxes, then **iteratively merge intersecting
  boxes** so the summed per-axis pushes never double-stack on overlaps.

This catches JFK-type pinned clusters (strong contraction signal, invisible
to fraction-of-peak density) while density still catches Manhattan-scale
crowding.

### 2. Per-box demand expansion

Replace the single global `expand` with a per-box strength:

```
g_b       = median neighbour gap of nodes inside box b (from meanGap)
expand_b  = clamp(userMult · (ĉ/2 · slack) / g_b, 1, expandMax)
```

- `slack` ~1.2–1.5 so surviving edges aren't borderline.
- `expandMax` caps pathological demands (default ~10).
- `userMult` is the existing Box warp slider (default 1) — aesthetic
  headroom on top of survival. `OCTI_BOX_EXPAND` remains as a dev override.
- Density-only boxes whose edges already clear the threshold get
  `expand_b ≈ userMult` (survival demand ~1): the slider still magnifies
  them for looks, but nothing is expanded "just because".

Mechanically small: `buildBoxExpandWarp` already sums per-box pushes; the
strength multiplier moves inside the loop (`s_b · push(...)` per box).

### 3. Canvas growth instead of claw-back

Today the normalize step scales the warped bbox to `growthCap × canvas`
(1.2) and the content refit then squeezes everything back into
`width × height` — the granted expansion is confiscated. Instead:

- Measure the raw per-axis growth `(Gx, Gy)` the demanded expansions
  produce (warp of the canvas corners, as today).
- Cap at a `maxGrowth` knob (default ~2), **per axis** so the canvas stays
  filled (no letterbox).
- Make the grown dimensions the real output canvas: refit target, land-base
  rect, viewBox, export frame, and `pre.width`/`pre.height` all use
  `width·min(Gx,maxGrowth) × height·min(Gy,maxGrowth)`.
- Cores keep their absolute room; the periphery renders at ~1× (never
  shrunk). Only when demand exceeds `maxGrowth` does a global shrink apply —
  logged under `OCTI_WARP_DEBUG`.
- Octi cost unchanged: node count and cell count don't grow with canvas
  (cellSize scales with medLen). The fixed pixel constants (12px floor,
  dHat, line width, labels) become relatively smaller — the popout's third
  advantage, recovered.

### 4. Bounded refinement against the moving threshold

Expansion raises the global median edge length → the real post-warp
cellSize rises → the demand target moves. *(Amended during implementation:
the originally-specified proportional one-pass bump provably cannot
converge when an edge that straddles the box boundary is itself the global
median — the target then rises nearly as fast as the gap, and the bump
chases it asymptotically from below; verified numerically.)* The shipped
refinement is a bounded (≤4 passes, early-exit on no progress) secant
fixpoint solve per box: gap and need are ~affine in the box's expand while
the growth cap is slack, so a secant step through the last two states lands
where the box's inside-edge median clears the re-derived need with a 5%
margin; a proportional seed covers the first step and unreachable targets
(need rising at least as fast as gap, e.g. under a pinned growth cap) jump
to expandMax. Deterministic; converges in 1-2 rebuilds in practice.

### 5. Consistency

- **Determinism:** arithmetic stays `+ − × ÷ min max`; medians via fully
  tiebroken sorts; union-find iterates Maps in insertion order. Same
  cross-V8 discipline as the existing warps.
- **Cache:** new knobs (`maxGrowth`, demand params) and the discovery change
  enter the cache fingerprint; schema bump so stale layouts invalidate.
- **UI:** density-cutoff slider unchanged; the single Box warp slider
  (`boxWarpPos`) drives BOTH knobs — demand multiplier `userMult` (0.25..4,
  center 1) and `maxGrowth` (1..4, center 2). The
  warp-boxes debug overlay keeps working (`out.boxes` → `denseBoxesPx`);
  debug output gains per-box expand factors.
- **Downstream frames:** DetailInset clamps its frames to
  `pre.width/height`, which now reflect the grown canvas — no change needed
  beyond plumbing the grown dims consistently.

## Testing & verification

Unit (densityBoxWarp.test.ts + new discovery tests):

- A pinned sub-threshold cluster (JFK-shaped: few nodes, tiny gaps) gets a
  box from the contraction oracle even when density misses it.
- Demanded expansion lifts the cluster's edges past `ĉ/2 · slack`.
- Intersecting boxes merge; pushes never double-stack.
- Warped canvas bbox equals the capped growth dimensions.
- Determinism: identical inputs → identical warp outputs.
- `expand_b = 1` everywhere → identity (existing behaviour preserved).

Visual checkpoints (per workflow): `dev/render-from-dump` on the NYC dump —
JFK terminal cluster and Manhattan before/after, plus a periphery sanity
check (Newark/Queens termini stay connected). `OCTI_WARP_DEBUG` prints box
count, per-box expand, raw vs capped growth.

## Risks

- **maxGrowth cap vs extreme demand:** a worst-case cluster (8px gaps vs a
  ~35px threshold → ~5–8× demand) gets most of its room only if the user
  raises `maxGrowth`; at the default 2× the result is close to, but not
  exactly, popout parity. The knob makes this the user's call.
- **ĉ estimation error:** the pre-warp threshold estimate can drift from the
  real post-warp cellSize (topo merge happens in warped space). The safety
  factor + refinement iteration bound the miss; the debug line exposes it.
- **Box count noise:** the contraction oracle may surface many small boxes
  on noisy dumps (box counts are already known-noisy). Merging + the ≥2-node
  rule keep it bounded; if needed, a min-demand floor can drop boxes with
  demand ≈ 1.
