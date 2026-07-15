# Route Visibility Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-bar "Routes" menu that lists every route on a grid in the user's station design; tapping a route opens a per-route enable/disable toggle whose changes are staged and applied on Save changes, removing hidden routes from the layout.

**Architecture:** A pure `filterRoutesByEnabled` cascade drops disabled routes (plus their now-orphaned stNodes/stations/tracks/groups) inside `buildInput()`. The hidden set is a new `disabledRoutes` field on the existing `applied` object, so it rides the draft to applied to Save flow and per-mode persistence already in `SchematicPanel`. A presentational `RouteMenu` overlay (modeled on `StationDesignPicker`) renders the grid and detail views.

**Tech Stack:** TypeScript, React (no default-React-import style), Node's built-in test runner (`npm test` = `tsx --test`). Build is esbuild transpile-only; `tsc` is not a pass/fail gate. Determinism and byte-identity on the corpus dumps are the correctness gates.

---

## Design reference

`docs/superpowers/specs/2026-07-15-route-visibility-menu-design.md`.

## File structure

- **Create** `src/render/filterRoutes.ts` — pure route-set cascade filter.
- **Create** `src/render/tests/filterRoutes.test.ts` — filter tests.
- **Modify** `src/render/stations/index.ts` — export `routeToExample`, refactor `pickExampleRoute` to reuse it.
- **Modify** `src/render/stations/tests/index.test.ts` — add `routeToExample` test.
- **Create** `src/ui/RouteMenu.tsx` — the overlay component (grid + detail).
- **Modify** `src/ui/SchematicPanel.tsx` — `disabledRoutes` draft + `applied` field, dirty/defaults, `saveAppearance`/`resetAppearance` extraction, `buildInput` filter, top-bar button, overlay mount.

---

## Task 1: `filterRoutesByEnabled` pure filter

**Files:**
- Create: `src/render/filterRoutes.ts`
- Test: `src/render/tests/filterRoutes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/render/tests/filterRoutes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRoutesByEnabled } from '../filterRoutes';

const net = () => ({
  routes: [
    { id: 'rA', stNodes: [{ id: 's1' }, { id: 's2' }] },
    { id: 'rB', stNodes: [{ id: 's2' }, { id: 's3' }] },
  ],
  stations: [
    { id: 'stA', stNodeIds: ['s1'], trackIds: ['t1'] },      // only rA
    { id: 'stShared', stNodeIds: ['s2'], trackIds: ['t2'] }, // rA and rB
    { id: 'stB', stNodeIds: ['s3'], trackIds: ['t3'] },      // only rB
  ],
  tracks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  stationGroups: [{ stationIds: ['stA'] }, { stationIds: ['stShared', 'stB'] }],
});

test('empty disabled set returns the input unchanged (same references)', () => {
  const n = net();
  const out = filterRoutesByEnabled(n, []);
  assert.equal(out, n);
  assert.equal(out.routes, n.routes);
});

test('disabling a route drops it and its exclusively-owned stNodes/stations/tracks', () => {
  const out = filterRoutesByEnabled(net(), ['rA']);
  assert.deepEqual(out.routes.map((r) => r.id), ['rB']);
  assert.deepEqual(out.stations.map((s) => s.id).sort(), ['stB', 'stShared']);
  assert.deepEqual(out.tracks.map((t) => t.id).sort(), ['t2', 't3']);
});

test('a station shared by a disabled and a surviving route is kept with its tracks', () => {
  const out = filterRoutesByEnabled(net(), ['rA']);
  assert.ok(out.stations.some((s) => s.id === 'stShared'));
  assert.ok(out.tracks.some((t) => t.id === 't2'));
});

test('station groups are filtered to surviving stations', () => {
  const out = filterRoutesByEnabled(net(), ['rA']);
  assert.equal(out.stationGroups!.length, 1);
  assert.deepEqual(out.stationGroups![0].stationIds, ['stShared', 'stB']);
});

test('disabling every route yields empty arrays', () => {
  const out = filterRoutesByEnabled(net(), ['rA', 'rB']);
  assert.deepEqual(out.routes, []);
  assert.deepEqual(out.stations, []);
  assert.deepEqual(out.tracks, []);
  assert.deepEqual(out.stationGroups, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render/tests/filterRoutes.test.ts`
Expected: FAIL — cannot find module `../filterRoutes`.

- [ ] **Step 3: Write the implementation**

Create `src/render/filterRoutes.ts`:

```ts
// Route-set filter: drop a set of routes from the network and cascade the removal to
// every stNode / station / track / group that no surviving route still references,
// leaving a self-contained network. A box-free cousin of cropSubgraph: the linkage is
// the same (a route owns stNodes; a station owns stNodeIds and trackIds; a group owns
// stationIds), keyed by route id instead of a spatial box.
//
// When nothing is disabled the input is returned unchanged (same array references), so
// a map with no hidden routes renders byte-identically to one built without this pass.

type RouteLike = { id: string; stNodes?: { id: string }[] };
type StationLike = { id: string; stNodeIds?: string[]; trackIds?: string[] };
type TrackLike = { id: string };
type GroupLike = { stationIds?: string[]; stations?: { id?: string }[] };

export function filterRoutesByEnabled<
  R extends RouteLike,
  T extends TrackLike,
  S extends StationLike,
  G extends GroupLike,
>(
  net: { routes: R[]; tracks: T[]; stations: S[]; stationGroups?: G[] },
  disabledIds: readonly string[],
): { routes: R[]; tracks: T[]; stations: S[]; stationGroups?: G[] } {
  if (disabledIds.length === 0) return net;
  const disabled = new Set(disabledIds);

  const routes = net.routes.filter((r) => !disabled.has(r.id));
  const keptStNodes = new Set<string>();
  for (const r of routes) for (const sn of r.stNodes ?? []) keptStNodes.add(sn.id);

  const stations = net.stations.filter((s) => (s.stNodeIds ?? []).some((id) => keptStNodes.has(id)));
  const keptTracks = new Set<string>();
  for (const s of stations) for (const t of s.trackIds ?? []) keptTracks.add(t);
  const tracks = net.tracks.filter((t) => keptTracks.has(t.id));

  const keptStations = new Set(stations.map((s) => s.id));
  const stationGroups = net.stationGroups?.filter((g) =>
    (g.stationIds ?? g.stations?.map((x) => x?.id) ?? []).some((id) => typeof id === 'string' && keptStations.has(id)),
  );

  return { routes, tracks, stations, stationGroups };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/render/tests/filterRoutes.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

Write the message to a temp file (an inline `-m` with a `C:` drive-letter string is blocked by the safety hook) and commit:

```
git add src/render/filterRoutes.ts src/render/tests/filterRoutes.test.ts
git commit -F <tmpfile>
```

Message:
```
feat(render): route-set cascade filter (filterRoutesByEnabled)

Drops a set of routes plus every stNode/station/track/group no surviving
route references. Identity fast-path when nothing is disabled keeps output
byte-identical.
```

---

## Task 2: `routeToExample` export + `pickExampleRoute` refactor

**Files:**
- Modify: `src/render/stations/index.ts`
- Test: `src/render/stations/tests/index.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/render/stations/tests/index.test.ts`, add `routeToExample` to the existing import on line 3, then append this test:

```ts
test('routeToExample: trims bullet, validates color, defaults textColor, keeps empty bullet', () => {
  assert.deepEqual(routeToExample({ bullet: ' A ', color: '#dc2626', textColor: '#ffffff' }), { bullet: 'A', color: '#dc2626', textColor: '#ffffff' });
  assert.equal(routeToExample({ bullet: 'B', color: 'bad' }).color, '#888888');
  assert.equal(routeToExample({ bullet: 'C' }).textColor, '');
  assert.equal(routeToExample({ color: '#123456' }).bullet, '');
});
```

The import line becomes:
```ts
import { STATION_DESIGNS, getStationDesign, DEFAULT_STATION_DESIGN, EXAMPLE_STATION_DEFAULT, pickExampleRoute, routeToExample, renderStationPreview } from '../index';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render/stations/tests/index.test.ts`
Expected: FAIL — `routeToExample` is not exported.

- [ ] **Step 3: Implement the refactor**

In `src/render/stations/index.ts`, replace the current `pickExampleRoute` function:

```ts
export function pickExampleRoute(routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    const bullet = (r.bullet ?? '').trim();
    if (bullet) return { bullet, color: okColor(r.color), textColor: r.textColor || '' };
  }
  return EXAMPLE_STATION_DEFAULT;
}
```

with:

```ts
/** Map one route to an ExampleStation: bullet trimmed, color validated, textColor
 *  defaulted to ''. Used by the route-menu tiles and by pickExampleRoute. */
export function routeToExample(r: { bullet?: string; color?: string; textColor?: string }): ExampleStation {
  return { bullet: (r.bullet ?? '').trim(), color: okColor(r.color), textColor: r.textColor || '' };
}

export function pickExampleRoute(routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    if ((r.bullet ?? '').trim()) return routeToExample(r);
  }
  return EXAMPLE_STATION_DEFAULT;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/render/stations/tests/index.test.ts`
Expected: PASS (existing `pickExampleRoute` test still green + the new one).

- [ ] **Step 5: Commit**

```
git add src/render/stations/index.ts src/render/stations/tests/index.test.ts
git commit -F <tmpfile>
```

Message:
```
refactor(stations): factor routeToExample out of pickExampleRoute

Exports the single-route to ExampleStation mapping so the route menu can
render any route in the current design.
```

---

## Task 3: `RouteMenu` overlay component

**Files:**
- Create: `src/ui/RouteMenu.tsx`

This is a presentational component with no automated test (like `StationDesignPicker`); it is verified by the suite staying green, a clean build, and the in-game check in Task 7.

- [ ] **Step 1: Write the component**

Create `src/ui/RouteMenu.tsx`:

```tsx
/**
 * RouteMenu — the overlay that opens from the top-bar Routes button. Covers the map
 * with a grid of route tiles, each rendered in the user's current station design;
 * tapping a tile opens a per-route detail view whose only control (for now) is a
 * Show-on-map toggle. Changes are staged (they dirty the appearance settings) and
 * applied by the shared Save changes action, so both modes re-render on Save and
 * smoothed regenerates. Presentational: all data and actions come through props.
 */

import { useState, type ReactNode } from 'react';
import { renderStationPreview, routeToExample, type StationDesign } from '../render/stations';
import { Icon } from './icons';

interface MenuRoute { id: string; name?: string; bullet?: string; color?: string; textColor?: string }

export function RouteMenu(props: {
  routes: MenuRoute[];
  design: StationDesign;
  dark: boolean;
  disabled: string[];
  dirty: boolean;
  atDefaults: boolean;
  onToggle: (routeId: string) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { routes, design, dark, disabled, dirty, atDefaults, onToggle, onSave, onReset, onClose } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const bg = dark ? '#18181b' : '#ffffff';
  const text = dark ? '#e4e4e7' : '#1a1a1a';
  const muted = dark ? '#a1a1aa' : '#6b7280';
  const border = 'rgba(136,136,136,0.35)';
  const tileBg = dark ? '#2a2d34' : '#f5f2ea';
  const hidden = new Set(disabled);
  const label = (r: MenuRoute) => r.name || r.bullet || r.id;

  const preview = (r: MenuRoute, px: number) => (
    <span
      style={{ width: px, height: px, display: 'flex', alignItems: 'center', justifyContent: 'center', background: tileBg, borderRadius: 8 }}
      dangerouslySetInnerHTML={{ __html: renderStationPreview(design, routeToExample(r), dark) }}
    />
  );

  const closeBtn = (
    <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', display: 'inline-flex' }}>
      <Icon name="x" />
    </button>
  );

  const footer = (
    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
      <button
        onClick={onReset}
        disabled={atDefaults}
        style={{ fontSize: 13, fontWeight: 600, padding: '6px 10px', borderRadius: 6, cursor: atDefaults ? 'default' : 'pointer', opacity: atDefaults ? 0.5 : 1, background: 'transparent', color: 'inherit', border: '1px solid rgba(136,136,136,0.5)' }}
      >
        Reset
      </button>
      <button
        onClick={onSave}
        disabled={!dirty}
        style={{ flex: 1, fontSize: 13, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: 'none', cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5, background: '#2563eb', color: '#ffffff' }}
      >
        {dirty ? 'Save changes' : 'Saved'}
      </button>
    </div>
  );

  const shell = (header: ReactNode, body: ReactNode) => (
    <div
      role="dialog"
      aria-label="Routes"
      style={{ position: 'absolute', inset: 0, zIndex: 20, background: bg, color: text, display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', overflowY: 'auto' }}
    >
      {header}
      {body}
      {footer}
    </div>
  );

  const sel = selected != null ? routes.find((x) => x.id === selected) : undefined;

  if (sel) {
    const on = !hidden.has(sel.id);
    return shell(
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => setSelected(null)} aria-label="Back" style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}>
          <Icon name="chevronLeft" size={18} /> Routes
        </button>
        {closeBtn}
      </div>,
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {preview(sel, 64)}
          <div style={{ fontSize: 16, fontWeight: 600 }}>{label(sel)}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: `0.5px solid ${border}`, borderRadius: 8, cursor: 'pointer' }}>
          <span style={{ fontSize: 14 }}>Show on map</span>
          <input type="checkbox" checked={on} onChange={() => onToggle(sel.id)} />
        </label>
      </div>,
    );
  }

  return shell(
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 15, fontWeight: 600 }}>Routes</span>
      {closeBtn}
    </div>,
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 12 }}>
      {routes.map((r) => {
        const on = !hidden.has(r.id);
        return (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            style={{ border: `0.5px solid ${border}`, background: 'transparent', color: text, borderRadius: 10, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: on ? 1 : 0.4 }}
          >
            {preview(r, 44)}
            <span style={{ fontSize: 12, fontWeight: 600, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(r)}</span>
          </button>
        );
      })}
    </div>,
  );
}
```

Notes: no placeholder copy in the detail view (production UI copy rule) — the `flex: 1` column reserves space below the toggle for future controls. The detail view renders the grid instead of a stale detail if the selected route vanishes (the `sel` lookup returns undefined, no setState during render).

- [ ] **Step 2: Run the suite to confirm no regressions**

Run: `npm test`
Expected: PASS (unchanged count; the new file is not yet imported anywhere).

- [ ] **Step 3: Commit**

```
git add src/ui/RouteMenu.tsx
git commit -F <tmpfile>
```

Message:
```
feat(ui): RouteMenu overlay (route grid + per-route toggle)

Presentational overlay: a grid of route tiles in the current station design
and a detail view with a Show-on-map toggle plus a shared Save/Reset footer.
Not yet mounted.
```

---

## Task 4: `disabledRoutes` state, `applied` field, dirty/defaults

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

No behavior change yet — `disabledRoutes` stays `[]`, so the map is unchanged.

- [ ] **Step 1: Add the `sameIdSet` helper**

After the `clamp` helper (currently `const clamp = (v, lo, hi) => ...`), add:

```ts
// Order-independent id-set equality, for comparing the draft hidden-route set
// against the applied one.
const sameIdSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
```

- [ ] **Step 2: Add `disabledRoutes` to the `RestoredSettings.applied` type**

In the `RestoredSettings` type, change:
```ts
  applied?: { lineWidth: number; stationRadius: number; mapMargin: number; warpPos: number; linePos: number; boxWarpPos: number; boxFrac?: number; stationSplit?: boolean };
```
to:
```ts
  applied?: { lineWidth: number; stationRadius: number; mapMargin: number; warpPos: number; linePos: number; boxWarpPos: number; boxFrac?: number; stationSplit?: boolean; disabledRoutes?: string[] };
```

- [ ] **Step 3: Add the draft state**

Immediately after the `stationSplit` draft state (`const [stationSplit, setStationSplit] = useState(rapp?.stationSplit ?? DEFAULT_STATION_SPLIT);`), add:

```ts
  // The hidden-route set (route ids removed from the layout). A staged/draft value
  // like the layout-baking sliders: it rides the same applied/dirty/Save flow, so a
  // toggle takes effect on Save (smoothed regenerates; geographic re-renders).
  const [disabledRoutes, setDisabledRoutes] = useState<string[]>(rapp?.disabledRoutes ?? []);
```

- [ ] **Step 4: Add `disabledRoutes` to the initial `applied`**

In the `const [applied, setApplied] = useState(...)` initializer, add `disabledRoutes` to both branches:
- the `rapp` spread branch object gains `disabledRoutes: rapp.disabledRoutes ?? []`
- the defaults branch object gains `disabledRoutes: []`

Result:
```ts
  const [applied, setApplied] = useState(
    rapp
      ? { ...rapp, boxFrac: rapp.boxFrac ?? DEFAULT_BOX_FRAC, stationSplit: rapp.stationSplit ?? DEFAULT_STATION_SPLIT, disabledRoutes: rapp.disabledRoutes ?? [] }
      : {
          lineWidth: DEFAULT_LINE_WIDTH,
          stationRadius: DEFAULT_STATION_RADIUS,
          mapMargin: DEFAULT_MAP_MARGIN,
          warpPos: DEFAULT_REALISM_POS,
          linePos: DEFAULT_REALISM_POS,
          boxWarpPos: DEFAULT_REALISM_POS,
          boxFrac: DEFAULT_BOX_FRAC,
          stationSplit: DEFAULT_STATION_SPLIT,
          disabledRoutes: [],
        },
  );
```

- [ ] **Step 5: Fold into `appearanceDirty`**

Change the last line of `appearanceDirty` from:
```ts
    applied.stationSplit !== stationSplit;
```
to:
```ts
    applied.stationSplit !== stationSplit ||
    !sameIdSet(applied.disabledRoutes ?? [], disabledRoutes);
```

- [ ] **Step 6: Fold into `appearanceAtDefaults`**

In `appearanceAtDefaults`, add a draft-side and an applied-side clause. Change:
```ts
    stationSplit === DEFAULT_STATION_SPLIT &&
    applied.lineWidth === DEFAULT_LINE_WIDTH &&
```
to:
```ts
    stationSplit === DEFAULT_STATION_SPLIT &&
    disabledRoutes.length === 0 &&
    applied.lineWidth === DEFAULT_LINE_WIDTH &&
```
and change the final line:
```ts
    applied.stationSplit === DEFAULT_STATION_SPLIT;
```
to:
```ts
    applied.stationSplit === DEFAULT_STATION_SPLIT &&
    (applied.disabledRoutes?.length ?? 0) === 0;
```

- [ ] **Step 7: Seed `disabledRoutes` in `switchMode`**

In `switchMode`, the `ap` normalization currently reads:
```ts
    const ap = { ...apRaw, boxFrac: apRaw.boxFrac ?? DEFAULT_BOX_FRAC, stationSplit: apRaw.stationSplit ?? DEFAULT_STATION_SPLIT };
```
Change it to:
```ts
    const ap = { ...apRaw, boxFrac: apRaw.boxFrac ?? DEFAULT_BOX_FRAC, stationSplit: apRaw.stationSplit ?? DEFAULT_STATION_SPLIT, disabledRoutes: apRaw.disabledRoutes ?? [] };
```
Then, next to the other `setX(...)` seeds in `switchMode` (after `setStationSplit(ap.stationSplit);`), add:
```ts
    setDisabledRoutes(ap.disabledRoutes);
```

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: PASS (no test references these; compile-only change).

- [ ] **Step 9: Commit**

```
git add src/ui/SchematicPanel.tsx
git commit -F <tmpfile>
```

Message:
```
feat(ui): stage disabledRoutes in the applied/dirty/Save flow

Adds the hidden-route set as an applied field with draft state, dirty and
defaults tracking, and per-mode seeding. No behavior change yet (empty set).
```

---

## Task 5: Extract `saveAppearance`/`resetAppearance`, wire the `buildInput` filter

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

- [ ] **Step 1: Import the filter**

Add near the other `../render/...` imports at the top:
```ts
import { filterRoutesByEnabled } from '../render/filterRoutes';
```

- [ ] **Step 2: Filter routes in `buildInput`**

In `buildInput`, after `const dark = api.ui.getResolvedTheme() === 'dark';`, insert:
```ts
    const net = filterRoutesByEnabled(
      {
        routes: api.gameState.getRoutes(),
        tracks: api.gameState.getTracks(),
        stations: api.gameState.getStations(),
        stationGroups: resolveStationGroupsFromGameState(api.gameState),
      },
      applied.disabledRoutes ?? [],
    );
```
Then replace the four inline source lines in the `rotateSchematicInput({ ... })` object:
```ts
      routes: api.gameState.getRoutes(),
      tracks: api.gameState.getTracks(),
      stations: api.gameState.getStations(),
      stationGroups: resolveStationGroupsFromGameState(api.gameState),
```
with:
```ts
      ...net,
```
`applied` is already in the `buildInput` dependency array, so no dependency change is needed.

- [ ] **Step 3: Extract the save/reset handlers**

Immediately after the `regenerate` `useCallback` (ends with `}, []);`), add:

```ts
  // Commit the staged appearance (including the hidden-route set) to `applied`, which
  // buildInput reads; smoothed rebuilds its layout. Shared by the Settings popover and
  // the Routes overlay so both surfaces fire the identical action.
  const saveAppearance = () => {
    setApplied({ lineWidth, stationRadius, mapMargin, warpPos, linePos, boxWarpPos, boxFrac, stationSplit, disabledRoutes });
    if (mode === 'smoothed' && smoothedReady) regenerate();
  };
  const resetAppearance = () => {
    setLineWidth(DEFAULT_LINE_WIDTH);
    setStationRadius(DEFAULT_STATION_RADIUS);
    setMapMargin(DEFAULT_MAP_MARGIN);
    setWarpPos(DEFAULT_REALISM_POS);
    setLinePos(DEFAULT_REALISM_POS);
    setBoxWarpPos(DEFAULT_REALISM_POS);
    setBoxFrac(DEFAULT_BOX_FRAC);
    setStationSplit(DEFAULT_STATION_SPLIT);
    setLandmass('faithful');
    setLandmassDetail(0.5);
    setDisabledRoutes([]);
    setApplied({
      lineWidth: DEFAULT_LINE_WIDTH,
      stationRadius: DEFAULT_STATION_RADIUS,
      mapMargin: DEFAULT_MAP_MARGIN,
      warpPos: DEFAULT_REALISM_POS,
      linePos: DEFAULT_REALISM_POS,
      boxWarpPos: DEFAULT_REALISM_POS,
      boxFrac: DEFAULT_BOX_FRAC,
      stationSplit: DEFAULT_STATION_SPLIT,
      disabledRoutes: [],
    });
    if (mode === 'smoothed' && smoothedReady) regenerate();
  };
  // Toggle one route in/out of the hidden set (staged; applied on Save).
  const toggleRoute = (id: string) =>
    setDisabledRoutes((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
```

- [ ] **Step 4: Point the existing Settings buttons at the shared handlers**

Replace the Reset button's inline `onClick={() => { ... }}` (the handler that sets the sliders and `setApplied({...})` then regenerates) with:
```tsx
                  onClick={resetAppearance}
```
Replace the Save button's inline `onClick={() => { setApplied({ lineWidth, stationRadius, mapMargin, warpPos, linePos, boxWarpPos, boxFrac, stationSplit }); if (mode === 'smoothed' && smoothedReady) regenerate(); }}` with:
```tsx
                  onClick={saveAppearance}
```

- [ ] **Step 5: Run the suite + background byte-identity check**

Run: `npm test`
Expected: PASS.

Then, in the background, confirm byte-identity with the hidden set empty (default), so the `buildInput` restructure changed nothing:
Run (background): the `dev/_byte-identity.ts` harness across the corpus dumps in both modes.
Expected: every dump byte-identical to `master`.

- [ ] **Step 6: Commit**

```
git add src/ui/SchematicPanel.tsx
git commit -F <tmpfile>
```

Message:
```
feat(ui): filter hidden routes in buildInput; share save/reset handlers

buildInput drops disabled routes via the cascade filter. Save/Reset are
extracted so the Settings popover and the Routes overlay commit identically.
Byte-identical corpus-wide with the default (empty) hidden set.
```

---

## Task 6: Top-bar button + overlay mount

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

- [ ] **Step 1: Import `RouteMenu`**

Add near the `StationDesignPicker` import:
```ts
import { RouteMenu } from './RouteMenu';
```

- [ ] **Step 2: Add the overlay-open state**

Next to `const [designPanelOpen, setDesignPanelOpen] = useState(false);`, add:
```ts
  const [routeMenuOpen, setRouteMenuOpen] = useState(false);
```

- [ ] **Step 3: Add the top-bar button**

After the Neighborhoods button block (the `<button>` whose body is `{showNeighborhoods ? '✓ Neighborhoods' : 'Neighborhoods'}` and its closing `</button>`), insert:
```tsx
        <button onClick={() => setRouteMenuOpen(true)} style={toggleStyle(routeMenuOpen)}>
          Routes
        </button>
```

- [ ] **Step 4: Mount the overlay**

After the `{designPanelOpen && ( <StationDesignPicker ... /> )}` block and before the panel's closing `</div>`, insert:
```tsx
      {routeMenuOpen && (
        <RouteMenu
          routes={api.gameState.getRoutes().filter((r) => r.tempParentId == null)}
          design={getStationDesign(stationDesign)}
          dark={api.ui.getResolvedTheme() === 'dark'}
          disabled={disabledRoutes}
          dirty={appearanceDirty}
          atDefaults={appearanceAtDefaults}
          onToggle={toggleRoute}
          onSave={saveAppearance}
          onReset={resetAppearance}
          onClose={() => setRouteMenuOpen(false)}
        />
      )}
```
(`getStationDesign` is already imported.)

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add src/ui/SchematicPanel.tsx
git commit -F <tmpfile>
```

Message:
```
feat(ui): mount the Routes menu (top-bar button + overlay)

A Routes top-bar button opens the RouteMenu overlay wired to the staged
hidden-route set and the shared save/reset handlers.
```

---

## Task 7: Verification checkpoint

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all tests pass (584 baseline + the new `filterRoutes` and `routeToExample` tests).

- [ ] **Step 2: Byte-identity, unused-feature (background)**

Run the `dev/_byte-identity.ts` harness across every `improvedschematics-map-*.json` dump in both modes, with the default (empty) hidden set.
Expected: byte-identical to `master` — the feature is inert until a route is hidden.

- [ ] **Step 3: In-game visual check**

Build the mod, open the panel, and confirm:
- The Routes button opens the grid; every real route shows a tile in the current station design with its name; temporary routes are absent.
- Tapping a tile opens the detail view; toggling Show on map dims the tile and dirties Save changes.
- Save changes applies: geographic re-renders with the route gone and neighbours re-placed; smoothed regenerates to the same effect. Reset restores all routes.
- Switching station design re-skins the tiles. Reopening the panel for the same city restores the hidden set (per mode).

- [ ] **Step 4: Fast-forward merge to master** (only when the user asks)

Per project workflow, merge only on request:
```
git checkout master && git merge --ff-only feature/route-visibility-menu
```

---

## Self-review notes

- **Spec coverage:** grid-in-design (Task 3 `renderStationPreview` + `routeToExample`), per-route detail toggle (Task 3), removal cascade (Task 1), staged/applied-on-Save (Tasks 4–5), per-mode persistence (Task 4 via `applied`), co-located Save/Reset (Tasks 3 + 5), entry point (Task 6), byte-identity guard (Task 1 + Task 7). All covered.
- **Type consistency:** `filterRoutesByEnabled(net, disabledIds)`, `routeToExample(r)`, `saveAppearance`/`resetAppearance`/`toggleRoute`, `disabledRoutes` used identically across tasks.
- **No placeholders:** every code step shows complete code.
