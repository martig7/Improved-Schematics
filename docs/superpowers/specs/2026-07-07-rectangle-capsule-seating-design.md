# Rectangle capsule seating — design

## Goal

Give the Tokyu (numbered-square) station design a real interchange placement:
upright letter/number boxes seated on their lines, slid into aligned rows/columns,
with short straight connectors between rows that cannot share an axis. Replace the
current hardcoded horizontal row in `tokyu.ts paint()` (which ignores the solved
geometry) with a genuine seating solve in the layout stage.

## The problem with today's behavior

`tokyu.ts` is the only design that ignores the capsule geometry `buildScene` hands
it and lays out its own horizontal row (`x0 + i*(s+gap)`), irrespective of where the
lines actually run. That is why interchanges look arbitrary and the lines are not
cropped to the boxes. Interchange placement belongs in the placement/layout layer,
not in a design's `paint()`.

The pill regime cannot be reused by re-arranging its output: it seats **dots** along a
1D spine that follows line geometry. Upright rectangles are a different objective
(fixed-orientation footprints packed into aligned rows). Deriving rectangles from
pill-solved dots would be a draw-time patch over the wrong geometry. So the rectangle
layout earns its own seating solve.

## Design decisions (settled)

- **Boxes are always upright.** Letters and numbers read left to right; boxes never
  rotate to line direction. "On its line" means seated where the line passes, not
  rotated to it.
- **Axis-adaptive rows.** A group of boxes aligns into a horizontal row **or** a
  vertical column, whichever the cost model prefers given where the lines enter.
- **Dedicated solver, same stage.** A new rectangle-seating solve runs at the layout
  point where `solveRows` runs, selected when the active design requests rect capsules.
  `solveRows` and pill mode stay byte-for-byte untouched.
- **Line cropping deferred.** First pass keeps the existing arc-distance trim; we judge
  on real renders whether shape-aware cropping to the box edge is needed next.

## Architecture

New capsule regime selected by the design, computed in the layout layer, rendered by
the Tokyu design.

```
StationDesign.capsule: 'pill' (default) | 'rectRows'      // design declares intent
        │
renderOctilinear (interchange seat)
        │  if design.capsule === 'rectRows':
        ├── rectSeat(members, laneGeom)  ── NEW dedicated solver ──► box centers + groups
        │  else:
        └── solveRows(...)                ── UNCHANGED ──────────────► pill spine
        │
buildScene ── emits Capsule { kind: 'rectRows', groups, boxes, connectors } (new kind)
        │
tokyu.paint ── renders per-group capsule + upright boxes + connectors
```

### New capsule kind

```ts
// stations/types.ts — Capsule union gains:
| { kind: 'rectRows';
    boxes: Array<{ lineId: string; cx: number; cy: number }>;  // final upright centers
    groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>; // one rounded-rect per aligned group
    connectors: Array<{ points: Point[] }>; // octilinear polyline: 2 pts = single segment, 3 = one dead-zone bend
  }
```

Box width/height is a fixed rounded square sized from the marker scale (shared by all
boxes), so it is implicit rather than per-box.

## The seating solver (`rectSeat`)

### Inputs (one interchange node)

For each member line `i` stopping at the node:
- `home_i` — the point where line `i` passes the node (its lane curve at the anchor),
  from the same `lanePolysAt` / `buildLaneCurve` machinery pill mode already uses.
- `entryAxis_i` — the octilinear direction the line leaves the node on (`snapAxis` of
  the tangent), one of the 8 directions. Cheap, deterministic.
- bullet (letter), station number (`seq`, already computed at intake), color, textColor.
- Fixed box size `S` (rounded square).

### Objective

Partition members into aligned **groups**. Each group packs its boxes edge-to-edge
(fixed gap) along a single axis — horizontal or vertical — all upright, non-overlapping.
Choose the partition, each group's axis, and each group's placement to minimize:

```
Cost = Σ_i  slide(i)                 // linear in how far box i moves from home_i
     + Σ_g  connectorCost(g)         // ≈ ½ · (max slide merging g into the main group would cost)
```

- Members already collinear on a shared axis at their homes contribute ~0 slide
  ("same-axis connections are free").
- A separate group + connector is preferred exactly when forcing its members into one
  big row would cost more slide than the connector penalty — the ½·max-slide crossover.

### Search (bounded and deterministic)

Real interchanges have small member counts (large hubs fall back to the mega box), so
the solve is enumerable:

1. **Box order within a group is determined, not searched:** sort by the projection of
   `home_i` onto the group axis (preserves spatial order, avoids crossings, minimizes
   slide).
2. **Group placement is determined:** for a rigid packed row, the along-axis offset and
   across-axis position that minimize Σ slide from the members' homes are a closed-form
   median; snap to a deterministic grid.
3. **Enumerate:** set partitions of members (Bell numbers — tiny for ≤6) × axis ∈ {H,V}
   per group. For each, place every group freely to minimize its members' slide from their
   homes (steps 1–2), connect groups with `octiConnect` (a single octilinear segment, or a
   short two-segment octilinear path in the rare dead zone — it always succeeds), and sum
   `Σ slide + Σ connector`. Pick the minimum with deterministic tie-breaks (partition
   index, then H<V, then group order).
4. **Fallback:** if member count exceeds the enumeration bound or no non-overlapping
   packing fits, use the existing opaque mega box.

Determinism: the pre-existing primitives it uses (`snapAxis`, `curveTangent`) are already
cross-V8 deterministic; the new solver and `octiConnect` add no `Math.random`/`Date`,
resolve ties by fixed index order, and follow the pipeline's trig-quantization discipline.

### Connectors — shortest octilinear polyline (single segment preferred)

The Japanese maps join two rectangles with a **single straight octilinear segment** (one
of the 8 directions) whenever one exists, never an axis-only L-shaped taxicab path. When
the two rectangles are positioned so no single octilinear segment can span them (the dead
zone), the connector bends into a short **multi-segment** octilinear path rather than
forcing placement to move. `splitConnect.ts` is **not** reused; a new routine computes it:

`octiConnect(A, B)` — `A`, `B` are two group rectangles — returns an octilinear polyline
(a list of points, each leg along one of the 8 directions), the shortest joining their
boundaries, minimizing segment count first and then total length:
- **1 segment (common case):** for each octilinear direction, the shortest straight
  segment, edge-to-edge (or corner-to-corner on the diagonals), that spans the gap —
  vertical when the x-ranges overlap, horizontal when the y-ranges overlap, 45° when the
  boxes are diagonally offset. Pick the shortest; tie-break by direction index.
- **2 segments (dead zone only):** when no single octilinear segment connects them, the
  shortest two-leg octilinear path — legs meeting at an octilinear vertex (e.g. a 45° leg
  into axis alignment, then a straight leg). Deterministic vertex and leg-direction choice.

A single octilinear segment exists iff the two rectangles' projections overlap on at least
one of x, y, x+y, or x−y (an octilinear line stabs both). That holds for all but small,
far-apart, off-angle pairs — which essentially never occur inside one compact interchange;
when they do, the 2-segment path covers them. So a connector **always** exists and group
placement is left fully **free** (slide-minimizing, below) — never nudged or
partition-dropped for connectability. Which pairs connect is an MST over the groups
(k groups → k-1 connectors).

### Reuse

- **Lane geometry / entry axis:** `lanePolysAt`, `buildLaneCurve`, `curveTangent`,
  `snapAxis` — used as-is.
- **Mega fallback:** unchanged.
- **Numbers:** the intake `seq` already on each mark feeds the box directly.

## Rendering (`tokyu.paint`)

- Single line: one bare upright box, no capsule (unchanged single-stop path).
- Interchange: per group, a gray rounded-rect capsule sized to its boxes; each box a
  white rounded square with a route-color border, the route letter (route color) over
  the station number (ink); gray connector bars between groups. The current `square()`
  helper is reused; the hardcoded horizontal-row layout is deleted.

## Integration points

- `stations/types.ts` — add `rectRows` to `Capsule`; add `capsule?: 'pill' | 'rectRows'`
  to `StationDesign` (default `'pill'`).
- `renderOctilinear.ts` (interchange seat) — branch to `rectSeat` when the active design
  declares `rectRows`; otherwise the existing path runs unchanged. Emit each rect group as
  a placement unit so line trimming downstream still runs; the between-group connectors
  are carried on the `rectRows` capsule and drawn by the design (not by `splitConnect`).
- new `layout/rectSeat.ts` — the solver above.
- `stations/placement.ts` `buildScene` — emit the `rectRows` capsule from the solver's
  output.
- `stations/tokyu.ts` — set `capsule: 'rectRows'`; rewrite the interchange branch.

## Out of scope (this pass)

- Shape-aware line cropping to box edges (deferred; existing arc-distance trim stays).
- Any change to pill mode, `solveRows`, or the other designs.
- Mega-hub (≥ ~12 lane) rectangle packing beyond the existing opaque-box fallback.

## Verification

- Unit tests for `rectSeat` on hand-checked small cases: 2 aligned members (one group,
  no connector), members needing a split (two groups + one connector), axis selection
  (H vs V), determinism (same input → identical output).
- Render the real dumps (NYC / SEA / LON / a Tokyo-style set) in Tokyu mode; visual
  checkpoints at each: boxes upright, rows aligned, connectors sane, numbers present.
- Confirm non-Tokyu designs render byte-identically (rect path is behind the design flag).

## Risks

- The seating solver is genuinely new deterministic code; the enumeration bound and the
  connector crossover (½·max-slide) will need tuning against real interchanges.
- Registration to line geometry is only as good as the slide-minimization; without the
  deferred shape-aware crop, lines may meet boxes slightly imperfectly at first.
