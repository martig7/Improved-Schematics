# Standing decision: minimize draw-time computation

**Principle (applies to new AND existing code).** Draw-time code (a design's `paint`,
`renderStations`, `paintRibbons` — everything that re-runs on a repaint such as a dark-mode
or label toggle) should do as little computation as possible. Heavy geometry belongs in the
**cached, design-agnostic compute phase** (`computeRibbonGeometry`) or precompute, computed
once per layout and reused across every repaint. Prefer more cached storage over repeated
per-repaint work.

## Immediate action (in progress 2026-07-07)

Move the Tokyu rectangle-capsule placement from draw time to compute time:
- `rectSeat` (upright-box seating), the cross-station overlap rescue, and the `octiConnect`
  connectors currently run in `buildScene` / `renderStations` (draw time, re-run every repaint).
- Move them into `computeRibbonGeometry` as an **always-on, design-agnostic** pass, storing the
  result (per-node box centers, group rects, connector polylines) in the cached `RibbonGeometry`.
  `tokyu.paint` then only reads the precomputed capsule; no solving at paint.
- This matches the pill capsule, whose seating (`solveRows`) + cross-station collision already run
  at compute time and are cached.
- **Line cropping becomes reachable:** the line-trim sites live in `computeRibbonGeometry`; once
  the box/capsule extents exist there, lines can be cropped to the box edges. Make it free if the
  geometry drops in; otherwise implement it as part of this work.

## Trade-off analysis (why this is still the right call)

**Runtime.**
- Cost added: `rectSeat` + rescue now run for every layout's compute even when a non-Tokyu design
  is selected. Magnitude is small: `rectSeat` is per-interchange with partition enumeration capped
  at 6 members (~200 partitions, each O(members^2)); interchanges are a minority of nodes; the
  cross-station rescue is O(N^2) AABB checks (N ~ 850 for a large city) done once. Order a few ms
  per layout.
- Cost removed: today the seat + rescue re-run on EVERY repaint. `computeRibbonGeometry` is the
  cached half (the bulk of draw time, hoisted into precompute), so moving there runs the rect
  solve ONCE per layout and reuses it across repaints. Net: the per-repaint path gets cheaper,
  which is the whole point. The only new cost (compute for non-Tokyu) is once per layout, never
  per frame.

**Storage.**
- The cached `RibbonGeometry` grows by the rect representation per node (box centers per line,
  group rects, connector polylines). Rough order: tens of floats per interchange, a few hundred
  interchanges -> low tens of KB per serialized map. Adding the field bumps the geometry-cache
  schema (optional field; older caches deserialize without it and recompute).
- Storage-optimal variant: keep the rect data in the in-memory `RibbonGeometry` (so repaints are
  free) but do NOT serialize it to the on-disk map cache — recompute it once on load. Since it is
  never per-repaint, that still satisfies the principle while avoiding the disk bloat. The spec
  decides serialize-vs-recompute-on-load.

**Net:** more cached (or once-per-load) compute + modest storage, in exchange for zero per-repaint
rect computation. Aligned with the principle.

## Follow-up audit (later)

Sweep existing draw-time paths for computation that could be hoisted into the cached compute phase
or precompute. Starting candidates to inspect: `buildScene` (pill spine RDP simplification runs at
paint), the design `paint` functions, `paintRibbons`, label placement. Each: does it recompute
geometry on every repaint that does not depend on the toggles (dark / labels)? If so, hoist it.
