# Escalation-Ladder Rewrite + Far-Attach Capsules — Design

**Date:** 2026-07-04
**Status:** Approved (chat, 2026-07-04).
**Base branch:** `cursor/c4b3d42d` (per-station platform nodes + per-bundle platform-split fallback).
**Relates to:** rigid-row markers (2026-06-12 v2), capsule demand oracle (2026-07-02), hub-split capsule (2026-06-14, unimplemented sibling).

## 1. Problem

Two problems, solved together:

1. **Far-apart station groups.** With per-station platform nodes (`cursor/c4b3d42d`), one station group can legitimately stop on several corridors far apart (Fulton St's four platforms, Times Sq's de-welded trunks). `solveRows` cannot pair bundles across the gap, so the group falls to the per-bundle platform-split: one detached capsule per platform. The complex no longer reads as one station.
2. **Escalation sprawl.** `computeRibbonGeometry`'s marker placement has accreted 4 escalation stages and up to ~9 `solveRows` calls per failing station: base solve (±24) → wide re-solve (±48) → box-rescue slack walk (up to 6 re-solves at lowered `minGap`) → hull-masked overlap retry (re-runs all three). Adding a fifth stage for far-apart groups would make it worse.

## 2. The rewritten ladder

Two solve stages, then residuals. At most 3 `solveRows` calls per station (1 for the common case).

1. **PRIMARY** — one call. Wide window (±`WIDE_ARC` 48, fine 0.5 grid), with two former stages folded in:
   - **Hull masks baked in from the start** (was: overlap retry). `blocked` vetoes a dot whose ring would sit inside an already-placed capsule hull; `proximity` charges a comfort ramp outside that. Hulls prefiltered to the station's vicinity.
   - **Soft sub-floor gap band** (was: box-rescue slack walk). Dot gaps in `[minGap − softBand, minGap)` are feasible but charged `softW`·deficit (`softW` = 5000/px dominates every other cost scale, so any fully-clear chain outbids any overlapping one, and among overlapping chains the least-deficit wins — the walk's minimum-slack semantics without the re-solves). `softBand` = 1.5 default, `OCTI_BOX_RESCUE` env (name kept). Station-level *non-adjacent* floors reject at the hard floor without a penalty term (documented approximation; non-adjacent sub-`minGap` gaps in the band are accepted unranked).
2. **FAR-ATTACH** — only when PRIMARY fails, ≥2 bundles, and the max cross-bundle anchor spread exceeds `WIDE_ARC`. This is the align-attach rescue: each bundle's row may slide along its own corridor (bounded at half the incident corridor per side, never off the lane), on a coarse grid (`FAR_STEP` 4px), with the parallel end-to-end join's lateral tolerance relaxed (`latTol` = max(0.75, 0.75·`FAR_STEP`)) and `extCap` raised to the bundle spread so long bridges are payable. The chain DP picks the globally best attach over all bundles (collinear bridges and corner elbows). A winning coarse chain is **polished**: lane curves re-anchored at the coarse dots, one local re-solve (±2·`FAR_STEP`, 0.5 grid, strict `latTol`) drives parallel joins to sub-pixel collinearity — guaranteed to bracket, since lateral offset moves ≤1px per px of slide. Output is a normal `chain`/`cornerAfter` solution: **one continuous capsule** spanning the group; `stops.ts` renders it unchanged.
3. **VERIFY** — the existing seat-time hull-overlap/self-cross check, minus the masked retry (masks are already in the solve). Reject → next.
4. **PLATFORM SPLIT** (existing on base branch) — per-bundle units re-queued through the ladder, with two additions:
   - **Best-effort seating (least-bad option).** A re-queued split unit is a single bundle, so its only failure modes are: overlap vetoes (every seat blocked by placed dots/hulls, or the verify stage rejects the seated hull) and structural degeneracy (coincident interlined lanes below the hard floor; no-crossing windows). For the overlap class, a split unit that fails gets one best-effort re-solve: the hull veto moves entirely into a heavy proximity penalty (least-penetration seat wins), the true-stacking veto stays hard, and the verify stage records instead of rejecting. The downstream de-overlap passes (marker collision backup, mutual capsule slide) then pull the marker clear where room exists. Mega remains only for the structural class.
   - **Taxicab connectors.** The split units of one station group are joined by thin axis-aligned (H/V "taxicab") transfer connectors — NYC free-transfer-bar style — so the complex still reads as one station even when it cannot be one capsule. MST over the units' final marker centroids; each MST edge connects the nearest dot pair with a straight or single-elbow L path whose corner is chosen to graze other markers least (deterministic tie-break). Drawn under the capsules in the capsule border color, ~0.9·line-width, computed AFTER all marker-adjust passes so endpoints track final positions. Pure geometry lives in a new `splitConnect.ts` module (unit-testable).
5. **MEGA BOX** — final residual (structural failures only, for split units).

## 3. Solver changes (`rowPlace.ts`)

Three additive `RowOpts` options; defaults reproduce current semantics except where noted:

- `slideRange?: Array<[number, number]>` — per-bundle asymmetric slide bounds, overriding ±`arcLimit`.
- `latTol?: number` — parallel-join lateral tolerance (default 0.75, the current hard-coded value).
- `softBand?: number` / `softW?: number` — soft sub-floor gap band (default 0 = today's hard floor). Applied at: state pinch, pairEval cross-row floor, pairEval corner clearance (deficits priced into state/pair cost); `stationFloorsOk` rejects at the hard floor.

## 4. Behavior drift (accepted)

- Stations that today seat at the ±24 base window may now seat differently: the primary solve searches ±48 from the start, and hull/soft-band terms shift costs. `slideW` still prefers near-rest seats, so drift is small; integration gates quantify it.
- The box-rescue walk's exact lexicographic slack minimization is approximated by the finite `softW` weight (deficits < ~0.05px are effectively free — consistent with `minGapSlack`'s intent).
- Cache schema bump (placement output changes).

## 5. Knobs & determinism

`OCTI_FAR_SLIDE=0` disables the far tier; `OCTI_FAR_STEP` (4), `OCTI_FAR_CAP` (400px lane-curve window cap); `OCTI_BOX_RESCUE` = soft band width (0 = hard floor); `OCTI_WIDE_MULT` unchanged (primary window). Deleted knob behavior: the walk. All new arithmetic uses the existing cross-V8 primitives (`sqrt`-based `hyp`, quantized `atan2`); grids and bounds are deterministic. `OCTI_PLACE_DEBUG=1` prints `[far-attach]` outcomes.

## 6. Verification

- Unit (extend `rowPlace.test.ts`): `slideRange` reaches far seats; `latTol` admits coarse-grid parallel joins across a 200px gap (strict tolerance forces a misaligned elbow, relaxed aligns within the band); soft band seats an in-band pinch with the penalty priced, still boxes below the hard floor, and never takes a sub-floor seat when a clear one exists.
- Integration: full test suite + typecheck; offline renders of both live dumps (`induced-demand`, `tod`) with `OCTI_PLACE_DEBUG=1` — compare mega-box count, `[capsovl]` audit (must stay 0 violations), platform-split count (should drop where far-attach lands), contiguity check clean; before/after PNGs as the visual checkpoint.

## 7. Out of scope

- Partial attachment of a bundle subset when the full chain fails (falls to platform split + taxicab connectors, which now covers the visual-grouping need; a future far-attach over subsets remains possible).
- Penalizing station-level non-adjacent band deficits (see §2.1 approximation).
- The hub-split pass (2026-06-14) — unrelated mechanism, untouched.
