# Hanan-Grid Routing for Smoothed Mode — Design

**Date:** 2026-06-05
**Status:** Approved, ready for planning
**Mod:** Improved Schematics (Subway Builder)
**Reference paper:** Bast, Brosi & Storandt, *Metro Maps on Flexible Base Grids*, SSTD '21.

## Problem

Our current smoothed mode renders each transit edge as an independent
octilinear staircase (`octilinearPath(from, to, N)`). Lines that share a
real-world corridor — say the 4/5/6 along Lexington — therefore staircase
*independently*: each edge picks its own bend pattern, and the resulting
ribbons disagree visually, producing zigzags where the map should show clean
parallel runs.

The paper's framework — embed the transit graph into a shared **base grid
graph** and route every input edge via Dijkstra on it — directly fixes this:
edges that share a corridor naturally pick up the same grid edges and the
existing offset-bundling code then fans them into parallel ribbons.

## Approach

### 1. Base-grid snap

Project every station group to pixel space. Compute `d = median_edge_length
/ SNAP_DIVISOR` (default `SNAP_DIVISOR = 4`). Snap every station to the
nearest grid cell of size `d`. Multiple stations may collapse to the same
snapped cell.

Maximum positional displacement is `d/√2`, which at our 2700-pixel canvas and
typical NYC scale is ~3-5 visible panel pixels — acceptable.

### 2. Octilinear Hanan grid

From the unique snapped positions `S`:

- Gather the unique values of `x` (vertical lines), `y` (horizontal lines),
  `x+y` (one diagonal family), and `x−y` (the other diagonal family) across
  all `p ∈ S`.
- Take all pairwise intersections of different-family lines, restricted to
  the padded bounding box of `S`. Each intersection is a grid node.
- Each grid node has up to 8 neighbours: along each of the four lines
  through it, in both directions, the nearest collinear grid node.

For `n` snapped positions, this yields O(n²) grid nodes in the worst case;
for ~150-500 typical metro nodes, the paper measures 1.7k–6.2k grid nodes
which Dijkstra handles in milliseconds.

### 3. Dijkstra edge routing

Order transit edges by importance (decreasing line count, then decreasing
geographic length — same heuristic as our existing `orderEdgesByImportance`).
For each transit edge `(from, to)`:

- Start = grid node closest to `from`'s snapped position.
- Goal  = grid node closest to `to`'s snapped position.
- Run Dijkstra over the Hanan grid with the cost function below.
- Reconstruct the path of grid-node positions.
- Replace the first and last positions with the station's *real* pixel
  positions (small unaltered offset that absorbs the snap displacement).
- Record the path's grid edges and grid-node passes in shared-segment trackers
  so subsequent edges can bundle / avoid conflict.

If Dijkstra returns nothing (disconnected grid, exhausted node budget), fall
back to `octilinearPath(from, to, 2)` for that edge.

### 4. Cost function (paper-style relaxation — *all weights finite*)

For a candidate grid edge `e` from grid node `u` to grid node `v` while
routing a transit edge whose line-set is `L`:

```
cost(e | L, state) =
    length(e)                                 // Euclidean length
  + bendCost(prevDir, dir(e))                 // 0 / k / 2k / 3k for 0°/45°/90°/135°
  + ifPassThroughStation(v, goal) * STATION_PENALTY
  + sharedSegmentTerm(e, L, sharedSegs)       // bonus or relaxed conflict
  + diagonalCrossTerm(v, dir(e), diagCross)   // relaxed conflict
```

Tunable constants (initial values; iterate after visual checkpoint):

| Symbol               | Default                  |
|----------------------|--------------------------|
| `BEND_PENALTY_K`     | `0.3 × d`                |
| `STATION_PENALTY`    | `2.0 × d`                |
| `BUNDLE_BONUS`       | `−1.5 × length(e)`       |
| `CONFLICT_PENALTY`   | `+3.0 × length(e)`       |
| `DIAG_CROSS_PENALTY` | `+2.0 × length(e)`       |

After routing each edge, `sharedSegs[edgeKey] := sharedSegs[edgeKey] ∪ L`
and `diagCross[gridNodeKey][diagAxis] := true`.

**Key relaxation:** all conflict terms are finite. Dijkstra always returns a
path; visually objectionable cases just have higher cost and get the fallback.

### 5. Stitch & render

The output is a Map `edgeId → Pixel[]` of routed paths. `renderSmoothed`
builds its `LayoutEdge.path` from these, exactly as it does now with
`octilinearPath`. The downstream pipeline (`computeCanonicalOffsets` for line
bundling, `renderRibbons` for drawing) is unchanged: shared grid edges
naturally produce shared `Pixel[]` polylines, which then offset into
parallel ribbons.

### 6. Module layout

```
src/render/layout/
  hananGrid.ts        # construction: snap → unique line values → grid nodes & adjacency
  dijkstra.ts         # tiny binary-heap priority queue + generic Dijkstra
  hananRouter.ts      # orchestrator: order edges → route each → track shared segments
                      # exports routeAllEdgesViaHanan(graph, nodePx, opts): Map<edgeId, Pixel[]>
src/render/renderGeographic.ts
                      # MODIFY: renderSmoothed uses routeAllEdgesViaHanan in place of octilinearPath
```

`octilinearPath` remains in `src/render/layout/octilinearPath.ts` as the
fallback for un-routable edges.

## Testing

- `hananGrid.test.ts`: a 2×2 station fixture produces the expected number of
  unique x/y/diag values and grid nodes; a single station yields a degenerate
  but consistent grid.
- `dijkstra.test.ts`: shortest path on a tiny synthetic weighted graph.
- `hananRouter.test.ts`: a 4-station diamond graph with two transit edges that
  share the central node — both routed paths should reuse the same Hanan grid
  edges in the shared corridor.
- Visual: `dev/render-test.ts` produces `out-smooth.svg` from the NYC save;
  rasterize and compare to the previous independent-staircase version.

## Out of scope

- Hanan-grid routing for the **schematic** mode (item #3 in the analysis;
  defer until profiling shows it matters; current schematic is already a
  faithful game port and looks good).
- Node splitting for >8-degree station groups (item #4; visit when we see a
  cramped case).
- Orthoradial layout (item #5; future feature).
- Modifying `routeEdge` in place (item #2 originally proposed as standalone).
  The paper's constraint-relaxation idea is folded organically into the new
  Hanan router instead, since our existing `routeEdge` already uses soft
  weights everywhere and there are no `Infinity` costs to relax.
