# Logo render: spell "improved schematics" through the pipeline

**Date:** 2026-07-01
**Status:** approved, implementing

## Goal

Produce a mod logo by feeding a hand-authored ("artificial city") dump through the
existing offline render pipeline. The rendered map must spell **improved** inside one
station capsule and **schematics** inside a second capsule, arranged side by side with
"schematics" stepped slightly below "improved", on the dark-slate theme, each letter a
different bright rainbow color.

## Mechanic (verified in code)

- A line draws a **bullet dot** at every node where it *stops*. A node stopped by >1
  line renders as a **capsule** (rounded pill) surrounding the row of bullets
  ([`stops.ts:96`](../../../src/render/stops.ts)).
- The bullet text is the route's `bullet` field, trimmed; a single character renders
  literally ([`graph.ts:486`](../../../src/render/layout/graph.ts)).
- Lines sharing one **edge** fan into parallel lanes; a symmetric bundle keeps the
  **sorted line-id order**, so ids `00_i, 01_m, 02_p …` fix the left-to-right reading
  order.
- Lane offsets are perpendicular to the edge, so an edge running **due north** spreads
  the fan **east–west** → a horizontal word.

## Synthetic structure — one word

Each word is a 2-node network:

| Node | Built from | Role |
| --- | --- | --- |
| `A` (capsule) | one station at the word's position, its own group | every letter-line **stops** here → the visible capsule |
| `T` (pass-through) | one station due north, its own group, `trackIds: ['t_north_<word>']` | letter-lines pass through, **never stop** → no second capsule |

Each letter `c_k` is one route:

```
{ id: '<word>_<kk>_<c_k>', bullet: c_k, color: palette[k],
  stCombos: [{ startStNodeId: A_sn, endStNodeId: A_sn,
               path: [{ trackId: 't_north_<word>' }], distance: 100 }] }
```

`walkRouteVisits` turns each into `[A stop, T non-stop, A stop]` — a single shared
undirected edge `A–T` with the stop only on the `A` side. All letter-lines share that
edge → clean parallel lanes; the capsule sits at `A`; `T` draws nothing (0 marks →
skipped in `stops.ts`). `trackToGroup` comes from the station's `trackIds` list, so no
real `Track` objects are needed and edges render as straight octilinear segments.

## Layout & render settings

- Two words: `improved` (8 routes) at the origin; `schematics` (10 routes) placed east
  and slightly south → the lockup reads `improved  schematics`, second word stepped
  down.
- Mode **`smoothed`**, `warpAlpha: 0` (density warp off), moderate `geographicAffinity`
  so nodes stay where placed. Dark theme (slate `#2a2d34` fills the canvas). Bright
  10-color rainbow palette cycled across letters. High-res SVG + PNG via
  `@resvg/resvg-js`.

## Deliverables

1. `dev/logo-dump.ts` — parameterized builder `buildLogoDump(words, opts)` returning
   `{ routes, tracks, stations, stationGroups, options }`. Words, palette, spacing,
   north-tail length, and relative placement are all parameters.
2. `dev/render-logo.ts` — builds the dump, calls `generateSchematicSVG`, writes
   `dev/logo.svg` + `dev/logo.png`.
3. This spec.

## Final implementation notes (as built)

The design above is the core idea; the shipped implementation refined it over a few
visual checkpoints:

- **Per-word render + compose.** Each word is rendered ALONE (a combined render made
  octi place the two disconnected components in opposite corners and slant the second
  word). `dev/render-logo.ts` renders each word, crops to its capsule pill, and composes
  the two crops onto one dark-slate canvas — giving exact control over the side-by-side,
  stepped-down lockup.
- **Tails off the edge.** The node is always placed NORTH (the orientation octi lays out
  as a clean horizontal capsule); the shared node sits far off-canvas so the tracks run
  off the edge. "schematics" is **vertically mirrored** in compose so its tail runs off
  the BOTTOM (the pill/dots are symmetric; the letters are stripped before mirroring and
  redrawn upright). "improved" runs off the top.
- **Rainbow per letter** on dark slate; letters read left→right via reversed sorted line
  ids (lane slot 0 seats to the right).

## Renderer fix: terminus overshoot ("nub")

Investigating a small nub poking past the capsule pill revealed a **general** bug (the
user confirmed it on real maps): at a terminal capsule, `rowPlace` re-seats the bullet
dots into a clean horizontal row, but each route lane still ends along the (slightly
slanted) octi edge — so the outermost lanes' round end-caps poke past the pill. The
existing "Terminus trim" ([`renderOctilinear.ts`](../../../src/render/renderOctilinear.ts))
only trimmed overshoots `> r + 2`, ignoring the cap radius. Fix: trim **capsule** termini
flush to the seated stop (`d > 0.5`); lone terminal dots keep the looser threshold (a
small overhang past a single dot reads as a normal line end). Covered by a regression
test in `src/render/schematic.test.ts`; verified against the Seattle render (only a
handful of terminal lanes changed, map otherwise identical).

## Known risks / iteration

- A 10-line capsule could trip the **mega-box** fallback (degree ≥ 12 or infeasible row
  seat), which replaces bullets with a plain box. 10 < 12; if it fires, widen lane
  pitch (bigger `lineWidth`) or split.
- The there-and-back traversal `A→T→A` is degenerate; if it renders oddly, fall back to
  private single-dot termini (one per letter) with order controlled by terminus
  longitude.
- Exact fan spacing, lane-order sign (E vs W), tail length, and relative word placement
  are tuned over 1–3 render→look→tweak passes (parameters exist for each).
