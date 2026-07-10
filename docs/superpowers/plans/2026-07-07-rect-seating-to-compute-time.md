# Move rect-capsule placement to compute time — plan

> REQUIRED SUB-SKILL: subagent-driven-development. Steps use `- [ ]`.

**Goal:** compute the Tokyu rect capsules (seating + connectors + cross-station rescue) once in the
cached `computeRibbonGeometry`, store on `RibbonGeometry.rectByNode`, and have paint only read them.
Non-Tokyu byte-identical; deterministic. Spec:
`docs/superpowers/specs/2026-07-07-rect-seating-to-compute-time-design.md`.

**Verified anchors:** `RibbonGeometry` interface `renderOctilinear.ts:~201`; placement queue loop
ends `~1668`; `paintRibbons` calls `renderStations` `~3107`; `pre.geometry` memo
`renderGeographic.ts:1458`; persist Map codec `persist.ts:48-56` (NO nested Maps); `rectSeat`
`layout/rectSeat.ts`; `rectRescue` `layout/rectRescue.ts`; `buildScene` rect branch
`stations/placement.ts:~48`; draw-time rescue call `stations/render.ts:~40`.

---

## Task 1 — Types + serialization-safe RectCapsule

- Add to `renderOctilinear.ts` `RibbonGeometry`: `rectByNode?: Map<string, RectCapsule>;` (optional,
  mirror the `splitGroups` OPTIONAL comment; no schema bump).
- Define `RectCapsule` (plain, no nested Maps):
  `{ box: number; centers: Array<{lineId:string; x:number; y:number}>; groups: Array<{x,y,w,h,rx:number}>; connectors: Array<{points: Array<[number,number]>}> }`.
- Add a converter `rectSeatToCapsule(out: RectSeatOut, box): RectCapsule` (flatten `centers` Map →
  array; connector points → `[number,number]` rounded `toFixed(1)`). Keep `RectSeatOut` as-is for the
  solver; convert at the boundary.
- `npm test` stays green (types only). Commit.

## Task 2 — Produce rectByNode at compute time (incl. rescue)

- In `computeRibbonGeometry`, AFTER the placement queue loop (`~1668`, `mark.pos` final) and before
  the return: build `const rectByNode = new Map<string, RectCapsule>()`. For each gathered station
  with `marks.length >= 2 && marks.every(m => m.home && m.axis !== undefined)` (geometric predicate,
  NOT design): make `RectMember[]`, call `rectSeat(members, S, S*0.14)` with `S = 3*RCAP/MARKER_SCALE`
  (import the constants the paint uses), convert via `rectSeatToCapsule`, set into the map.
- Move the cross-station rescue to compute time: port `rescueRectCapsules` to operate on the
  `RectCapsule` map (translate overlapping capsules: shift `centers`, `groups`, `connectors`), run it
  once over `rectByNode` here. (Keep `rectRescue.ts` logic; add/point a variant that mutates
  `RectCapsule`s instead of `StopScene`s, or generalize.)
- Return `rectByNode` on the `RibbonGeometry`. Runs unconditionally, design-agnostic.
- Determinism: iterate in existing deterministic order; sqrt only; round connector points.
- Add a unit test: for hand-built marks with home/axis, the produced `RectCapsule` equals converting
  the direct `rectSeat` output (same centers/groups/connectors). `npm test` green. Commit.

## Task 3 — Paint reads the cache; remove draw-time solve

- Thread `geom.rectByNode` from `paintRibbons` (`~3107`) → `renderStations` (new param) → `buildScene`
  (new param / via `PlacementCtx`).
- `buildScene` rect branch: when `ctx.capsuleMode === 'rectRows'` (checked FIRST) and
  `rectByNode?.get(nodeId)` exists, build the `rectRows` `StopScene` from the cached `RectCapsule`
  (map `centers` → `scene.lines[].pos`; pass `groups`/`connectors`/`box`), NO `rectSeat` call. If the
  design wants rect but no cache entry (old cache), fall back to the current on-the-fly `rectSeat`
  (keep that path).
- Remove the draw-time `rescueRectCapsules(scenes)` call from `render.ts` (rescue now happens at
  compute). Non-rect designs unchanged.
- Verify: Tokyu render output identical to pre-move (the cached capsule == old draw-time capsule);
  Classic/pill byte-identical (dev byte-identity harness if runnable, else reason + tests).
  `npm test` green. Commit.

## Task 4 — Verify + cropping decision

- Full `npm test`; run the byte-identity harness for Classic/smoothed (unchanged).
- Render NYC in Tokyu: confirm capsules/connectors/rescue match the pre-move render.
- Cropping: inspect whether lines poke past the opaque capsules. If yes, implement the compute-time
  cropped-lane overlay (spec §4) drawn only by the rect design; if the opaque capsule already covers
  the ends, record that cropping is unnecessary and skip. Either way, document the outcome.

## Self-review

- Coverage: caching (T1), compute production + rescue move (T2), paint read + draw-time removal (T3),
  verification + cropping (T4).
- Determinism + non-Tokyu byte-identity are gates, checked in T3/T4.
- Out of scope: broad draw-time audit (TODO), pill/other designs.
