# Density-emphasis warp + distortion containment — design

Two coupled changes to the (now aesthetic) box warp, from the reframe that the
warp gives crowded areas room to breathe and emphasizes important areas with
FEW meaningful boxes (see the "warp is aesthetic, not survival" principle):

1. **Rebuild the density oracle** to emit a few DELIBERATE emphasis boxes over
   the crowded cores and important hubs, instead of the single blob it produces
   today.
2. **Contain distortion** to a bounded band around each box, so areas the warp
   is NOT emphasizing stay geographically faithful — the thing the current warp
   struggles with.

## The problem, in the code

### The density oracle emits one blob
`findDenseBoxes` (`densityBoxWarp.ts`) thresholds the smoothed excess-density
field at `frac × GLOBAL peak`, then bounds each 4-connected above-cutoff
component. On a map with one dominant crowding peak (Manhattan), that peak's
basin swallows everything at any single global cutoff, so the oracle returns
~1 box regardless of the cutoff slider — confirmed: NYC gives 1 density box at
both frac 0.4 and 0.8. There is no mechanism to emit a HANDFUL of deliberate
regions, so "emphasis on important AREAS" (plural) is not expressible.

### Distortion bleeds far from the boxes
`buildWarpFromBoxes` ramps each box's expansion to zero over a margin
`m = marginFrac · halfExtent`, with `marginFrac = 3` (renderGeographic
`boxMargin` default). The expansion's local scale is `1 + s` inside the box and
eases to unit over `[h, h+m]`; beyond `h+m` the field is unit-scale (a rigid
translation). So the DISTORTED band around a box is `m = 3·halfExtent` wide —
its area is ~7× the box. Worse, it is PROPORTIONAL to box size, so a large
emphasis box (the whole dense core) bleeds its transition proportionally far
across otherwise-faithful geography. That proportional bleed is the "distortion
on non-warped area" the user sees.

## Design decisions (settled)

### Density = steepest-ascent watershed basins
Replace the single global-cutoff flood with a true watershed partition. NOT a
downward flood from each peak — the review found that leaks: a secondary peak's
lower local cutoff lets its flood climb over the saddle into the unclaimed
annulus around the dominant core and re-encircle it, rebuilding the exact map
box we are removing. Use steepest-ascent assignment instead:

- **Peaks**: cells that are a strict lexicographic (value, then cell index)
  maximum over their 8 neighbours AND above a floor (fraction of the GLOBAL
  peak, so noise peaks are ignored). The lexicographic strictness gives exactly
  one peak per flat plateau (equal-value FP ties from the clamped-border
  smoothing), deterministically.
- **Assignment**: every above-floor cell is assigned to the peak reached by
  repeatedly stepping to its strictly-largest neighbour (value, then index
  tie-break). This partitions the field at the true ridge lines — no basin can
  contain another peak. Below-floor cells are unassigned.
- **Local-cutoff filter**: within each basin, keep only cells `≥ frac × THAT
  basin's peak` (clamped `> 0`, since the field is mean-zero). This trims each
  basin to its own high ground without affecting the partition.
- **Basins → boxes**: bound each surviving basin. Drop basins below a minimum
  cell size (design value, not just a risk). Keep the top-K by (peak height,
  index). K is the "how many areas to emphasize" knob. Order is fixed:
  floor-filter peaks → assign → local-cutoff → drop-small → top-K → hand to
  `mergeDemandBoxes`. Post-merge count may be < K.
- **`d` normalization**: normalize each basin against its OWN peak,
  `d = (basinMeanExcess − basinCutoff)/(basinPeak − basinCutoff)`, so secondary
  cores get comparable emphasis (normalizing against the global peak would make
  every non-dominant region barely warp, defeating multi-region emphasis).
- **Hub emphasis: DEFERRED (N=0).** The review showed a line-count hub box as
  drafted carries no demand (aesthetic 1, survival 1 → no push) and a 1-node
  box is deleted by drop-tiny. The density watershed already emphasizes dense
  hubs; isolated-mega-hub emphasis is a separate, later term with its own kind /
  extent / `aes` definition. Not in this build.

Determinism: fixed grid-scan order, integer basin ids, total-order sorts (value
then index), `Math.sqrt` only, no trig, no random.

### Interaction with splitMixedBoxes (must be pinned)
`buildDemandBoxWarp` sends every merged box through `splitMixedBoxes` when
`anisoAmt>0` (the default), which tightens and can split a box into up to 8
sub-boxes AND density-decomposes via an INTERNAL `findDenseBoxes` call. So:
- `findDenseBoxes` is NOT renamed or removed — it stays as the decomposition
  primitive `splitMixedBoxes` calls. The watershed lands in a NEW
  `findEmphasisBoxes`; the density oracle at the top of `buildDemandBoxWarp`
  switches to it.
- Emphasis (density-kind) boxes SKIP `splitMixedBoxes` subdivision — they are
  already the deliberate regions, and re-splitting them into 20+ pieces defeats
  the "few meaningful boxes" goal. They still receive per-axis anisotropic
  STRENGTH (`axisStrengths`, a separate mechanism from box subdivision), so the
  aniso look is kept without multiplying boxes. Only non-density boxes (none
  today, since contraction is off and capsule boxes are small) would subdivide.

### HARD INVARIANT: no coastline kinks — the warp is C2-continuous
A kink is a CORNER: a discontinuity in the warp's curvature. The current push
is only C1 (continuous slope) — its slope ramps LINEARLY from 1 to 0 across the
margin, so the curvature jumps at the box edge (`a=h`) and the margin end
(`a=h+m`). A straight coastline crossing those points bends abruptly. That is
the kink, and a shorter margin makes it sharper.

Fix, as a hard invariant the warp must always satisfy: **ramp the slope with a
smootherstep instead of linearly**, so curvature is continuous everywhere and
corners are IMPOSSIBLE at any margin width.

- Slope profile over the margin `u = (a−h)/m ∈ [0,1]`:
  `slope(u) = 1 − smootherstep(u)` with `smootherstep(x) = 6x⁵−15x⁴+10x³`.
  Then `slope(0)=1`, `slope(1)=0`, and `slope'(0)=slope'(1)=0` — curvature
  matches the flat regions on both sides, so no corner (verified C2, in fact
  C3).
- Fold-safe: `smootherstep ∈ [0,1]` ⇒ `slope ∈ [0,1]` ⇒ `1 + s·slope > 0` for
  `s ≥ 0`, monotone per axis, same fold-free guarantee as today.
- Closed-form push (integral of slope), for `h < a ≤ h+m`, `u=(a−h)/m`:
  `p = h + m·(u − 2.5u⁴ + 3u⁵ − u⁶)` (Horner:
  `h + m·u·(1 + u³·(−2.5 + u·(3 − u)))`). At `u=1`, `p = h + m/2` — the SAME
  far-field gain as the current quadratic segment (verified: `∫₀¹ slope = ½`),
  so saturation `s·(h+m/2)`, the growth `corners()`/`rawGx`, the affine
  throttle, and the percentage-slider calibration are all preserved by the
  profile change alone. Evaluate with explicit multiplies / Horner — NO
  `Math.pow`/`**` (not correctly-rounded cross-V8, per repo discipline).

This removes the mathematical corner at any margin width. But C2 alone is NOT
sufficient for the visual no-kink gate — two more requirements:

- **Ring densification (required).** Geography is warped per vertex, so a
  straight coastline SEGMENT longer than the margin band maps to a straight
  chord with an angle at each endpoint — a real drawn corner no warp smoothness
  can prevent. Ring segments that cross a margin band must be subdivided to a
  step ≪ `marginCap` before warping. `subdivideRing` (geoSimplify.ts) already
  exists (used for the backdrop); this build must ensure its step is fine
  relative to the `marginCap` floor, per render mode.
- **marginCap floor (load-bearing for the visual gate).** The smootherstep
  CONCENTRATES curvature: `|slope'|` peaks at `1.875` at `u=½` (vs 1 for the
  linear ramp), so peak curvature is `1.875·s/m` — a small `marginCap` yields a
  tight-radius (still smooth) bend that reads as a kink at map scale. Floor
  `marginCap` so peak curvature `1.875·s/m` stays under a pinned bound (tie the
  floor to the displacement `s`, not a bare "tune by eye"). C2 removes the
  corner; the floor keeps the smooth bend gentle enough to pass the visual gate.

### Margin = capped, for distortion containment (now corner-free)
With C2 removing the corner, the margin width becomes a pure distortion-vs-bend
tradeoff with no kink risk. Cap it: `m = min(marginFrac · halfExtent, marginCap)`.

- Apply the cap in BOTH margin paths: the shared-margin path
  (`m = marginFrac·max(hx,hy)`, used when `anisoAmt=0`) and the per-axis path.
  Keep the existing 1px floor: `m = max(1, min(marginFrac·h, marginCap))`, then
  the curvature floor from the C2 section on top.
- `marginCap` units: absolute px in warp INPUT space (which in the default
  'both' mode is separable-warped space). To stay scale-stable across maps, tie
  the default to the cell estimate (`cell·k`) rather than a bare px constant.
- Small boxes (capsule) keep their proportional margin; large emphasis boxes
  get the cap, so the dense core's transition is a fixed-width smooth band.

**Growth/slider semantics shift (intended, must be stated).** Capping the
margin cuts a large box's far-field gain from `s·(h + marginFrac·h/2) ≈ s·2.5h`
toward `s·(h + marginCap/2) ≈ s·h` — up to ~60% less growth per unit strength.
The solved strengths are margin-insensitive (demand measures the slope-1
in-box region), so:
- **Percentage mode**: max saturation `rawG` shrinks, so at a given slider `t`
  the map grows less AND (since the throttle `λ=(t·rawG−1)/(rawG−1)` increases
  in `rawG`) magnifies its core less — except at `t=1`, where in-box scale is
  preserved and only the canvas shrinks. Every saved map re-renders smaller and
  less magnified at the same slider. This is intended: the growth budget stops
  paying for a wide transition band.
- **Legacy maxGrowth mode**: `rawG` falls toward the fixed cap → `λ→1` → dense
  maps get MORE in-box magnification at the same cap.
Both shifts go in the verification list (report before/after growth and in-core
scale at fixed slider). Also: capped margins shrink the stretched band, lowering
the post-warp global median and `needAfter`, so solved `expands` shift slightly
(deterministic, but no byte-identity with margin-sensitive expectations).

`marginCap` is the distortion knob; `marginFrac` the small-box smoothness; the
C2 profile + ring densification + curvature floor are the no-kink guarantee.

### What stays unchanged
- The **capsule oracle** (colliding-interchange emphasis) — the other half of
  the aesthetic warp.
- The **saturating push, per-axis anisotropy split, growth throttle / percentage
  slider, drop-tiny, contraction default-off** — all as shipped on the branch.
- The separable warp layer (identity at minScale 1).

## Architecture

All in `src/render/layout/densityBoxWarp.ts` + `renderGeographic.ts` + tests:

- `findDenseBoxes` → `findEmphasisBoxes` (watershed basins + optional hubs).
  Same return shape (`DenseBox & { d }[]`), so the merge/demand pipeline is
  untouched. Keep the old function behind a flag for A/B if useful.
- `buildWarpFromBoxes`: the `push` helper's margin segment becomes the
  smootherstep-slope integral (C2, no-kink invariant), and the width becomes
  `min(marginFrac·h, marginCap)` per axis (distortion cap).
- `renderGeographic`: `K` (emphasis count), `marginCap` knobs, each with an
  `OCTI_BOX_*` env override. **Panel slider shape (pinned now, not deferred):**
  the existing "Box density cutoff" slider KEEPS its `frac` meaning (feeds the
  per-basin local cutoff); `K` is a separate advanced knob (env for now). Do
  NOT overload one slider with two meanings — the option type lands in saved
  options and the fingerprint, so its shape can't be a by-eye execution
  decision. Hub count `N` is not wired (deferred).
- `cacheFingerprint` SCHEMA + `mapCache` VERSION already bumped on this branch;
  no additional bump within the branch.

## Distortion ruler (new, gates part 2)

Extend `dev/warp-preview.ts` (fast, ~1s, no-octi, already draws the warp mesh
and boxes) to also report a **faithfulness coverage** number: sample the warp
Jacobian on a uniform grid over the map and report the fraction of map area
whose local area-scale J is within ±ε of 1 (ε ~ 0.05) — i.e. how much of the
map the warp leaves geographically faithful. The margin-cap change should raise
this fraction materially with the same emphasis magnification. `warp-heatmap.ts`
gives the visual (warm=stretched, cool=squeezed, white=faithful) for spot
checks.

## Verification

Aesthetic + distortion, NOT draw censuses (draw robustness is the separate
backlog task; log any draw issue there, do not gate on it):

- **NO COASTLINE KINKS (hard gate)**: overlay the warped coastline where it
  crosses every box boundary and confirm a smooth bend, never a corner, on
  every corpus city at default AND maximum emphasis. The C2 profile must be
  verified visually AND by checking the warp's numeric curvature is bounded
  (no spike at box edges) in warp-preview. This gate blocks the whole change.
- **Renders** (the primary judge): a few deliberate emphasis regions over the
  crowded cores/hubs; geography faithful outside the bands. Before/after full
  maps per city at default and high emphasis.
- **Faithfulness coverage** up materially vs the current warp at equal emphasis
  (the warp-preview number), and the mesh visibly tighter around boxes.
- **Box count / growth** reported (few emphasis boxes + capsule; growth from the
  percentage slider unchanged in meaning).
- `npm test` green. Required new unit tests (from the review):
  (a) **far-field gain**: a far point's warped displacement equals `s·(h+m/2)`
      under the new C2 profile (locks the growth calibration);
  (b) **curvature continuity**: finite-difference second derivative is
      continuous across `a=h` and `a=h+m` (locks C2 numerically);
  (c) **basin wrap-around regression**: two peaks with a saddle between the two
      local cutoffs yield two disjoint basins, neither bbox containing the other
      peak (item 1);
  (d) **interlocking-bbox merge**: two disjoint basins with overlapping bboxes
      merge/clip as intended, not re-fused into a mega box (item 6);
  (e) **margin cap**: a big box's band ≤ marginCap, small box unchanged, still
      fold-safe.
- Determinism preserved (cross-V8: no `Math.pow`/`**`, total-order sorts).
- Saddle/coverage tradeoff MEASURED not discovered: add a saddle-region gap
  statistic and the faithfulness-coverage number to the warp-preview ruler.

## Risks

- **Watershed over-segmentation**: a noisy field splits into many tiny basins.
  Mitigate with the peak floor + K cap + a minimum basin size; the clip-apart
  merge de-overlaps whatever survives.
- **Margin cap too sharp**: NO LONGER a kink risk — the C2 profile guarantees a
  smooth bend at any width. The residual risk is only a tight-radius (but still
  smooth) bend if `marginCap` is very small; floor it and tune by eye. If even a
  smooth bow of the coastline is unwanted, that is a deeper limit (no local
  magnification can leave its surroundings perfectly rigid); the achievable
  guarantee is corner-free + contained, which is what "no kinks" requires.
- **Emphasis vs capsule overlap**: a hub emphasis box coincident with a capsule
  box is handled by the existing clip-apart merge (capsule outranks density);
  no double-stack.
- **The edge-streak artifacts** in current renders (vertical stretches in the
  far water) may be geography simplification / content-fit, NOT the warp margin;
  verify against the warp-preview mesh before attributing them to this work.
