# Box warp linear calibration — design

The demand box warp saturates: on nearly every map and at nearly every slider
position, granted growth lands exactly on the growth cap and the whole map
reflows. The demand system should instead grant what the map measurably
needs, scale aesthetics LINEARLY with the map's own density range, and reach
saturation only when the user pushes it there.

## The measured defect (corpus probe, full recompute, `dev/_warp_probe.ts`)

Growth vs cap, at the dump's live sliders ("default") and at the UI minimum
(`boxExpand 0.25, boxGrowth 1.25, boxFrac 0.8`, "user-min"):

| city | default growth (cap) | user-min growth (cap) |
|------|----------------------|-----------------------|
| NYC  | 3.30 (3.30) SAT      | 1.25 (1.25) SAT       |
| SF   | 5.00 (5.00) SAT      | 1.25 (1.25) SAT       |
| SEA  | 1.68/1.33 (2.18)     | 1.25 (1.25) SAT       |
| HOR  | 2.50 (2.50) SAT      | 1.25 (1.25) SAT       |
| DEN  | 1.01 (2.5)           | 1.01 (1.25)           |
| LON  | 1.52 (2.5)           | 1.25/1.20 (1.25) SAT  |

(The SF user-min cell was originally blocked by a fused-station-split crash;
fixed at the source before this spec was finalized — a split landing on a
terminal vertex produced a one-point edge path — so the cell above is
measured, and shows the same saturation signature: three boxes at the 10x
ceiling throttled onto the cap.)

Three composing causes, all confirmed in the probe output:

1. **Mega-box chaining.** `mergeDemandBoxes` unions cross-kind PARTIAL
   overlaps to their bbox, to a fixpoint. Dozens of small padded contraction
   boxlets plus one density box chain-react into a single map-core box: NYC
   368×520px holding 534 of ~840 nodes; SF 551×738 (n=511); HOR 384×590
   (n=488). `splitMixedBoxes` cannot undo it: it only splits
   direction-MIXED boxes, and a core of parallel trunks is direction-
   coherent. The push bands of a map-core box move everything.
2. **Secant ceiling jumps.** A mega box's inside-gap median IS
   approximately the global median, which rises with the warp, so its
   secant model stalls (denom ≤ 0) and the refinement jumps the box to
   `expandMax` (10×) by design. Even at user-min, NYC carries four boxes at
   10.00 and HOR five. `splitMixedBoxes`' own comment documents this
   mechanism; the split just never fires on coherent cores.
3. **Cap renormalization.** The growth throttle scales all strengths so raw
   growth lands exactly on the cap. Once inflated demand exceeds the cap —
   the routine case, per 1 and 2 — the granted warp IS the cap: the demand
   sliders stop mattering, every map grows by `boxGrowth`, and the far
   field translates apart. "Saturated in all situations."

A fourth, milder cause: `boxDemand` returns `userMult` even for a box with
NO deficit ("aesthetics only"), so at the default slider every box carries
a ≥1.7× multiplier regardless of whether its region is dense — aesthetic
warp is applied uniformly, not where density warrants it.

## Design decisions (settled)

- **Survival demand stays absolute and local.** `need/gap` (need =
  ĉ/2·slack, the octi cell unit) is the right absolute crowding measure;
  what breaks it today is the geometry it is measured over (mega boxes) and
  the escalation applied to it (ceiling jumps). Both go; the measure stays.
- **No box ever grows by merging.** Replace the cross-kind partial-overlap
  UNION with clip-apart resolution: full containment still nests (as
  today); same-kind pairs whose overlap is most of the smaller box (IoU of
  the smaller ≥ 0.5) union as genuinely-the-same-region; every other
  overlap CLIPS the lower-rank box out of the overlap along the axis of
  least loss, so boxes end disjoint. Total box area can only shrink
  relative to the oracles' output; a chain reaction is structurally
  impossible. Pairs whose endpoints a clip would separate migrate to the
  box that keeps both endpoints (the current orphan rule).
- **Bounded escalation.** The secant's `denom <= 0 → expandMax` jump is
  removed: a stalled box steps geometrically instead (`e ← min(1.5·e,
  expandMax)` per pass, 4 passes ⇒ ≤ ~5× from a stall, and only while its
  deficit persists). With mega boxes gone, the guaranteed-stall geometry no
  longer exists; small boxes converge in 1–2 passes as designed.
- **Aesthetics scale linearly with the map's own density range** (the
  user-visible "Box warp" slider, `userMult`). Per density box, the
  normalized density is
  `d̂ = (ē − cutoff) / (emax − cutoff)` clamped to [0,1] (ē = the box's
  mean smoothed excess density; emax = the map's peak; cutoff = frac·emax
  as today), and its aesthetic multiplier becomes `1 + (userMult − 1)·d̂` —
  linear between the cutoff and the peak. Contraction and capsule boxes
  carry NO aesthetic term: their demand is exactly their survival/pair
  need (userMult no longer multiplies survival — see slider semantics).
  A map with a shallow density range warps barely at all even at a high
  slider; the densest core of a genuinely dense map still reaches the full
  multiplier — saturation only when the user genuinely asks.
- **Slider semantics.** `boxExpand` (Box warp slider) = the aesthetic
  ceiling only, range unchanged. Survival and capsule-pair demand are
  granted at 1× at every slider position: the left end now means "only
  what the layout provably needs", not "survival × 0.25 with a floor at
  1". `boxGrowth` stays the hard per-axis budget with the exact throttle
  as the safety valve; the EXPECTED regime after this change is
  growth < cap, restoring meaning to both sliders.
- **Expected corpus behavior** (the calibration targets): DEN/LON-class
  maps stay ≈1.0 growth at any slider ≤ default; NYC/SF/HOR come in under
  their caps at defaults with visibly localized boxes; user-min lands
  ≈1.0–1.1 everywhere (survival only); slider-max may still saturate on
  dense maps — that is the user genuinely asking for it.

## What does NOT change

- The push construction (`buildWarpFromBoxes`): saturating per-axis bands,
  fold-free by monotone sums, growth absorbed by the canvas, exact affine
  throttle. All proven; untouched.
- The oracles themselves: density grid (fraction-of-peak component
  discovery), contraction union-find, capsule pair scan, corridor oracle
  (still env-gated). Only how their boxes MERGE and how demand is priced
  changes.
- The separable warp layer (identity at minScale 1) and its sliders.
- Direction intelligence (anisotropy split/reallocation) — it operates on
  whatever boxes exist; smaller boxes make its job easier.

## Architecture

All changes inside `src/render/layout/densityBoxWarp.ts` plus its tests:

- `mergeDemandBoxes` → clip-apart semantics (unit-tested: chain fixtures
  that today produce one mega box must yield disjoint clipped boxes; nest
  and same-region-union fixtures unchanged).
- `buildDemandBoxWarp`: density-box `d̂` computed from the (already built)
  density grid at discovery time and carried on the box
  (`DemandBox.aes?: number`); `boxDemand` prices survival at 1× plus the
  aesthetic term for density boxes; secant stall step bounded.
- `findDenseBoxes` returns each component's mean excess alongside its
  bbox (an extra output field; existing callers ignore it).
- The `dev/_warp_probe.ts` table (scratch, gitignored) is the calibration
  ruler, run before/after.

## Caching and determinism

- The warp is layout-stage: `cacheFingerprint` SCHEMA bumps (layout output
  changes for identical inputs), `mapCache` VERSION bumps. Live maps
  re-render once on update.
- No new math beyond + − × ÷ min max (d̂ is a ratio of existing quantities);
  fixed iteration order; deterministic as before.

## Verification gates

Behaviour-changing at the layout root: censuses plus probe plus visual
scrutiny, NOT byte identity.

- `npm test` green (new merge/demand unit tests included).
- Probe table hits the calibration targets above; growth is monotone in
  the Box warp slider on every corpus city (spot-check 5 positions).
- Full census battery on the corpus (`RECOMPUTE=1 dev/_fanzone_census.ts`):
  contiguity 0 and twists 0 stay HARD; loops/zigs 0; clips, spikes,
  stairs, tapers, and the seat-ink occluded count at or near current
  pinned values — the layout reflows, so small spike/taper deltas are
  reviewed rather than auto-rejected, but no census may materially
  regress.
- `dev/robustness-check.ts` re-baked (`robustness-bake.ts` reruns — the
  bakes are layouts) and its 8 columns reviewed on the same terms.
- Before/after full-map renders per city at default AND user-min sliders,
  surfaced for review: user-min must look near-geographic; defaults must
  keep hub readability (the warp's whole point) without the global
  stretch.

## Risks

- **Under-warping dense cores.** Survival demand no longer inflated by
  mega boxes or aesthetic floors could leave crowded hubs tighter than
  today's (accidentally spacious) output. The capsule/contraction oracles
  still price genuine needs; the aesthetic slider still adds room where
  density is high. Judged on the before/after renders; if hubs crowd, the
  first lever is the aesthetic curve's cutoff anchor, not a return to
  uniform multipliers.
- **Downstream churn.** Every layout consumer reflows (marker seats, fan
  geometry, censuses). Mitigated by the census battery and by landing this
  as one reviewed unit on a branch.
- **Clip-apart correctness.** Clipping must keep boxes valid (non-empty,
  pads intact enough to push). Degenerate slivers (clip consumes a box)
  drop the box; its pairs migrate as orphans. Unit-tested.
