# Station marker render surface — design

Status: approved (brainstorming), ready for implementation plan.
Date: 2026-07-06.

## Summary

Replace the current station-marker rendering (a growing `if/else` over marker
styles inside `render/stops.ts`, plus a separately hand-written preview SVG per
design in `render/stationDesigns.ts`) with a small, pluggable **station design
surface**. A design becomes one pure function that takes structured station
input and returns a **draw list** of primitives. That single draw list drives
all three consumers — the map SVG string, the canvas `Prim[]` scene, and the
picker preview — so the on-map marker and its preview can never drift, and there
is no hand-kept SVG/Prim duplication.

The layout-coupled geometry (dot lane positions, capsule spine, mega decisions)
is design-agnostic and stays in the pipeline. Designs control only how a marker
*looks*: dot shape and colors, bullet, and the capsule's shape and colors
(painting the pipeline-computed capsule geometry).

This is a rearchitecture that also absorbs the current in-flight designs
(Classic, NYC-Solid, NYC-Map with its fixed paper capsule) onto the new surface;
those uncommitted implementations are superseded by this change rather than
committed separately.

## Goals

- One place per design, in its own file: adding a design is a new file plus one
  registry line, with no edits to shared marker code.
- One definition drives the map marker, the canvas scene, and the preview tile.
  No per-design preview SVG; the preview reuses the design's paint function.
- Reusable, generically named drawing primitives (`circle`, `text`, `pill`,
  `rect`, `line`) that designs compose, so a design that draws a circle just
  calls `circle(...)`.
- Support marker shapes other than circles (squares, ticks, diamonds) with no
  changes outside the design file.
- Designs control the capsule's shape and colors; the placement/packing dynamics
  stay in one geometry module, with the seam left open to make placement
  pluggable later.
- No hand-maintained parallel SVG-string and `Prim[]` copies: both are generated
  from the one draw list.

## Non-goals (this refactor)

- Capsule *placement dynamics* (how dots pack, how the spine is solved, mega
  eligibility) remain in the pipeline; making that pluggable is deferred.
- Default geographic mode (`renderGeoNodes`) is out of scope, exactly as before;
  it keeps its own simpler markers.
- No intended change to the layout fingerprint. Station design stays draw-time.
- Byte-identical SVG is not required (the requester waived it for this feature);
  the goal is visually-equivalent output for the existing designs and green
  tests. The generated SVG must stay valid and parseable by `sceneFromSvg`.

## Architecture

### The split

- **Placement (pipeline, design-agnostic).** Given the solved marks for a
  station (`StopMark[]` from `computeRibbonGeometry`), compute a `StopScene`: the
  per-line dot data plus the capsule geometry (`none` / `pill` / `box` / `ring`).
  This is the spine/mega/coincident math currently living in `stops.ts`, minus
  any painting.
- **Appearance (pluggable design surface).** A `StationDesign.paint(scene, ctx)`
  returns a `Glyph[]` draw list. The design decides dot shape/colors, bullet
  color, and how to paint the capsule geometry.
- **Serialize (shared).** One draw list becomes: the map SVG fragment, the
  canvas `Prim[]`, and the standalone preview SVG.

### Data flow

```
computeRibbonGeometry ─ StopMark[] per node
        │
        ▼
placement.buildScene(marks, ctx) ─ StopScene (lines + capsule geometry)
        │
        ▼
design.paint(scene, ctx) ─ Glyph[]  (composed from primitives.ts)
        │
        ├─ glyphsToSvg(glyphs)  ─ wrapped in the imp-stop group ─ map SVG string
        ├─ glyphsToPrims(glyphs) ─ Prim[] (layer 'stops', worldScale true) ─ canvas
        └─ previewSvg(design, example) ─ paint on a synthetic scene ─ tile SVG
```

## Types (`stations/types.ts`)

```ts
/** One stopping line at a station. */
export interface StopLine {
  lineId: string;
  color: string;       // route color (hex)
  bullet: string;      // route bullet text (may be '')
  textColor: string;   // route text color (hex), or '' when the route has none
  pos: [number, number]; // solved dot center, world px
  chain: number;       // order within the capsule spine
}

/** Design-agnostic capsule (interchange) geometry, computed by placement. */
export type Capsule =
  | { kind: 'none' }
  | { kind: 'pill'; points: [number, number][]; smooth: boolean } // stroke thickness derives from StopScene.dotRadius
  | { kind: 'box'; x: number; y: number; w: number; h: number; rx: number }
  | { kind: 'ring'; cx: number; cy: number; r: number };

/** Everything a design needs to paint one station. */
export interface StopScene {
  nodeId: string;
  lines: StopLine[];
  capsule: Capsule;
  anchor: [number, number]; // marker anchor (imp-stop group / label anchor)
  dotRadius: number;        // solved dot radius at this station (full or capsule-shrunk)
}

/** Theme + toggles handed to every paint(). */
export interface PaintCtx {
  dark: boolean;
  showBullets: boolean; // the stations toggle; when false, omit the bullet text glyphs
}

/** Draw-list primitive: the design-level, backend-agnostic marker vocabulary.
 *  No layer/worldScale — the serializer adds those. */
export type Glyph =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; stroke: string; strokeWidth: number; data?: Record<string, string> }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx: number; fill: string; stroke: string; strokeWidth: number }
  | { kind: 'path'; d: string; fill: string; stroke: string; strokeWidth: number; lineCap: 'round' | 'butt' | 'square'; lineJoin: 'round' | 'miter' | 'bevel' }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
  | { kind: 'text'; x: number; y: number; text: string; fontSize: number; fontWeight: string; fill: string; align: 'start' | 'middle' | 'end' };

export interface StationDesign {
  id: string;
  name: string;
  blurb?: string;
  /** Paint one station into a draw list. Pure. */
  paint: (scene: StopScene, ctx: PaintCtx) => Glyph[];
  /** What the preview tile depicts. 'single' (default) = one dot; 'interchange'
   *  = a two-line station so a design whose capsule differs (NYC-Map) shows it. */
  previewKind?: 'single' | 'interchange';
}

export interface ExampleStation { bullet: string; color: string; textColor: string }
```

Draw order is glyph order: a design that wants dots over a capsule returns the
capsule glyphs first, then the dot/bullet glyphs. This removes the current
`flushDots` ordering gymnastics.

## Primitives (`stations/primitives.ts`)

Generically-named builders returning `Glyph` objects, e.g.:

```ts
export const circle = (cx: number, cy: number, r: number, o: { fill: string; stroke: string; strokeWidth: number; data?: Record<string, string> }): Glyph => ({ kind: 'circle', cx, cy, r, ...o });
export const text = (x: number, y: number, s: string, o: { fontSize: number; fill: string; fontWeight?: string; align?: 'start' | 'middle' | 'end' }): Glyph => ({ kind: 'text', x, y, text: s, fontWeight: o.fontWeight ?? 'bold', align: o.align ?? 'middle', fontSize: o.fontSize, fill: o.fill });
export const pill = (points: [number, number][], o: { stroke: string; strokeWidth: number; smooth: boolean }): Glyph => /* build the path d (RDP polyline or Catmull-Rom bezier) and return a path glyph, fill 'none', round caps/joins */;
export const rect = (...) => ({ kind: 'rect', ... });
export const line = (...) => ({ kind: 'line', ... });
```

Color/shape helpers used by designs also live here (or a sibling `colors.ts`):
- `contrastInk(hex)` (moved from `stops.ts`).
- `bulletFontSize(radius, name)` — the shared `dr*1.7` / multi-char shrink
  formula, so dot bullets and previews size identically.
- `capsuleStrokeWidths(dotRadius)` → `{ border, fill }` — reproduces the current
  spine border/fill widths (`2·r + 6·MARKER_SCALE`, `2·r + 3·MARKER_SCALE`) so a
  pill hugs its dots; keeps `MARKER_SCALE` out of the design files.
- `capsuleGlyphs(capsule, { border, fill }, dotRadius): Glyph[]` — renders the
  computed capsule geometry: a `box` → one filled+stroked `rect`, a `ring` → one
  filled+stroked `circle`, a `pill` → two stroked `path`s (wide border then
  narrow fill, both `fill: none`, round caps). Designs pick the two colors and
  call this; a design wanting a different capsule *shape* can skip it and emit
  its own glyphs.

## Serializer (`stations/serialize.ts`)

- `glyphsToSvg(glyphs): string` — each glyph to its SVG element string (`circle`,
  `text`, `path`, `rect`, `line`), preserving `data-*` on glyphs that carry it.
- `glyphsToPrims(glyphs): Prim[]` — each glyph to the matching `sceneIR` `Prim`,
  stamped `layer: 'stops'`, `worldScale: true` (text prims get `ax=0, ay=0`).
- `wrapMarker(anchor, nodeId, lineIds, innerSvg): string` — the anchored
  `<g class="imp-stop" data-ax data-ay>` + inner `<g data-stops data-station-id>`
  wrapper the pipeline currently emits (kept so label anchoring, export, and
  `sceneFromSvg` parsing continue to work). Verify during implementation which
  `data-*` attributes are actually consumed; keep those, drop any that are dead.
- `previewSvg(design, example, dark, viewBox): string` — build a synthetic
  `StopScene` (single dot, or a two-line horizontal interchange when
  `previewKind === 'interchange'`) from an `ExampleStation`, call `design.paint`,
  serialize with `glyphsToSvg`, wrap in a standalone `<svg viewBox=...>`. Resizable
  by setting width/height; the viewBox is fixed.

`glyphsToSvg` and `glyphsToPrims` are generated from the same list, so SVG and
canvas are consistent by construction. The SVG must remain parseable by
`sceneFromSvg` (same element types + `imp-stop` wrapper as today).

## Placement (`stations/placement.ts`)

`buildScene(nodeId, marks, ctx): StopScene`, holding the geometry currently in
`renderStops`:

- dot radius (`LINE_WIDTH*0.7`, shrunk by `MARKER_SCALE` inside a capsule),
- single dot → `capsule: { kind: 'none' }`,
- coincident marks → `{ kind: 'ring', ... }`,
- mega (un-seatable / `MEGA_BOXES`) → `{ kind: 'box' }` or, when `megaFallback`
  is `'curve'`, `{ kind: 'pill', smooth: true }` ordered along the principal axis,
- otherwise the spine `{ kind: 'pill', smooth: false }` from chain order +
  `cornerAfter`, RDP-simplified,
- the anchor point and per-line `StopLine`s (from `StopMark` + `lineById`).

`megaFallback: 'box' | 'curve'` stays a placement/pipeline option (a user
setting), not a per-design one. Pure; no `Date.now()`/`Math.random()`.

## Designs (`stations/classic.ts`, `nycSolid.ts`, `nycMap.ts`)

Each exports a `StationDesign`. `paint(scene, ctx)` composes primitives:

- **Classic** — per line: `circle` (fill = theme bg, stroke = line color) + bullet
  `text` (fill = theme ink), sized by `bulletFontSize`. Capsule:
  `capsuleGlyphs(scene.capsule, { border: ink, fill: bg }, r)`. Reproduces today's
  Classic look.
- **NYC-Solid** — per line: `circle` filled in the line color + bullet `text`
  (fill = `line.textColor || contrastInk(line.color)`). Capsule: theme colors as
  Classic.
- **NYC-Map** — per line: `circle` fixed black (`#111111`) + bullet `text` fixed
  white (`#ffffff`), both themes. Capsule:
  `capsuleGlyphs(scene.capsule, { border: PAPER_INK, fill: PAPER_BG }, r)` — a
  fixed white pill/box/ring with a black border, so the black dots read on top;
  its `PAPER_INK`/`PAPER_BG` constants live in this design file.
  `previewKind: 'interchange'` so the tile shows the paper capsule.

## Registry (`stations/index.ts`)

Replaces `render/stationDesigns.ts`: `STATION_DESIGNS`, `getStationDesign`,
`DEFAULT_STATION_DESIGN`, `EXAMPLE_STATION_DEFAULT`, `pickExampleRoute`
(unchanged behavior), plus `renderStationPreview(design, example, dark)` that
calls `serialize.previewSvg`.

## Pipeline entry (`stations/render.ts`)

`renderStations(stopsByNode, ctx, design): { svg: string[]; prims: Prim[] }` loops
nodes, runs `buildScene` → `design.paint` → serialize, and returns the SVG
fragments plus prims. `paintRibbons` calls this once (replacing the
`getStationDesign(args.stationDesign).renderStops(...)` call and the split-connector
color it borrows from `stops.ts`), passing `{ dark, showBullets: showStations,
members, deg, megaFallback, stationDesign }`. The `RenderRibbonsArgs.stationDesign`
id resolves through `getStationDesign`; the draw-time plumbing added earlier
(`SchematicOptions.stationDesign` → `drawSmoothed` → `paintRibbons`) is unchanged.

## Panel + preview integration

`StationDesignPicker.tsx` calls `renderStationPreview(d, example, dark)` for each
tile (no more `d.renderPreview` returning a hand-written SVG). `SchematicPanel`
imports the registry from `render/stations` instead of `render/stationDesigns`.
No other panel logic changes.

## Removed / moved

- `render/stops.ts` — its geometry moves to `stations/placement.ts`, its painting
  to the designs + `stations/serialize.ts`; `contrastInk` moves to
  `stations/primitives.ts` (or `colors.ts`). The `MarkerStyle` param and the
  `dot`/`capsule` `if/else` are gone. `stops.ts` is deleted (git preserves it).
  (The repo's deprecated-code policy — mirror superseded modules into `old/` — is
  aimed at replaced-and-discarded approaches; this is a refactor whose logic lives
  on in `placement.ts`, so `old/` is not used. Flag at spec review if the policy
  should still apply.)
- `render/stationDesigns.ts` — replaced by `stations/index.ts`; the three
  hand-written preview SVG functions are deleted.
- `renderOctilinear.ts` — imports/calls `renderStations` from `stations` instead
  of `renderStops`; drops the direct `renderStops` import.

## Determinism

`placement`, every `paint`, and `serialize` are pure (no `Date.now()` /
`Math.random()`), so offline equals in-game. Not fingerprinted (draw-time).

## Testing

Per-directory `stations/tests/`:

- `placement.test.ts` — marks → correct `Capsule` kind and fields (single→none,
  coincident→ring, spine→pill smooth=false, mega→box or pill smooth=true), dot
  radius, anchor.
- `designs.test.ts` — for each design, `paint` on a one-line scene and a two-line
  (capsule) scene yields the expected glyph kinds/colors: Classic (bg fill, line
  stroke, ink bullet; theme capsule), NYC-Solid (line fill, textColor/contrast
  bullet), NYC-Map (fixed black dot, white bullet, fixed white paper capsule with
  black border — in BOTH themes).
- `serialize.test.ts` — `glyphsToSvg` emits the expected elements and is
  wrap/parse-compatible; `glyphsToPrims` maps kinds and stamps `layer`/`worldScale`;
  a round example's SVG and prims agree on colors; `previewSvg` starts with `<svg`
  and contains the bullet + expected colors.
- `index.test.ts` — registry contains the three ids; `getStationDesign` fallback;
  `pickExampleRoute` behavior (migrated from the current `stationDesigns.test.ts`).

The current `render/tests/stops.test.ts` and `render/tests/stationDesigns.test.ts`
are removed/migrated into the above.

## File change list

- New: `src/render/stations/{types,primitives,serialize,placement,render,index,classic,nycSolid,nycMap}.ts`
- New: `src/render/stations/tests/{placement,designs,serialize,index}.test.ts`
- Modify: `src/render/renderOctilinear.ts` (call `renderStations`; drop `renderStops`).
- Modify: `src/ui/StationDesignPicker.tsx` (`renderStationPreview`), `src/ui/SchematicPanel.tsx` (import path).
- Delete: `src/render/stops.ts`, `src/render/stationDesigns.ts`, `src/render/tests/stops.test.ts`, `src/render/tests/stationDesigns.test.ts`.
- Keep: the earlier `textColor` plumbing (`LineRef`/`StopMark`/`graph.ts`/
  `renderOctilinear` lineById), which feeds `StopLine.textColor`.

## Future extension (not in scope)

- Pluggable capsule *placement* (a design overrides packing/spine solving): lift
  `placement.buildScene` behind the design interface once a design needs it.
- Non-circle dots and richer glyphs are already supported by adding primitives.
