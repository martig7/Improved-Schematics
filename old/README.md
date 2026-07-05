# old/ — deprecated code

Superseded modules are MOVED here (mirrored paths) instead of lingering in
the live tree, per the repo deprecation policy: imports must break loudly,
and investigators must never mistake a dead module for a live one. Nothing
under `old/` is compiled, tested, or imported by the live tree — relative
imports inside these files intentionally no longer resolve.

| Moved | Date | Replacement | Why |
|---|---|---|---|
| `src/render/layout/untangle.ts` (+ test) | 2026-07-05 | `src/render/layout/bundleOrder.ts` + `blockAlgebra.ts` (bundle-blocks structural ordering; spec `docs/superpowers/specs/2026-07-04-bundle-blocks-rebuild-design.md`) | LOOM-ported line-order scorer/optimizer (hill climb, partner blocks, Y-stacks + seam scoring, corner factors + straight-lock, orientation passes) replaced by a rigid-block model in which open-track in-bundle reorders are unrepresentable. A/B results in the spec's appendix; user sign-off 2026-07-05. |

The `OCTI_ORDER=loom` A/B knob was removed with this move; historical env
knobs documented inside the moved file (OCTI_XANGLE, OCTI_STRAIGHT_LOCK,
OCTI_NO_PARTNERS, OCTI_SEAM_SCORE, OCTI_TRACE/TRACE1, ...) are dead.
