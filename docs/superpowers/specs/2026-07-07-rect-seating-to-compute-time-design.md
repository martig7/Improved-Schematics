# Move Tokyu rect-capsule placement to cached compute time — design

## Goal

Run the Tokyu rectangle-capsule placement (`rectSeat` seating + `octiConnect` connectors +
cross-station rescue) once per layout in the **cached, design-agnostic** compute phase
(`computeRibbonGeometry`) instead of on every repaint in draw code. Store the result on
`RibbonGeometry`; `tokyu.paint` only reads it. Add box-edge line cropping if the render shows it
is needed. Matches the pill capsule, whose seating already runs at compute time and is cached.

Motivation: the standing "minimize draw-time computation" decision
([TODO-minimize-draw-time-compute.md](../../TODO-minimize-draw-time-compute.md)). Today
`rectSeat` + rescue re-run on every repaint (dark/label toggles). Moving them into the memoized,
serialized `pre.geometry` makes them run once per fingerprint and free on cache reads.

## Verified facts (spec exploration)

- `RibbonGeometry` is memoized on `SmoothedPrecomputed.geometry`
  (`renderGeographic.ts:1458` `pre.geometry ?? (pre.geometry = computeRibbonGeometry(args))`) and
  serialized to the map cache via the Map-aware codec in `persist.ts`. Adding an OPTIONAL field
  needs **no schema bump** (same as `splitGroups`); old caches deserialize it as `undefined`.
- **Nested `Map`s do not round-trip** through the codec reliably. Cached rect data must be plain
  arrays/objects (flatten `RectSeatOut.centers: Map` into `Array<{lineId, x, y}>`).
- `computeRibbonGeometry` is design-agnostic and must never branch on `stationDesign`. It already
  records `home`/`axis` per interchange mark (`renderOctilinear.ts:1333, 1360`).
- The interchange placement queue loop ends at ~`renderOctilinear.ts:1668`; **mark.pos is only
  final after that**. `rectSeat` MUST run after it.
- `segPath` (shared lane polylines) is built before rect logic and is not touched by it; non-Tokyu
  designs never enter `rectSeat`/rescue. So moving rect to compute is byte-identical for them.
- Existing polyline-vs-rect clip primitive: `cropSubgraph.ts` `clipRingToRect` (Sutherland-Hodgman)
  — adaptable to open polylines for cropping.
- Determinism already correct in the rect code (sqrt not hypot, epsilon-guarded total tie-breaks);
  it must stay that way when hoisted.

## Design

### 1. Cache the rect placement on `RibbonGeometry`

Add an optional, serialization-safe field:

```ts
// renderOctilinear.ts, RibbonGeometry
/** Per node: the precomputed Tokyu rect capsule (design-agnostic geometry; only the
 *  rect-capsule design reads it). OPTIONAL: caches serialized before it existed
 *  deserialize without it and fall back to computing at paint. */
rectByNode?: Map<string, RectCapsule>;
```

`RectCapsule` is a plain, serialization-safe shape (no nested Maps):

```ts
interface RectCapsule {
  box: number;
  centers: Array<{ lineId: string; x: number; y: number }>; // seated box center per line
  groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>;
  connectors: Array<{ points: Array<[number, number]> }>;
}
```

### 2. Compute it in `computeRibbonGeometry`, after placement, design-agnostically

After the placement queue loop exhausts (~line 1668, `mark.pos` final), before the return:

- For every gathered station with `marks.length >= 2` and every mark carrying `home` + `axis`
  (the geometric predicate — NOT the design), build `RectMember[]` and call `rectSeat` with the
  same box/gap the paint used (`S = 3*RCAP/MARKER_SCALE`, `gap = S*0.14`). Collect into a
  `Map<nodeId, RectCapsule>` (flatten `centers`, round connector points as today).
- Then run the **cross-station rescue at compute time** over that map (translate overlapping
  capsules), so the stored capsules are already deconflicted. `rectRescue` moves from
  `renderStations` (draw) into this compute step, operating on the `RectCapsule` map.
- Put the result on `RibbonGeometry.rectByNode`. This runs unconditionally (design-agnostic); the
  data is inert for non-Tokyu designs.

Determinism: iterate `gathered`/`stopsByNode` in their existing deterministic order; keep sqrt and
the existing tie-breaks; round connector points to `toFixed(1)` before storing.

### 3. Paint reads the cache; draw-time solve is removed

- `paintRibbons` passes `geom.rectByNode` into `renderStations` → `buildScene`.
- `buildScene` rect branch: when `ctx.capsuleMode === 'rectRows'` (checked FIRST) and
  `rectByNode?.get(nodeId)` exists, build the `rectRows` `StopScene` from the cached `RectCapsule`
  (map `centers` onto `scene.lines[].pos`, pass `groups`/`connectors` through) — no `rectSeat` call.
- Remove the draw-time `rectSeat` call from `placement.ts` and the draw-time `rescueRectCapsules`
  call from `render.ts`. Keep a safety fallback: if `rectByNode` is absent (old cache) but the
  design wants rect, compute `rectSeat` on the fly (the old path) so nothing crashes.
- Non-Tokyu designs never read `rectByNode` → byte-identical output.

### 4. Line cropping to box edges (conditional)

The opaque dark capsule is drawn over the lines, so line ends may already be visually covered.
First render the compute-time version and judge. If lines still poke past capsules or leave gaps:

- Cropping must NOT mutate the shared `segPath` (that would change non-Tokyu output). Instead,
  compute at compute time a **cropped-lane overlay** for rect-seated nodes: clip each incident lane
  polyline to its box/group rect (adapt `clipRingToRect` to open polylines, taking the first
  crossing from the node end), store as `RectCapsule.croppedLanes?: Array<{edgeId, lineId, points}>`
  or a sibling map. `paintRibbons` draws the cropped variant for those edges **only when the active
  design is rect-capsule** (a design-gated pick at draw, no draw-time compute); every other design
  draws the untouched `segPath`.
- Skip cropping for shared-anchor (`anchorStations`) lanes, mega, and single stops (fall back to the
  normal lane). Deterministic (sqrt, first-crossing).

If the render shows cropping is unnecessary (capsule covers the ends), record that and skip it.

## Out of scope

- The broader "audit existing draw-time code" sweep (tracked in the TODO for later).
- Any change to pill mode, other designs, or the seating algorithm itself.

## Risks / mitigations

- **mark.pos read mid-placement** (CRITICAL): call `rectSeat` only after the queue loop exits.
- **Nested-Map serialization**: flatten `centers` to an array; round connector points.
- **Non-Tokyu contamination**: `buildScene` checks `capsuleMode==='rectRows'` before touching
  `rectByNode`; non-Tokyu never reads it. Verify with a Classic-design byte-identity check.
- **Cropping leak**: never mutate `segPath`; cropped lanes are a separate overlay drawn only by the
  rect design.
- **Determinism**: sqrt not hypot; total tie-breaks; verify offline==in-game.

## Verification

- Unit: `rectByNode` produced by compute equals the previous draw-time `rectSeat` output for the
  same marks; `buildScene` reads the cache and yields the same `rectRows` scene it used to compute.
- Byte-identity: Classic/pill smoothed output unchanged (the dev byte-identity harness).
- Full `npm test` green; render NYC in Tokyu — capsules/connectors/rescue identical to before the
  move; judge cropping.
- Adversarial review: determinism, the post-placement timing, serialization round-trip, non-Tokyu
  byte-identity.
