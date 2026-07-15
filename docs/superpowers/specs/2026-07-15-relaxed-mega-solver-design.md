# Relaxed mega-station solver — design

**Date:** 2026-07-15
**Area:** marker seating (`src/render/layout/rowPlace.ts`, `src/render/renderOctilinear.ts`, `src/render/stations/placement.ts`)
**Status:** design, revised after code-surface mapping

## Goal

Replace the mega-station fallback (an unseatable station drawn as a `box` or a
`curve` capsule over degenerate dot positions) with a **relaxed, non-octilinear
solver that allows overlap** and can never fail. Make it the sole seating path
for over-dense stations and **delete `box`, `curve`, the `megaFallback` option,
and the `mega` flag entirely**.

## Scope finding (why this is two parts)

Code mapping showed "boxed station" has **two independent sources**, not one:

1. **Placement infeasibility** (`solveRows` returns `null`): the common source,
   the mega blobs. The relaxed solver eliminates this cleanly.
2. **Inter-station overlap** (`boxStation`, later passes): (a) a mega-slide
   eviction pass (`renderOctilinear` ~2417) that only runs against
   already-placed mega boxes, so it goes **vestigial** once source 1 is gone;
   (b) a no-overlap-floor last resort (~3185) that boxes a *small* station whose
   bullets collide with a neighbor after the corridor-**spread** pass could not
   separate them octilinearly without hitting a third station. Source 2(b) is an
   inter-station problem the relaxed (intra-station) solver does not address.

The `mega` flag is also read by the London/Toronto designs (they skip boxed
marks). Deleting `box` outright therefore requires reworking source 2(b) so no
station ever boxes. That rework is a distinct subsystem from the relaxed solver,
so the work splits into two sequenced, independently-shippable parts:

- **Part 1 (this spec, fully planned): the relaxed solver.** Add the relaxed
  mode, wire it on the placement path so placement never megas, and delete the
  `curve` variant, the Curve/Box UI toggle, and the `megaFallback` option. The
  opaque `box` and the `mega` flag are **kept internally** as the last-resort
  rendering for source 2(b) only (no longer a user-facing choice). Shippable:
  the placement-mega blobs are gone.
- **Part 2 (separate design pass): eliminate residual boxing.** Rework the
  `boxStation` passes so the 2(b) collision resolves without a box (delete the
  dead mega-slide pass; replace the last-resort box with a best-effort
  separation), then delete `box`, the `mega` flag, and its readers entirely.
  The 2(b) replacement strategy needs its own short design and is NOT specified
  here.

## Current state

- `solveRows` (`rowPlace.ts`) seats a station's dots as intersections of a
  straight **octilinear** row line (`AXES` = the four octilinear unit vectors;
  `buildStates` snaps each bundle's natural perpendicular to an `AXES` index)
  with each line's lane curve, under a hard no-overlap floor
  (`hardFloor = minGap − softBand`).
- `renderOctilinear` runs an **escalation ladder** (wide-arc → far-attach
  corridor tier → fine polish); if every stage returns `null`, the station is a
  **mega**: all its dots are flagged `mega` and it renders as `box`/`curve`.
- The mega `null` is triggered by (1) coincident/interlined lanes (degenerate
  row × lane intersection) or (2) a pinch below `minGap` — NOT primarily
  octilinear infeasibility. So the soft-gap relaxation alone removes most megas;
  the free angle is added flexibility.
- `box`/`curve` are **draw-time only** (`placement.ts` `isMega` branch): `curve`
  = a pill along the degenerate dots' spine (per-line dots kept), `box` = an
  opaque cover (no dots). Default `curve`.

## Design

### A relaxed mode in `solveRows`

Add an opt (e.g. `relaxed: true`) that changes three things and nothing else:

1. **Free-angle rows.** `buildStates` uses each bundle's *actual* perpendicular
   (unsnapped) plus a small symmetric fan of nearby angles, instead of snapping
   to `AXES`. Rows become non-octilinear at the bundle's natural orientation.
   The fan is a bounded, quantized set (deterministic), sized so the relaxed
   state space stays small (megas are few, so cost is irrelevant).
2. **Fully-soft gap.** `hardFloor = 0` (overlap always feasible, charged
   `softW`). The gap-based `null` returns (buildStates feasibility, `pairEval`
   floor checks) can no longer fire. **Spread-first is automatic**: `softW`
   still rewards separation, so dots overlap ONLY where geometry forces it.
3. **Guaranteed non-null.** If the relaxed chain DP still can't pair on a
   *structural* constraint (anti-parallel / collinearity / extCap), an ultimate
   fallback seats every dot in one best-fit free-angle row (dots at their lane
   crossings of that row, ordered along it). Relaxed `solveRows` therefore
   **never** returns null.

The relaxed pass reuses the whole tested cost model (slide, rot, turn, soft gap,
`proximity`/`blocked` masks), so the seated look is consistent with normal
stations.

### Determinism (free-angle rows)

The pipeline is bit-identical cross-V8 (`Math.sqrt` not `hypot`, `atan2`
quantized to 1e-6 rad, exact `AXES` constants). Free-angle rows introduce
`cos`/`sin`, which are **not** correctly-rounded across V8 engines and could flip
a former-mega station's seat between offline and in-game. Mitigation: derive fan
angles as `perpAng + fixed offsets` (already quantized) and **quantize the
resulting `u = [cos, sin]` components** to 1e-6 the same way the code already
quantizes `atan2`. Verify with the ULP harness (`dev/ulpRun.ts` / `_ulpcheck.ts`),
not just local byte-identity (which only checks same-engine reproducibility).

### Phasing (risk-gated)

The relaxed mode lands in two verified steps because `hardFloor = 0` + the
never-null fallback already eliminate megas on their own; free-angle is
non-octilinear polish that carries all the determinism/complexity risk:

1. **Overlap-first (octilinear states + never-null fallback).** Set
   `hardFloor = 0` and add the ultimate single-row fallback; keep the four
   octilinear axes. Former-megas seat as octilinear rows with overlap only where
   forced; the structural residual seats at natural lane anchors (already
   non-octilinear). Deterministic, low-risk, and megas are gone.
2. **Free-angle states.** Replace the axis snap with the quantized angle fan and
   fix the consumers (`P.axis === Q.axis` parallel test → `|cross| < eps`; the
   V-branch division guard; the `rot` redefinition). Gated on the ULP harness:
   if free-angle threatens cross-V8 determinism and cannot be quantized clean,
   ship step 1 alone (it already satisfies "allows overlap" and removes megas).

### Wiring

At the end of `renderOctilinear`'s escalation ladder, the branch that currently
sets `mk.mega = true` (single-bundle exhaustion, ~2205-2218) instead calls
`solveRows(..., { ...ropts, relaxed opts })` (guaranteed non-null) and commits
the returned dots through the **existing** success-commit loop (~2159-2166:
`pos`, `chain = order index`, `cornerAfter`). The `megaFallbacks` counter and
`reportMegaFallbacks` are removed. The multi-bundle platform-split branch is
retained. The existing **pill capsule** (`placement.ts` non-mega pill path)
wraps the dots unchanged. Route the relaxed commit through the same verify/commit
path as a normal seat so its capsule hull masks later stations
(`placedHulls.push`), not the bare else-branch commit.

### Deprecation

**Part 1 (this plan): remove the `box` branch, the toggle, and the
`megaFallback` option.** The `mega` flag and the `curve` (pill-with-dots)
rendering are kept for source 2(b), because `curve` is today's effective default
(`renderStations` passes `'curve'`, the UI default is `'curve'`), so residual
`boxStation` stations see **zero** visual change in Part 1. Part 2 deletes
`curve` + `mega` after the overlap rework.

- `placement.ts`: in the `isMega` block, always render the `curve` variant
  (pill-with-dots); delete the `box` return, the `megaBB` field, and the
  box-only `debugMegaBox` call. Delete `PlacementCtx.megaFallback`. The `box`
  capsule *kind* stays in the `StopScene` type (still used by the Tokyu/London
  design renderers; removed in Part 2).
- `renderOctilinear.ts`: remove the placement-path `mega` flagging (replaced by
  the relaxed seat), the `megaFallbacks` counter, and `reportMegaFallbacks`.
  Keep `mega`/`isBoxed`/`boxStation`/`megas` (fed by source 2). Delete the
  `megaFallback` arg + its default at the `renderStations` call.
- `types.ts`, `schematic.ts`, `renderGeographic.ts`, `stations/render.ts`: drop
  `megaFallback` from options / defaults / plumbing (reword the two doc comments
  that reference it by name).
- UI: delete the "Hubs: Curve/Box" toggle and `megaFallback` state/persistence
  in `SchematicPanel.tsx` and `DetailInset.tsx` (5 object literals, 5 dep arrays,
  2 type fields, restore/seed lines — enumerated in the plan).
- `debug/renderOctilinear.debug.ts`: drop `reportMegaFallbacks` AND
  `reportBoxRegime` (both fired only from the removed placement mega tail).
- Tests: the mega→curve capsule test stays valid; the mega→box test is removed
  (placement no longer produces `box`, since the option that selected it is
  gone). Add relaxed-mode `rowPlace` tests (never null, overlap-only-forced,
  free-angle). `mega` fixtures elsewhere stay valid (`mega` flag kept).

**Part 2 (separate design): delete `box` + `mega` entirely** after the
`boxStation` overlap rework — out of scope here.

## Data flow

Unchanged for the ~all non-mega stations: `solveRows` runs the octilinear ladder
and seats them identically. Only stations that previously exhausted the ladder
now take the relaxed pass instead of the mega branch, producing real dots + a
pill instead of a box/curve.

## Verification

- **Byte-identity diff (the pinned ruler).** The relaxed pass and the residual
  box-vs-curve change fire ONLY where the octilinear ladder previously produced a
  mega. `dev/_byte-identity.ts` renders every `improvedschematics-map-*.json` in
  both modes and hashes the SVG; it is a **regression-diff tool, not a
  must-match gate** (hashes at former-mega stations WILL change by design). The
  requirement: unaffected maps stay byte-identical, and every changed hash traces
  to a former-mega (or former-curve-residual) station. It only proves same-engine
  reproducibility, so it is necessary but not sufficient for cross-V8.
- **Cross-V8 determinism** (pipeline contract, load-bearing for free-angle):
  quantize the free-angle `u` components; verify with the ULP harness
  (`dev/ulpRun.ts` / `_ulpcheck.ts`). `Math.sqrt` not `hypot`; total tie-breaks;
  no `Date.now`/`Math.random`. If step-2 free-angle cannot pass, ship step 1.
- **Former-mega renders.** Before/after rasterized crops of the stations that
  currently go mega (SF and SEA have them) at each phase checkpoint: confirm the
  relaxed seat reads better than the box and that overlap appears only where
  forced.
- **Tests**: relaxed-mode `rowPlace` unit tests reusing the existing null/mega
  fixtures flipped to non-null (`{ ...OPTS, relaxed }`): never returns null;
  overlaps only under a `blocked`-forced pinch (unblocked stays ≥ minGap);
  free-angle row on an octilinear-infeasible fixture. The two `placement.test.ts`
  mega→box/curve tests rewritten to the residual-box behavior. Full `npm test`
  green (`tsx --test`).

## Risks

- **Free-angle determinism (highest).** `cos`/`sin` are not correctly-rounded
  cross-V8. Quantize `u`; gate step 2 on the ULP harness; fall back to step 1 if
  it can't pass. Step 1 alone still removes megas and allows overlap.
- **Free-angle breaks pair machinery.** `P.axis === Q.axis` (integer axis) no
  longer detects parallel rows; the V-branch divides by `cross = P.u × Q.u`,
  which explodes for near-parallel free angles. Must route `|cross| < eps` to the
  collinear branch and redefine `rot` as angular deviation from `perpAng`. Tie-
  breaks become load-bearing (free angles multiply near-equal-cost candidates);
  keep strict `<` first-found and the total-order sorts, iterate the fan in fixed
  order.
- **The non-null guarantee must be total.** The ultimate single-row fallback (at
  both the empty-states null ~266 and the no-pairing null ~669) must be
  unconditional, or a mega could resurface. Covered by a "never null" unit test
  over the adversarial (coincident/pinch/structural) fixtures.
- **Capsule-hull bookkeeping.** A relaxed seat committed outside the normal
  verify/commit path would skip `placedHulls.push`, so later stations would not
  mask against it. Route the relaxed commit through the same path as a normal
  seat.
- **Default divergence.** `DEFAULT_OPTIONS.megaFallback` is `'box'` but the
  render call sites default `'curve'`. Removing the option collapses both to the
  residual `box`; verify no path silently expected `curve`.

## Out of scope

- Reworking the octilinear ladder itself (it stays; relaxed is only its final
  stage).
- The capsule shape (the existing pill is reused).
- **Part 2**: the `boxStation` overlap rework and the full `box`/`mega` deletion
  (separate design pass).
