# Route Visibility Menu — Design

**Date:** 2026-07-15
**Branch:** `feature/route-visibility-menu`

## Goal

Add an in-panel menu that lists every route on a grid, each tile rendered in the
user's currently-selected station design. Tapping a tile opens a per-route detail
view whose only control (for now) is an enable/disable toggle that controls whether
the route appears on the map. The detail view reserves space for further per-route
controls to be added later.

## Summary of decisions

- **Disable = remove from layout.** A disabled route is filtered out of the network
  before rendering, and the remaining stations re-place around it (no orphan dots,
  no dangling track). This is semantically "what routes are on the map," not a
  draw-time hide.
- **Staged, applied on Save.** Route toggles do not re-render immediately. They edit
  a draft, mark the settings dirty, and take effect when the user clicks **Save
  changes** (the existing appearance-apply button). Geographic re-renders from the
  new `applied`; smoothed regenerates its layout. This rides the exact draft to
  applied to Save machinery the appearance sliders already use.
- **Persisted per mode.** The hidden-route set lives inside the `applied` object,
  which is already persisted per city per mode. Geographic and smoothed each remember
  their own set, consistent with how line width, warp, and station design already
  differ per mode.
- **Co-located Save/Reset.** The Routes overlay carries its own Save changes / Reset
  footer that fires the same commit as the Settings popover's, so the user can apply
  without leaving the menu.

## Background: relevant current architecture

### Route data

`api.gameState.getRoutes()` returns `Route[]` (`src/types/game-state.d.ts:136`):

```
interface Route {
  id: string;
  name?: string;
  bullet?: string;      // e.g. "A", "1", "L"
  color?: string;       // hex
  textColor?: string;   // hex or ''
  tempParentId?: string | null;  // set on temporary/preview routes
  stNodes?: StNode[];
  stCombos?: StCombo[];
  stations?: Station[];
}
```

The network is linked by ids: a `Route` owns `stNodes` / `stCombos`; a `Station`
owns `stNodeIds` and `trackIds`; a `Track` has an `id`. Real (non-temporary) routes
are those with `tempParentId == null`. Temporary routes are already excluded from the
map elsewhere and from the fingerprint.

### Rendering a route in a design

`renderStationPreview(design, { bullet, color, textColor }, dark): string`
(`src/render/stations/index.ts:37`) returns a standalone SVG of one station marker
painted in the given design. `pickExampleRoute` already maps a route to an
`ExampleStation` with hex validation (`okColor`). This is the exact primitive for a
"route tile in the user's design."

### The full-area overlay pattern

`src/ui/StationDesignPicker.tsx` is the template: a `position:absolute; inset:0;
zIndex:20` panel over the map, a header with back/close, a responsive tile grid
(`repeat(auto-fill, minmax(...))`), each tile rendering
`renderStationPreview(...)` via `dangerouslySetInnerHTML`. It opens from a boolean
(`designPanelOpen`) and is rendered near the end of `SchematicPanel`.

### The draft to applied to Save flow

`SchematicPanel` stages layout-baking settings and commits them on demand:

- Draft `useState` values (`lineWidth`, `warpPos`, `boxFrac`, `stationSplit`, ...).
- `applied` object — what `buildInput()` actually reads
  (`SchematicPanel.tsx:366`, shape mirrored by `RestoredSettings.applied` at
  `:237`).
- `appearanceDirty` (`:381`) is true when any draft differs from `applied`;
  `appearanceAtDefaults` (`:392`) drives the Reset button.
- **Save changes** button (`:2239`): `setApplied({ ...drafts }); if (mode ===
  'smoothed' && smoothedReady) regenerate();`.
- **Reset** button (`:2198`): sets drafts and `applied` to defaults, then regenerates.
- `applied` is persisted per mode via `writeModeSettings` (`:873`), restored on
  mount (`rapp`, `:366`) and on mode switch (`switchMode`, `:489`).

### Fingerprint and cache

`cacheFingerprint.ts:80` digests `input.routes` (filtering temp routes). Because the
removal filter changes the `routes` array inside `buildInput()`, the fingerprint
changes automatically. A smoothed layout built for a different route set therefore
misses the cache and rebuilds on Save. No cache version bump is needed: only the
input changes, not the layout algorithm.

## Design

### New module: `filterRoutesByEnabled`

`src/render/filterRoutes.ts` — a pure, independently testable cascade modeled on
`cropSubgraph.ts` but keyed by route set instead of a box.

```
filterRoutesByEnabled(
  net: { routes; tracks; stations; stationGroups },
  disabledIds: string[],
): same shape
```

Algorithm:

1. **Byte-identity guard.** If `disabledIds` is empty, return `net` unchanged (same
   array references). This guarantees that with no route disabled, the map is
   byte-identical to today's output — the feature is inert until used.
2. `keep = new Set(disabledIds)`; `fRoutes = routes.filter(r => !keep.has(r.id))`.
   Temporary routes are never in `disabledIds` (the grid excludes them), so they pass
   through untouched.
3. `keptStNodes` = union of `fRoutes[*].stNodes[*].id`.
4. `fStations = stations.filter(s => (s.stNodeIds ?? []).some(id => keptStNodes.has(id)))`.
5. `keptTracks` = union of `fStations[*].trackIds`; `fTracks = tracks.filter(t => keptTracks.has(t.id))`.
6. `keptStationIds = new Set(fStations.map(s => s.id))`; `fGroups = stationGroups?.filter(g => g's station ids intersect keptStationIds)`.
7. Return `{ routes: fRoutes, tracks: fTracks, stations: fStations, stationGroups: fGroups }`.

This drops a disabled route and every stNode / station / track / group that no
surviving route still references, leaving a clean network.

### Wiring into `buildInput()`

`buildInput()` filters the live game arrays before `rotateSchematicInput`:

```
const filtered = filterRoutesByEnabled(
  {
    routes: api.gameState.getRoutes(),
    tracks: api.gameState.getTracks(),
    stations: api.gameState.getStations(),
    stationGroups: resolveStationGroupsFromGameState(api.gameState),
  },
  applied.disabledRoutes ?? [],
);
return rotateSchematicInput({ ...filtered, geography, options: { ... } }, mapBearing);
```

`applied` is already a `buildInput` dependency, so no new dependency is added.
Rotation only transforms coordinates; it does not change membership, so filtering
before or after is equivalent, and filtering first keeps the cascade working on the
raw game shape.

### State in `SchematicPanel`

- New draft: `const [disabledRoutes, setDisabledRoutes] = useState<string[]>(rapp?.disabledRoutes ?? []);`
- New overlay flag: `const [routeMenuOpen, setRouteMenuOpen] = useState(false);`
- `applied` gains `disabledRoutes: string[]`:
  - the initial `applied` and the `DEFAULT` fallback default it to `[]`;
  - `RestoredSettings.applied` type gains `disabledRoutes?: string[]`;
  - the `ap` normalization in `switchMode` and the mount `applied` seed default a
    missing `disabledRoutes` to `[]`, exactly as `boxFrac` / `stationSplit` are
    migrated for older persisted entries.
- `appearanceDirty` gains a set-equality comparison
  `!sameIdSet(applied.disabledRoutes ?? [], disabledRoutes)`, where `sameIdSet`
  is an order-independent tiny helper.
- `appearanceAtDefaults` gains `disabledRoutes.length === 0 && (applied.disabledRoutes?.length ?? 0) === 0`.
- `switchMode` seeds `setDisabledRoutes(ap.disabledRoutes ?? [])`.

### Save / Reset, extracted for reuse

The inline Save and Reset `onClick` handlers are extracted into two `useCallback`s so
both the Settings popover and the Routes overlay footer fire the identical action:

- `saveAppearance()` — `setApplied({ lineWidth, stationRadius, mapMargin, warpPos, linePos, boxWarpPos, boxFrac, stationSplit, disabledRoutes }); if (mode === 'smoothed' && smoothedReady) regenerate();`
- `resetAppearance()` — sets every draft (including `setDisabledRoutes([])`) and
  `applied` to defaults, then regenerates in smoothed.

Both existing buttons and the new overlay footer call these. The route draft joins
the shared dirty state, so saving from either surface applies all staged layout
changes together (one unified "apply staged layout changes").

### New component: `RouteMenu`

`src/ui/RouteMenu.tsx` — presentational, self-contained navigation between a grid
view and a detail view via a local `selected` state.

Props:

```
{
  routes: Route[];                       // real routes only (parent pre-filters tempParentId)
  design: StationDesign;                 // getStationDesign(stationDesign)
  dark: boolean;
  disabled: string[];                    // the draft set
  dirty: boolean;                        // appearanceDirty
  atDefaults: boolean;                   // appearanceAtDefaults (drives Reset)
  onToggle: (routeId: string) => void;   // add/remove id in the draft
  onSave: () => void;                    // saveAppearance
  onReset: () => void;                   // resetAppearance
  onClose: () => void;
}
```

Internal `const [selected, setSelected] = useState<string | null>(null)`:

- **Grid view** (`selected == null`): header (title + close), a responsive tile grid
  (`repeat(auto-fill, minmax(84px, 1fr))`), and the Save/Reset footer. Each tile
  renders `renderStationPreview(design, routeToExample(route), dark)` with the route
  name beneath; a disabled route (id in `disabled`) renders at reduced opacity. The
  tile click sets `selected = route.id`.
- **Detail view** (`selected != null`): a back chevron returning to the grid, the
  route rendered larger with its name, a **Show on map** switch (on when the id is
  not in `disabled`; toggling calls `onToggle`), and a dashed placeholder region
  reserving space for future controls. The Save/Reset footer is shown here too.

`routeToExample(route): ExampleStation` is factored out of `pickExampleRoute` (reusing
`okColor`) and exported from `src/render/stations/index.ts`; it keeps an empty bullet
as-is (the name below identifies the route, and the design renders a bare colored
marker).

### Entry point

A `Routes` text button in the top-bar toggle row (near Stations / Labels /
Neighborhoods, `SchematicPanel.tsx:1755`) sets `routeMenuOpen = true`. The overlay is
rendered near `StationDesignPicker` at the end of the panel JSX, gated on
`routeMenuOpen`, closing via `onClose`.

## Persistence and file save/load

`disabledRoutes` lives inside `applied`, which is persisted per mode
(`writeModeSettings`) and captured by the map-file `modeSettings` bundle
(`exportMap`) and restored by `applyBundle`. It therefore rides existing persistence
and save/load with no extra plumbing, beyond defaulting a missing field to `[]` on
read.

## Edge cases and scope guards

- **All routes disabled** renders the backdrop only. Allowed; not specially handled.
  The `filterRoutesByEnabled` cascade yields empty arrays, which the pipeline already
  tolerates (same as an empty network).
- **Temporary routes** (`tempParentId != null`) are excluded from the grid and never
  enter `disabledRoutes`; the filter leaves them untouched.
- **A disabled route id that no longer exists** (route deleted in-game after being
  hidden) is simply absent from `getRoutes()`, so the filter is a no-op for it. The
  grid, keyed on live routes, stops showing it. Stale ids in `disabledRoutes` are
  harmless; no pruning required.
- **Empty bullet** routes render a bare colored marker in the design; the name label
  keeps them distinguishable.

## Testing

Node's built-in runner (`npm test`), tests in per-directory `tests/` subfolders.

- `src/render/tests/filterRoutes.test.ts`:
  - empty `disabledIds` returns the input unchanged (same references) — the
    byte-identity guard;
  - disabling a route drops it and its exclusively-owned stNodes / stations / tracks;
  - a station served by both a disabled and a surviving route is kept, and its tracks
    are kept;
  - station groups are filtered to surviving stations;
  - disabling every route yields empty arrays.
- `routeToExample` unit test: hex validation via `okColor`, empty-bullet passthrough,
  missing-color fallback.
- Byte-identity regression: with `disabledRoutes` empty, the corpus dumps render
  byte-identical in both modes (the existing `dev/_byte-identity.ts` harness), proving
  the feature is inert when unused.

`RouteMenu` is presentational; its behavior is covered by the pure helpers above and
verified visually in-game.

## Non-goals / future

- Only enable/disable ships now. The detail view reserves space for later per-route
  controls (the dashed placeholder).
- No per-mode sync of the hidden-route set (per-mode is intentional).
- No draw-time hide variant.
