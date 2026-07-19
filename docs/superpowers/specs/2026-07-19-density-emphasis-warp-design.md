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

### Density = watershed basins + hub emphasis
Replace the single global-cutoff flood with per-peak basins:

- **Local maxima** of the smoothed density field are the crowded regions. Scan
  the grid for cells strictly greater than their 8 neighbours and above a floor
  (fraction of the global peak, so noise peaks are ignored).
- **Per-peak basin**: flood each maximum downward, claiming cells until they
  drop below `frac × THAT peak's height` (a LOCAL cutoff, so a secondary peak
  is not swallowed by the dominant one) or reach a cell a higher peak already
  claimed (a watershed boundary). Bound each basin → one emphasis box, carrying
  its normalized `d` as today.
- **Count control**: keep the top-K basins by peak height. K is the "how many
  areas to emphasize" knob (default small, ~4-6; tune by eye). This is what
  turns one blob into a few deliberate regions.
- **Hub emphasis (optional term)**: an isolated mega-hub (top line-count node)
  in a sparse area makes no density PEAK, yet is an important area. Optionally
  add the top-N nodes by line count as small dedicated emphasis boxes. Behind
  its own count knob; start N=0 and enable only if renders show important lone
  hubs going un-emphasized (avoid over-boxing).

Determinism: grid scan in fixed order, integer basin ids, sorted by height then
index; `Math.sqrt` only; no trig, no random.

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
  matches the flat regions on both sides, so no corner.
- Fold-safe: `smootherstep ∈ [0,1]` ⇒ `slope ∈ [0,1]` ⇒ `1 + s·slope > 0` for
  `s ≥ 0`, monotone per axis, same fold-free guarantee as today.
- The push is the integral of this slope (closed form, deterministic); replaces
  the current `a − (a−h)²/(2m)` quadratic segment.

This makes coastline smoothness independent of the margin width — the transition
is always a smooth bend, never a corner.

### Margin = capped, for distortion containment (now corner-free)
With C2 removing the corner, the margin width becomes a pure distortion-vs-bend
tradeoff with no kink risk. Cap it: `m = min(marginFrac · halfExtent, marginCap)`.

- Small boxes (capsule) keep their proportional margin.
- Large emphasis boxes are capped at an absolute `marginCap` (tune by eye), so
  the dense core's transition is a fixed-width band regardless of core size —
  distortion stays local, geography a few cells out is faithful, and the bend
  there is smooth (C2), never a corner.
- Floor `marginCap` only so the smooth bend stays gentle (not a tight-radius
  arc that reads corner-ish); the C2 profile means there is no hard floor
  needed to avoid an actual kink.

`marginCap` is the distortion knob; `marginFrac` the small-box smoothness; the
C2 profile is the always-on no-kink guarantee.

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
- `renderGeographic`: `K` (emphasis count), `N` (hub count), `marginCap` knobs,
  each with an `OCTI_BOX_*` env override; the panel Box-density-cutoff slider
  remaps to `K` (a count, not a fraction) or stays `frac` feeding the local
  basin cutoff — decide by eye during execution.
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
- `npm test` green (watershed unit tests: peak detection, basin separation of
  two peaks, K cap, determinism; margin-cap unit test: big box's band ≤
  marginCap, small box unchanged, still fold-free).
- Determinism preserved (cross-V8 discipline).

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
