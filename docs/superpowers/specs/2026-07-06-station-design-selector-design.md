# Station design selector — design

Status: approved (brainstorming), ready for implementation plan.
Date: 2026-07-06.

## Summary

Add a "Station design" selector to the mod's Appearance settings. The
Appearance block gains a row that reads "Station design" with the current
design's name under it and a blue "Change" button on the right. Clicking Change
opens an overlay over the map area showing a grid of design options, each a tile
with an example station rendered in that design and the design name beneath it.
The example station is drawn from one of the player's own routes (its bullet,
color, and text color), falling back to bullet "A" on red when the network has
no routes yet.

The existing station marker style is named "Classic". This iteration ships the
full selector with Classic as the only design; the picker and its data model are
built so additional city styles are added later as single registry entries.

Crucially, `stationDesigns.ts` is the single source of truth for a design: it
owns both the tile preview AND the on-map marker rendering for smoothed mode, so
the preview and the real marker can never drift.

## Goals

- A "Station design" row in the Appearance section of the settings popover:
  label + current design name + blue "Change" button.
- An overlay picker (inside the mod panel, over the map) with a responsive grid
  of design tiles: an example-station preview plus the design name; the active
  design is marked.
- The example station uses a representative player route (bullet + color +
  text color), defaulting to bullet "A" / red / white text.
- The registry drives the smoothed-mode marker render: `paintRibbons` dispatches
  the stop renderer through `getStationDesign(id)`, so the selected design
  determines what is drawn (currently only Classic).
- The selected design persists per city and per mode, like the other visual
  settings, and rides along in saved map files.
- A clean extension seam so a new city style is one new registry entry.

## Non-goals (this iteration)

- Only Classic exists, so there is no visible change to any rendered map. The
  smoothed dispatch resolves to Classic, whose stop renderer IS the current
  `renderStops`, so output stays byte-identical.
- Default geographic mode is NOT routed through the registry this iteration. It
  keeps drawing markers via its own `renderGeoNodes` (a separate, simpler
  renderer entangled with shared label-placement helpers). Wiring geographic
  through the registry is deferred to when a city style actually restyles it.
- No change to the layout fingerprint. Station design is draw-time (like
  `megaFallback` / `landmass`), so switching it is a cheap repaint, never a
  layout regenerate. The fingerprint (`cacheFingerprint.ts`) already reads only
  enumerated layout fields, so it ignores the new option automatically.

## Architecture

Units with clear boundaries.

### 1. `src/render/stationDesigns.ts` (new, framework-free)

The design registry, the smoothed marker-render dispatch, and the preview
renderer. Framework-free (no React), matching the `render/` convention of
render logic usable outside the game.

Exports:

- `interface StationDesign`
  - `id: string` — stable key persisted in settings (e.g. `'classic'`).
  - `name: string` — shown in the row and under each tile (e.g. `'Classic'`).
  - `blurb?: string` — optional one-line description (reserved for future tiles;
    unused by Classic).
  - `renderPreview(ex: ExampleStation): string` — returns a standalone `<svg>`
    string drawing one example station in this design (for the picker tile).
  - `renderStops: RenderStopsFn` — the smoothed/ribbon stop renderer, same
    signature as the existing `renderStops` in `stops.ts`. Classic's value IS the
    imported `renderStops` (referenced, not moved), so its output is identical.
    A future city style supplies its own function here.
- `type RenderStopsFn = typeof import('./stops').renderStops`
- `interface ExampleStation { bullet: string; color: string; textColor: string }`
- `const DEFAULT_STATION_DESIGN = 'classic'`
- `const EXAMPLE_STATION_DEFAULT: ExampleStation = { bullet: 'A', color: '#dc2626', textColor: '#ffffff' }`
- `const STATION_DESIGNS: StationDesign[]` — `[classic]` for now.
- `function getStationDesign(id: string | undefined): StationDesign` — registry
  lookup, falls back to Classic when the id is unknown/undefined.
- `function pickExampleRoute(routes): ExampleStation` — return the first
  non-temporary route with a non-empty `bullet`, mapped to
  `{ bullet, color: sanitizeColor(route.color), textColor: route.textColor ?? '#ffffff' }`;
  otherwise `EXAMPLE_STATION_DEFAULT`. Takes a minimal structural type
  (`{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }[]`)
  so it stays framework-free and testable. Sanitizes the color the same way as
  `render/routes.ts`'s `sanitizeColor`; if importing `routes.ts` (which pulls in
  `layout/graph`) into the registry adds undue weight or an import cycle, inline
  a local hex validator instead.

Dependency direction is acyclic: `stationDesigns.ts` imports `renderStops` from
`./stops` (which imports only constants/escape/chain helpers — never the
registry). `renderOctilinear.ts` imports `getStationDesign` from the registry.
So `renderOctilinear → stationDesigns → stops`, no cycle.

Classic's `renderPreview` draws the marker faithfully to what `renderStops`
draws for a single-line stop: a hollow disc (white fill in light context), a
ring in the route color whose stroke is proportional to the radius, and the
route bullet centered inside in the text color. It is a self-contained
`<svg viewBox=...>` sized for a tile (no panel counter-scaling, no anchor
groups). Deterministic and pure. (Where practical the preview shares a small
`classicDot` helper with `renderStops` so the two cannot drift; any such
extraction is a pure refactor validated by byte-identity. Otherwise the preview
is a faithful standalone.)

### 2. `src/ui/StationDesignPicker.tsx` (new)

The overlay component. Presentational; all data via props.

Props: `designs: StationDesign[]`, `current: string`, `example: ExampleStation`,
`dark: boolean`, `onSelect(id): void`, `onClose(): void`.

Renders:

- A header row: a back affordance + title "Station design" on the left, a close
  (✕) control on the right.
- A one-line helper: "Choose how stations are drawn. Applies instantly."
- A responsive grid (`repeat(auto-fit, minmax(~120px, 1fr))`) of tiles. Each
  tile shows the design's `renderPreview(example)` SVG in a small framed box and
  the design `name` beneath. The tile whose id equals `current` gets the blue
  (`#2563eb`) accent border and a "Selected" marker.
- Clicking a tile calls `onSelect(id)` then `onClose()`.

Styling follows the panel's inline-style idiom and blue (`#2563eb`); uses the
existing `Icon` component for the back/close/check glyphs.

### 3. Render pipeline (edited: smoothed dispatch)

The single pipeline call site is `paintRibbons` in `renderOctilinear.ts`, the
"cheap, toggle-dependent" draw step both smoothed and topo-geographic funnel
through. `megaFallback` already flows there as a draw-time field on
`RenderRibbonsArgs`; `stationDesign` follows the same path.

- `renderOctilinear.ts`: add `stationDesign?: string` to `RenderRibbonsArgs`
  (documented draw-time, like `megaFallback`). Replace the direct
  `renderStops(...)` call in `paintRibbons` with
  `getStationDesign(args.stationDesign).renderStops(stopsByNode, dark, membersByNode, degByNode, args.showStations !== false, sceneOut ? stopsPrims : undefined, args.megaFallback ?? 'curve')`.
  Swap the `renderStops` import for `getStationDesign`.
- `renderGeographic.ts`: thread `stationDesign` into the `paintRibbons` args
  built by `drawSmoothed` (add `stationDesign?: string` to its `opts` param and
  set `stationDesign: opts.stationDesign` on the args), and likewise in the
  topo path (`renderGeographicTopo` → `renderRibbons`) for completeness.
- `schematic.ts`: `drawSmoothedSchematic` reads `opts.stationDesign` and passes
  it into `drawSmoothed`.
- `types.ts`: add `stationDesign?: string` to `SchematicOptions`, documented as
  draw-time and excluded from the fingerprint (like `megaFallback`).

`stationDesign` is passed ONLY through the smoothed draw-options bag, never
placed in the fingerprinted `buildInput().options`, exactly as `megaFallback`
is. Default geographic mode (`renderGeoNodes`) is untouched.

### 4. `src/ui/SchematicPanel.tsx` (edited)

Wiring only; keep additions minimal.

- New state `stationDesign` (seeded `rvis.stationDesign ?? DEFAULT_STATION_DESIGN`)
  and `designPanelOpen`.
- Resolve the example station when the Change overlay opens (read the current
  routes then) via `pickExampleRoute(api.gameState.getRoutes())`, so the preview
  reflects the network as it stands when the picker is opened.
- Appearance block: add the "Station design" row above the existing sliders —
  left column = caption "Station design" + `getStationDesign(stationDesign).name`;
  right = a blue "Change" button that opens the overlay (and closes the settings
  popover).
- Mount `<StationDesignPicker>` as an absolutely-positioned overlay filling the
  viewport region when `designPanelOpen`, wired to a select handler that sets
  `stationDesign` and closes the overlay.
- Pass `stationDesign` into the smoothed draw call:
  `drawSmoothedSchematic(pre, { showLabels, showStations, megaFallback, landmass, landmassDetail, stationDesign }, out)`.
- Persistence: include `stationDesign` in `writeModeSettings`, the mount seed,
  and `switchMode`, exactly like `showStations`/`megaFallback`/`landmass`. Add
  `stationDesign?: string` to `RestoredSettings`, read it in `applyBundle`, and
  include it in the saved-map `settings` object in `exportMap`.

## Data flow

Routes (`api.gameState.getRoutes()`) → `pickExampleRoute` → `ExampleStation` →
`StationDesignPicker`, which calls each design's `renderPreview(example)` for
tiles. Selecting a tile updates `stationDesign` state → the row name updates and
the setting persists → the next smoothed draw passes the id into `paintRibbons`,
which dispatches the design's `renderStops`. With only Classic present the drawn
marker is unchanged.

## Apply / persistence semantics

- Applying is instant (draw-time, like Label size and Landmass): selecting a
  tile updates state and closes the overlay. No draft→Save step, no regenerate.
  In smoothed mode it is a cheap repaint (`drawSmoothed`), never an octi rebuild,
  and it never touches the cache fingerprint.
- Persistence is per city + per mode via `writeModeSettings`, matching the other
  visual toggles, and is captured in saved map files.

## Determinism

`stationDesigns.ts` is pure (no `Date.now()` / `Math.random()`). Smoothed output
stays byte-identical because Classic's `renderStops` IS the existing function and
the only added step is a pure registry lookup; geographic output stays identical
because `renderGeoNodes` is untouched. Verify with the byte-identity harness
(`dev/_byte-identity.ts`) across the `improvedschematics-map-*.json` dumps in
both modes.

## Testing

`src/render/tests/stationDesigns.test.ts` (Node's built-in runner):

- `STATION_DESIGNS` contains a Classic entry with `id === 'classic'`.
- `getStationDesign` returns Classic for `'classic'`, and falls back to Classic
  for an unknown id and for `undefined`.
- Classic's `renderStops` is the same reference the pipeline used before (dispatch
  parity), so a sample node renders identically through the registry.
- `pickExampleRoute` returns the first non-temporary bulleted route's
  bullet/color/text color; returns `EXAMPLE_STATION_DEFAULT` when routes is empty
  or has no bulleted, non-temporary route; sanitizes a bad color.
- Classic `renderPreview(ex)` returns a string starting with `<svg` that
  contains the bullet text and the route color.

The React overlay is intentionally thin (no React test harness exists in the
repo); the testable logic lives in `stationDesigns.ts`.

## File change list

- `src/render/stationDesigns.ts` — new: types, registry, `getStationDesign`,
  `pickExampleRoute`, Classic entry (`renderStops` reference + `renderPreview`),
  defaults.
- `src/render/tests/stationDesigns.test.ts` — new: unit tests above.
- `src/render/renderOctilinear.ts` — `RenderRibbonsArgs.stationDesign?`,
  dispatch `renderStops` via `getStationDesign` in `paintRibbons`, import swap.
- `src/render/renderGeographic.ts` — thread `stationDesign` into the
  `paintRibbons` args in `drawSmoothed` (and the topo path).
- `src/render/schematic.ts` — `drawSmoothedSchematic` passes `opts.stationDesign`.
- `src/render/types.ts` — add draw-time `stationDesign?: string` to
  `SchematicOptions`.
- `src/ui/StationDesignPicker.tsx` — new: overlay grid component.
- `src/ui/SchematicPanel.tsx` — edited: `stationDesign` + `designPanelOpen`
  state, the Appearance row, the overlay mount, the smoothed draw-call argument,
  and the persistence/seed/`switchMode`/`applyBundle`/`exportMap` plumbing plus
  the `RestoredSettings` field.

## Future extension (not in scope)

- Add a city style: append a `StationDesign` entry (its own `renderStops` +
  `renderPreview`) to `STATION_DESIGNS`.
- Cover geographic mode: extract `renderGeoNodes` (+ its private ring/count
  helpers) into its own module, dispatch the geographic marker renderer via the
  registry (passing it as an argument to avoid an import cycle), and give each
  `StationDesign` a geographic marker renderer too. Keep it draw-time / out of
  the fingerprint.
