# Prevent bundle wedging (the downstream V-split) — design & outcome

**Date:** 2026-07-14
**Area:** smoothed-mode line ordering / twist rescue (`src/render/layout/`)
**Status:** Wedge 1 implemented; Wedge 2 (bidirectional-corridor seed) deferred to its own spec

## Symptom

At dense hubs a foreign line is seated *between* two lines that travel together,
so a co-traveling bundle splits apart and the capsule solver crops the pair into
a V. The reference case: on the 9 St / 14 St corridor the PATH pair (JSQ, HOB)
is split by the B, which passes through those stations without stopping.

## Diagnosis — it was NOT the ordering

The investigation ran through three stages, and the first two were falsified:

1. **Seed ordering** — falsified. The bundle-blocks seed produces a *clean*
   order for the wedged corridor.
2. **Join / cycle residual** — falsified. The block for the wedged corridor is
   `[JSQ HOB F D M B]`, perfectly grouped (PATH together, 6th-Ave together).
3. **`rescueTwists`** — the actual cause. A post-ordering "prettiness" pass that
   relocates visible X-crossings off straight runs. It shattered one
   **bundle × bundle** crossing (6th-Ave × PATH) into eight independent
   single-line migrations that thread through each other, landing B between the
   PATH pair. Confirmed by toggling the pass: with it off, the corridor is clean.

This confirmed the standing hypothesis that draw-time "prettiness" fixes can harm
geometry — `rescueTwists` is a coat of paint over the ordering, and it was
undoing the ordering's correctness.

## Root cause

`rescueTwists` migrates a straight-run crossing by walking a pair of lines along
the corridor and swapping them edge by edge. When the crossing being moved is
really one bundle crossing another, threading a single strand through the other
bundle IS the wedge.

## Fix (Wedge 1)

Migrate at the granularity that keeps the drawing clean:

- **Between two co-travel bundles** → swap the whole contiguous blocks, so no
  line is ever threaded into a bundle it does not belong to, and the block still
  lands clean at the absorb site (no wedge, no new straight-run twist).
- **Within one bundle** → move just the two lines (stays inside the bundle).
- Solo lines are singleton bundles, so ordinary single-line twists are unchanged.

Co-travel bundles come from a new pure module `coTravel.ts`: two lines share a
bundle when they traverse many of the same corridors (a shared-corridor-count
threshold, `OCTI_COTRAVEL_MIN`, default 3). The migration only swaps where both
units are clean adjacent blocks; otherwise it moves the two lines.

### Why not the per-line guard, or co-exit groups

- A guard that merely *blocks* the wedging migration leaves the crossing as a
  mid-straight twist — worst of both worlds. Rejected.
- A co-exit-group migration (derive the block from the divergence, no bundle
  threshold) reaches SF's wedge floor but reintroduces straight-run twists
  (7 on SF). Straight-run twists are worse than wedges, so this was rejected in
  favor of the bundle version (zero twists everywhere).

## Validation (sampled corpus: LON-3, NYC-jul-12/14, SEA-jul-11, SF-jul-14, TPE)

- **Straight-node twists: 0 on every map** (the pass still relocates them, now
  as whole-block moves).
- **NYC wedges 13 → 9** (the floor); the reference PATH/6th-Ave wedge is gone.
- **No regression**: SF/SEA/LON wedges unchanged from the prior shipped code;
  ordering crossing counts (`planned + residual`) identical everywhere.
- Cache `VERSION` bumped so cached layouts regenerate. Full suite green.

Rulers (gitignored `dev/`): `_wedge_measure.ts` (wedges + crossings),
`_twist_census.ts` (post-rescue straight twists), `_nyc_check.ts`.

## Out of scope — Wedge 2 (deferred)

A *second*, distinct wedge exists on the same map: the 6th-Ave bundle split by
the 8th-Ave (A C E) lines on the W 4 St ↔ 9 St corridor. That one IS in the
block-algebra **seed**: the corridor carries bidirectional through-traffic (some
lines exit each end), and the seed computes every line's exit key from one end,
so the opposite-direction lines get an ill-posed (turnaround) key and sort out of
place. The census metric does not even count it. It needs its own spec and its
own metric — see `2026-07-14-bidirectional-corridor-seed.md` (to be written).
