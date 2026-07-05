# old/ — deprecated code

Superseded modules are MOVED here (mirrored paths) instead of lingering in
the live tree, per the repo deprecation policy: imports must break loudly,
and investigators must never mistake a dead module for a live one. Nothing
under `old/` is compiled, tested, or imported by the live tree — relative
imports inside these files intentionally no longer resolve.

| Moved | Date | Replacement | Why |
|---|---|---|---|
| `src/render/layout/untangle.ts` (+ test) | 2026-07-05 | `src/render/layout/bundleOrder.ts` + `blockAlgebra.ts` (bundle-blocks structural ordering; spec `docs/superpowers/specs/2026-07-04-bundle-blocks-rebuild-design.md`) | LOOM-ported line-order scorer/optimizer (hill climb, partner blocks, Y-stacks + seam scoring, corner factors + straight-lock, orientation passes) replaced by a rigid-block model in which open-track in-bundle reorders are unrepresentable. A/B results in the spec's appendix; user sign-off 2026-07-05. |
| `dev/contig-old.ts` | 2026-07-05 | `dev/contig.ts` | Contiguity regression harness. `contig-old` ran the full smoothed pipeline on OLD-format (v1 raw routes/tracks/stations) dumps and scraped per-line strokes back out of `paintRibbons` output; `contig.ts` reads the NEW v2 MapBundle `pre.geometry.dByLine` geometry directly. Both last touched in `3bf4185` (schema 6); no live importers. Relative imports left unrewritten per policy (they intentionally no longer resolve). |
| `src/render/layout/anchorGraphStops.ts` (extracted from `topo.ts`) | 2026-07-05 | Stop-node protection in `runMergeRounds` (stops join `isMergeAnchor` + dHat seed dedupe) | Post-merge corridor re-splitting at stop positions — a re-derivation that lost WHICH corridor a stop was on (the 191 Pl twin-platform horseshoe strandings) and enforced the Bundle-A spacing floor at the wrong stage. With stops protected through the merge it measured `minted=0 welded=0 far=0` on a 6-config corpus (SEA split+classic, NYC-XD, NYC-Jul4, LON-3, SF); includes the short-lived line-aware `hasNodeNear` + foreign-twin weld-through (`ce29c2a`, superseded same day). `OCTI_ANCHOR_DBG` died with it. |

The `OCTI_ORDER=loom` A/B knob was removed with this move; historical env
knobs documented inside the moved file (OCTI_XANGLE, OCTI_STRAIGHT_LOCK,
OCTI_NO_PARTNERS, OCTI_SEAM_SCORE, OCTI_TRACE/TRACE1, ...) are dead.
