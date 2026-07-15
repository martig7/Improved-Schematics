# Relaxed mega-solver — Part 2 design (delete box + mega)

**Date:** 2026-07-15
**Area:** `src/render/renderOctilinear.ts`, `src/render/stations/*`, `src/render/layout/*`
**Status:** design, pending review
**Predecessor:** Part 1 (relaxed solver) — shipped on `feature/relaxed-mega-solver`.

## Goal

Now that the relaxed solver seats every over-dense station (Part 1), **no station
boxes anywhere in the corpus** (measured: `no-overlap-floor boxed = 0` and
`slide-boxed = 0` across NYC-XD / NYC-jul-14 / SF / LON / TPE / DEN). Part 2
removes the two residual boxing passes and deletes the entire `box` + `mega`
machinery — the completion of the full-deletion scope the user chose.

## The three moves

### 1. Delete the mega-slide eviction pass (dead)

`renderOctilinear` ~2380-2440 slides stations that overlap a *placed mega box*
and boxes them (`boxStation`, `slideBoxed`, `reportSlideBoxed`) if the slide
breaks octilinearity. It iterates `megas`, which is now permanently empty (no
placement megas), so the whole pass is unreachable. Delete it, plus
`reportSlideBoxed` / `reportSlideBoxedSummary`.

### 2. Replace the no-overlap-floor last resort (~3189-3210)

The corridor-**spread** (the part that actually fires — it separates colliding
small stations along their lanes octilinearly) **stays**. Only the final
`boxStation(S)` last resort — for pairs the spread genuinely could not separate
(moving either would collide with a third station) — is replaced. Per the chosen
policy (**accept + log**): leave both stations seated on their lanes exactly as
the relaxed/normal seating placed them (a rare, minimal fill overlap is
tolerated), and emit one diagnostic naming the stuck pair so a real occurrence
surfaces a concrete case to design against. Delete `floorBoxed` /
`reportNoOverlapFloorBoxed` / `reportNoOverlapFloorSummary`; add a single
`reportNoOverlapFloorResidual({ layout, aNodeId, bNodeId })` diagnostic in their
place (env-gated like its peers).

### 3. Delete the box + mega machinery

With nothing left that boxes, remove:

- **`renderOctilinear.ts`**: `isBoxed`, the `megas` seed, `boxStation`, the
  `boxIsMega` arg to `reportEgregiousOverlaps`, the `addStop` `mega` param and
  its threading, and the three `if (m.mega) continue` / `.filter(!m.mega)`
  dot-filters (they become unconditional).
- **`layout/types.ts`**: the `mega?: boolean` field on `StopMark`.
- **`stations/placement.ts`**: the `isMega` block (the curve residual) and the
  `megaSpine` `SceneGeom` field — a station is never mega.
- **`stations/types.ts`**: the `{ kind: 'box'; … }` member of the `Capsule`
  union (and the StopScene doc mention).
- **`stations/primitives.ts`, `london.ts`, `rectCapsule.ts`, `toronto.ts`**: the
  `capsule.kind === 'box'` draw branches (dead once the kind is gone).
- **`layout/londonBubbles.ts`, `layout/torontoCross.ts`**: the `!m.mega` filters
  and the `mega?` fields on `BubbleMark` / `CrossMark` (all marks are now
  drawable).
- **`debug/renderOctilinear.debug.ts`**: the four box/slide report functions
  (replace with the one residual diagnostic).
- **Tests**: delete the `box`-capsule tests (`designs.test.ts` tokyu/london
  mega-box, `primitives.test.ts` box glyph), the placement mega test (added in
  Part 1), and update the `mega:true` input fixtures in `rectByNode.test.ts` /
  `londonBubbles.test.ts` / `torontoCross.test.ts` (drop the field).

## Verification

- **Byte-identity across the WHOLE corpus.** Because boxing fires 0× today, this
  is a **pure refactor** — every dump in both modes must render **byte-identical**
  SVG before vs after (`dev/_byte-identity.ts`). This is the primary gate; any
  diff is a regression (a station that was silently relying on a box path).
- **Census stays at 0**: no `box` capsule kind emitted anywhere (grep the scene
  prims), and the residual diagnostic does not fire on the corpus.
- **Full suite** green (`tsx --test`). `mapCache` VERSION: bump only if the
  serialized `StopMark` shape changes (removing the optional `mega` field may;
  verify against `persist.ts`).

## Risks

- **The box kind is load-bearing somewhere unseen.** Byte-identity over the full
  corpus is the safety net — if any map changes, a live path produced a box that
  the census missed; investigate rather than loosen the gate.
- **StopMark shape / cache.** Dropping `mega` from the serialized `StopMark` (if
  it is persisted) needs a `mapCache` VERSION bump so stale `:pre:` entries
  invalidate. Verify against `persist.ts` before deciding.
- **`spineOctilinear` orphaned.** If the mega-slide pass was its only caller,
  delete it too; else leave it.

## Out of scope

- The relaxed solver itself (Part 1, shipped).
- The corridor-spread algorithm (kept unchanged; only its box last-resort goes).
