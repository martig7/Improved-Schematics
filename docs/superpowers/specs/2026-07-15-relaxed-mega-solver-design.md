# Relaxed mega-station solver — design

**Date:** 2026-07-15
**Area:** marker seating (`src/render/layout/rowPlace.ts`, `src/render/renderOctilinear.ts`, `src/render/stations/placement.ts`)
**Status:** design, pending review

## Goal

Replace the mega-station fallback (an unseatable station drawn as a `box` or a
`curve` capsule over degenerate dot positions) with a **relaxed, non-octilinear
solver that allows overlap** and can never fail. Make it the sole mega path and
delete the `box`/`curve` fallbacks and the `megaFallback` option.

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

### Wiring

At the end of `renderOctilinear`'s escalation ladder, the branch that currently
sets `mk.mega = true` calls `solveRows(..., { ...ropts, relaxed: true, softBand:
minGap })` and commits the returned dots (pos, corner, order) exactly like a
normal seat. No `mega` flag is set; `megaFallbacks` counter and its report are
removed. The existing **pill capsule** (`placement.ts`, the non-mega pill branch)
wraps the dots unchanged.

### Deprecation (delete outright)

The `box`/`curve` rendering is inline branches, not a module, so per the
user's decision it is removed, not moved to `old/`:

- `placement.ts`: delete the `isMega` block (box + curve) and the `megaBB` /
  `megaSpine` `SceneGeom` fields; a station is never mega now.
- `renderOctilinear.ts`: delete the `mega` flagging, `megaFallbacks` counter,
  `reportMegaFallbacks`/`reportBoxRegime` calls, and the `megaFallback` arg.
- `types.ts`, `schematic.ts`, `renderGeographic.ts`: drop `megaFallback` from
  options / defaults / plumbing.
- `StopMark.mega` and any `m.mega` reads (e.g. the `dots` filter in
  `renderOctilinear`): remove; nothing flags mega anymore.
- UI: delete the "Hubs: Curve/Box" toggle and `megaFallback` state/persistence
  in `SchematicPanel.tsx` and `DetailInset.tsx`.
- `debug/renderOctilinear.debug.ts`: drop `reportMegaFallbacks`/`reportBoxRegime`.
- Tests referencing `mega`/`megaFallback`/box/curve updated or removed.

## Data flow

Unchanged for the ~all non-mega stations: `solveRows` runs the octilinear ladder
and seats them identically. Only stations that previously exhausted the ladder
now take the relaxed pass instead of the mega branch, producing real dots + a
pill instead of a box/curve.

## Verification

- **Byte-identity gate (the pinned ruler).** The relaxed pass fires ONLY where
  the octilinear ladder previously produced a mega. Every other station's SVG
  must be **byte-identical** across the `improvedschematics-map-*.json` dumps in
  both modes (`dev/_byte-identity.ts`). Any diff outside a former-mega station is
  a regression.
- **Former-mega renders.** Before/after rasterized crops of the stations that
  currently go mega (SF and SEA have them) at the decision checkpoint: confirm
  the relaxed seat reads better than the box/curve and that overlap appears only
  where forced.
- **Determinism** (pipeline contract): free angles derive from already-quantized
  bundle perpendiculars; `Math.sqrt` not `hypot`; total tie-breaks; no
  `Date.now`/`Math.random`.
- **Tests**: relaxed-mode unit tests in `rowPlace` tests (never returns null;
  overlaps only under a forced pinch; free-angle row on an octilinear-infeasible
  fixture); full `npm test` green.

## Risks

- **Relaxed state space.** The angle fan widens `buildStates`; bounded and only
  on former-mega stations, so cost is negligible, but the fan size is a tuning
  knob (start small, grow only if a former-mega still can't seat well).
- **The non-null guarantee must be total.** The ultimate single-row fallback has
  to be unconditional (no structural veto) or a mega could resurface. Covered by
  a "never null" unit test over adversarial fixtures.
- **Byte-identity is the safety net.** If the relaxed changes leak into a
  non-mega station (e.g. a shared code path), the gate catches it; fix the leak,
  don't loosen the gate.

## Out of scope

- Reworking the octilinear ladder itself (it stays; relaxed is only its final
  stage).
- The capsule shape (the existing pill is reused).
