# Capsule Mutual Slide — Design

**Date:** 2026-06-15
**Status:** User-approved direction. Branch `unlimit-line-distortion`.
**Supersedes:** nothing — extends the post-solve collision-slide passes in `renderOctilinear.ts` (rigid-row spec 2026-06-12 §R1, the "post-solve collision-slide passes").

## 1. Problem

After the rigid-row solver places each station's marker independently, a post-solve pass resolves marker overlaps. The **small-vs-small** pass (`renderOctilinear.ts`, the block after the mega-vs-small one) measures penetration between two capsules' **spine hulls** (consecutive chain-pair stadium segments at half-width `r + 3`, `r = LINE_WIDTH·0.7`) and, for an overlapping pair, slides **only the fewer-marks capsule** along its own lanes away from the other's centre — 4px steps, **32px cap**, committing the first offset that clears and stays octilinear.

When that single capsule's 32px is not enough to clear the pair, the loop exhausts and **gives up: the overlap persists**. Two tightly-placed capsules then render visibly overlapping.

## 2. Change: escalate to a mutual slide

Per overlapping small-vs-small pair (A, B), in order:

1. **One-sided (unchanged).** Slide the fewer-marks capsule away, ≤32px. Clears → commit, done. Byte-identical to today for every pair this already fixes.
2. **Escalate → move both.** If step 1 exhausts its cap still overlapping, both capsules slide along **their own** lanes, each away from the other's *fixed original* centre (existing `lanePointAt(lineId, flagNode, awayCentre, d)`). Build each side's reachable offsets `dA ∈ {0,4,…,capA}` and `dB ∈ {0,4,…,capB}`, stopping a side early at its **last valid** lane point when `lanePointAt` returns null (a wedged capsule has few steps; the freer one keeps its full range — effective separation can reach `capA + capB`). A **2-D joint search** over `(dA, dB)` (≤ 8×8 = 64 cells) picks the cleared cell (`penBetween ≤ −1`) with **least total slide** `dA + dB` — so if moving one capsule alone suffices it won't needlessly spread the other; otherwise the slide is split.
3. **Best-effort.** If no cell clears, commit the cell with **least residual penetration** (tie-break least total slide) rather than reverting. Better than today's all-or-nothing give-up.

`capA = capB = 32` (the existing small-vs-small cap), reused — "fit our slide rules" means the existing rules applied to both capsules, not a new limit.

## 3. Invariants (applied to BOTH moved capsules)

Reuse the existing helpers, currently applied to the single slid station, for each capsule that moves:

- `captureCorners` / `applyCorners` — derived corners recomputed on the slid dots along the old leg axes (spec R1; octilinear by construction).
- `spineOctilinear` — a move that bends the spine off-octilinear boxes that capsule (`mega = true`, `slideBoxed++`), as today.
- `trimLaneAt` for incident ≤ 1 (terminating) lines, so ink ends at the slid marker.
- Trial positions must clear every mega box (existing `clearOf` check).

## 4. Ripple handling

Moving B (previously held fixed) can re-touch an already-cleared neighbour. Wrap the whole pairwise sweep in a **bounded relaxation loop**: repeat the sweep up to `MAX_SWEEPS = 3` times, stopping early when a sweep moves nothing. Moves only ever separate capsules, so the loop converges; the 32px cap + octilinear guard bound total spread. This realizes "move both until they don't overlap anymore."

## 5. Testable core (the one structural improvement)

Extract the joint-slide *decision* into a pure, dependency-free helper so it can be unit-tested (today it is unreachable, buried in render closures):

```
type Hull = Array<{ a: Pixel; b: Pixel; half: number }>;

chooseMutualSlide(
  hullsA: Hull[],   // hullsA[ka] = A's spine hull when A is slid to offset index ka (ka=0 = rest)
  hullsB: Hull[],   // hullsB[kb] = B's spine hull at offset index kb
): { ka: number; kb: number }   // chosen indices (best-effort if no cell clears)
```

It evaluates `penBetween(hullsA[ka], hullsB[kb])` over the `ka × kb` grid and returns the cleared cell with least `ka + kb`, or — if none clears — the cell with least residual penetration (tie-break least `ka + kb`). The render code builds `hullsA/hullsB` from `lanePointAt` offsets (baking in the last-valid stop) and applies the chosen offsets through the existing commit path (corners, trim, octi-check, mega-clear). Pure hull geometry in, indices out — no `layout`/`segPath` coupling, so `penBetween`/`segSegDist` move into the helper module alongside it.

## 6. Verification

- **Unit (`renderOctilinear` is hard to unit-test; the helper is not):** new tests on `chooseMutualSlide` — (a) clears when a mutual move exists that one-sided cannot reach; (b) best-effort returns max-separation when no candidate clears; (c) respects caps (never indexes past the provided candidates); (d) determinism.
- **Render gates (both saves):** markerfit overlap count should **drop** (the target metric), octilinearity stays 0, seating/overdraw unchanged or better, mega/slide-boxed counts reported (expect no regression).
- **Visual checkpoint:** rasterized crop of a previously-overlapping pair, before (`OCTI_MUTUAL_SLIDE=0`) vs after.

## 7. Shipping

Default-on: the escalation only changes pairs the current resolver *leaves overlapping*, so all currently-green output is unaffected. `OCTI_MUTUAL_SLIDE=0` disables the escalation (reverts to one-sided give-up) for A/B comparison, matching the pipeline's env-knob convention.
