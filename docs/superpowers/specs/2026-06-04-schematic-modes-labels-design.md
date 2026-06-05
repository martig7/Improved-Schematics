# Schematic Modes + Game-Faithful Labels — Design

**Date:** 2026-06-04
**Status:** Approved, implementation in progress
**Mod:** Improved Schematics (Subway Builder)

## Goal

Add two capabilities to the in-game schematic panel:

1. **Station labels** — faithful to the game's own `placeLabels`/`renderLabel`.
2. **The "schematicness" simplification** — the game's octilinear layout algorithm,
   reproduced from `GameMain` (no sourcemaps; ported via scripted deobfuscation).

These coexist with the mod's existing premise (a *geographic* schematic with
land/water context) through **three render modes**.

## Source of truth (reverse-engineered from the game)

The game's schematic pipeline, in `resources/app.asar → dist/renderer/public/GameMain-jqOSDAiD.js`:

```
buildTransitGraph   -> { nodes: stationGroups, edges, lineTraversals }
octilinearLayout    -> snapStations (A* on a grid, octilinearDistance) -> rebuildLayoutFromCells
simplifyLayout      -> ITERATIONS iters of edge-direction spring relaxation toward 8 directions
orderLines          -> order parallel lines on shared edges (reduce crossings)
renderSvg           -> computeCanonicalOffsets + offsetPolyline (bundling)
                       + renderStops (per-line ticks) + placeLabels + renderLabel
```

**Exact tuning constants (must be preserved):**
`STEP_SIZE = 3`, `TARGET_EDGE_CELLS = 2.2`, `EDGE_STIFFNESS = 0.18`, `ITERATIONS = 80`,
`OCT_UNIT` = 8 unit direction vectors (0/45/90/135/180/225/270/315°), nearest chosen by
max dot product (`nearestOctilinearUnit`). Render constants: `CELL_PX`, `PAD`, `LINE_WIDTH`
(to be read from the deobfuscated reference).

The modding API (`window.SubwayBuilderAPI`) does **not** expose this engine, so it is
reimplemented in the mod. It exposes only `gameState` (routes/tracks/stations) + UI.

## Three render modes

| Mode | Station positions | Water | Lines |
|------|------------------|-------|-------|
| **Geographic** (existing) | true lng/lat | aligned | follow real track geometry |
| **Smoothed** | near-geographic (octilinear relaxation anchored to true position) | aligned | lean toward 45°/90° |
| **Schematic** | full game octilinear (A* snap + 80-iter simplify) | loose affine-fit backdrop | clean octilinear, parallel-bundled |

Labels + the station toggle work in all three modes.

## Module architecture

`schematic.ts` becomes a thin dispatcher. Engine split into focused, framework-free,
independently testable modules (so `dev/render-test.ts` exercises all of it without the game):

```
src/render/
  constants.ts        # STEP_SIZE, TARGET_EDGE_CELLS, EDGE_STIFFNESS, ITERATIONS,
                      # OCT_UNIT, CELL_PX, PAD, LINE_WIDTH, ...
  projection.ts       # (existing) geo->SVG; used by Geographic/Smoothed + water fitting
  routes.ts           # (existing) extractRouteLines — geographic geometry
  graph.ts            # buildTransitGraph: API -> { nodes, edges, lineTraversals }
  octilinear.ts       # snapStations (A* grid), rebuildLayoutFromCells, octilinearLayout
  simplify.ts         # OCT_UNIT, nearestOctilinearUnit, simplifyLayout; + smoothGeographic
  lineOrder.ts        # orderLines
  offsets.ts          # computeCanonicalOffsets, offsetPolyline
  labels.ts           # placeLabels + renderLabel (shared by both renderers)
  stops.ts            # renderStops (per-line stop ticks)
  renderGeographic.ts # refactor of today's renderer: water+lines+stations+labels
  renderOctilinear.ts # game-faithful renderSvg port: offsets+stops+labels+water backdrop
  schematic.ts        # generateSchematicSVG({ mode, ... }) dispatcher
  types.ts            # shared graph/layout/label types
```

## buildTransitGraph (the one genuinely new mapping)

Derived from the API data model (`Station.trackGroupId`, `Station.stNodeIds`,
`Route.stComboTimings` with `stNodeId` + `stNodeIndex`, `Route.stNodes[].center`):

1. **Station groups** = group `stations` by `trackGroupId`; group `center` = mean of member
   `coords`. This is the game's interchange node.
2. **stNode -> group** map via `station.stNodeIds`.
3. Per route, **ordered group visits** from `stComboTimings` sorted by `stNodeIndex`, mapped
   to groups, with consecutive duplicates dropped = that line's traversal.
4. **Edges** between consecutive distinct groups; record traversing lines + direction.

Produces `{ nodes, edges, lineTraversals }` matching the game's structure.

## Faithful port via scripted deobfuscation

No sourcemaps. The obfuscation is a mechanical string-array decoder. Add `dev/deobf.ts`
(dev-only, not shipped) that resolves all `_0xdecoder(idx)` calls to string literals and
dumps readable reference versions of the ~14 target functions to `dev/reference/`. Port
from those into clean TypeScript, preserving exact constants + logic. Deobfuscator and
reference dumps stay in-repo so the port is auditable against the original.

## Smoothed mode

Reuse the octilinear spring math (`nearestOctilinearUnit` + edge springs) in
geographic-projected space, with a strong anchor pulling each node toward its true
position. Lines lean octilinear while staying put; water stays aligned. Lighter than the
full grid layout.

## Water in Schematic mode (wait-and-see — surface a render early)

Derive one affine map from the station groups' geographic bbox -> their octilinear-layout
bbox; apply it to the water polygons. Anchors water to the schematic's overall extent —
a loosely aligned backdrop (will not precisely match; accepted). A real render of this is
to be produced early for review before it's locked in.

## UI

`SchematicPanel.tsx`: mode selector (Geographic / Smoothed / Schematic), keep Stations
toggle, add Labels toggle. Recompute SVG via `useMemo` on those deps. Water remains
optional/`undefined` until the separate water-generation milestone; every mode handles
water-absent gracefully.

## Testing

- Extend `dev/render-test.ts` to emit all three modes (`out-geo.svg`, `out-smooth.svg`,
  `out-octi.svg`) from the real Seattle save; visually compare octilinear output against the
  in-game schematic.
- Unit tests for pure pieces: `nearestOctilinearUnit` (all 8 directions),
  `buildTransitGraph` (ordering, interchange collapse, dedup), `orderLines` determinism,
  `placeLabels` non-overlap.

## Error handling

Empty network -> existing empty-state SVG. A* no-path -> fall back to a straight edge.
Degenerate/zero bounds guarded. `main.ts` try/catch stays.

## Out of scope

Runtime water **generation** from `ocean_depth_index` (separate README milestone). Modes
only consume water if present.
