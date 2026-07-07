# Station design selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Station design" selector to the mod's Appearance settings — a row with the current design name and a blue "Change" button that opens an overlay grid of design tiles (example station + name), with the smoothed renderer sourced from a new `stationDesigns.ts` registry.

**Architecture:** A new framework-free `render/stationDesigns.ts` holds the design registry (currently just "Classic"), the example-route picker, and per-design SVG previews, and OWNS the smoothed marker renderer: Classic's `renderStops` field references the existing `renderStops`, and `paintRibbons` dispatches through `getStationDesign(id)`. A new `ui/StationDesignPicker.tsx` renders the overlay. `ui/SchematicPanel.tsx` gets the row, the state, the overlay mount, and persistence. The selected design is draw-time (never in the layout fingerprint), like `megaFallback`.

**Tech Stack:** TypeScript, React (game mod UI), Node's built-in test runner (`tsx --test`), Vite/esbuild build. Reference spec: `docs/superpowers/specs/2026-07-06-station-design-selector-design.md`.

**Project rules that bind this work:**
- Tests are the gate: `npm test`. `tsc` is NOT a pass/fail gate.
- Byte-identity verification is explicitly SKIPPED for this feature (per the requester).
- Do NOT commit — leave all changes in the working tree. Commits are held until the user asks.
- Env reads go through `src/env.ts` (not needed here, but noted).

---

### Task 1: `stationDesigns.ts` registry + tests

**Files:**
- Create: `src/render/stationDesigns.ts`
- Test: `src/render/tests/stationDesigns.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/render/tests/stationDesigns.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATION_DESIGNS,
  getStationDesign,
  pickExampleRoute,
  DEFAULT_STATION_DESIGN,
  EXAMPLE_STATION_DEFAULT,
} from '../stationDesigns';
import { renderStops } from '../stops';

test('registry contains Classic and default id is classic', () => {
  assert.ok(STATION_DESIGNS.some((d) => d.id === 'classic'));
  assert.equal(DEFAULT_STATION_DESIGN, 'classic');
});

test('getStationDesign returns Classic and falls back for unknown/undefined', () => {
  assert.equal(getStationDesign('classic').id, 'classic');
  assert.equal(getStationDesign('nope').id, 'classic');
  assert.equal(getStationDesign(undefined).id, 'classic');
});

test('Classic dispatch reuses the pipeline renderStops (no drift)', () => {
  assert.equal(getStationDesign('classic').renderStops, renderStops);
});

test('pickExampleRoute picks the first non-temporary bulleted route', () => {
  const ex = pickExampleRoute([
    { tempParentId: 'x', bullet: 'Z', color: '#123456' },
    { bullet: 'Q', color: '#00ff00', textColor: '#000000' },
  ]);
  assert.deepEqual(ex, { bullet: 'Q', color: '#00ff00', textColor: '#000000' });
});

test('pickExampleRoute defaults when there are no usable routes', () => {
  assert.deepEqual(pickExampleRoute([]), EXAMPLE_STATION_DEFAULT);
  assert.deepEqual(pickExampleRoute([{ tempParentId: 'x', bullet: 'Z' }]), EXAMPLE_STATION_DEFAULT);
  assert.deepEqual(pickExampleRoute([{ bullet: '   ' }]), EXAMPLE_STATION_DEFAULT);
});

test('pickExampleRoute sanitizes a bad color to gray', () => {
  const ex = pickExampleRoute([{ bullet: 'A', color: 'not-a-color' }]);
  assert.equal(ex.color, '#888888');
});

test('classic renderPreview returns an <svg> containing the bullet and ring color', () => {
  const svg = getStationDesign('classic').renderPreview({ bullet: 'A', color: '#dc2626', textColor: '#ffffff' }, false);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('>A<'));
  assert.ok(svg.includes('#dc2626'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/render/tests/stationDesigns.test.ts`
Expected: FAIL — cannot find module `../stationDesigns`.

- [ ] **Step 3: Create the module**

Create `src/render/stationDesigns.ts`:

```ts
/**
 * Station design registry. A "design" is how a station marker is drawn — the
 * on-map smoothed marker (renderStops) AND the small example-station preview
 * shown in the picker. Keeping both here makes the registry the single source of
 * truth so the preview and the real marker cannot drift. Framework-free (no
 * React) like the rest of render/, so it is unit-testable and usable offline.
 *
 * Draw-time only: the selected design never enters the layout fingerprint, so
 * switching it is a cheap repaint (see cacheFingerprint.ts, which hashes only
 * enumerated layout fields).
 */

import { renderStops } from './stops';
import { escapeXml } from './escape';

/** The smoothed/ribbon stop renderer signature (the existing renderStops). */
export type RenderStopsFn = typeof renderStops;

/** The example station a preview tile draws: one route's bullet + colors. */
export interface ExampleStation {
  bullet: string;
  /** Line color (hex). */
  color: string;
  /** Bullet text color (hex) — used by designs that color the letter; Classic
   *  draws the letter in the theme's neutral ink, not this. */
  textColor: string;
}

export interface StationDesign {
  /** Stable key persisted in settings. */
  id: string;
  /** Shown in the settings row and under each picker tile. */
  name: string;
  /** Optional one-line description (reserved for future city styles). */
  blurb?: string;
  /** Standalone <svg> string drawing one example station in this design. */
  renderPreview: (ex: ExampleStation, dark: boolean) => string;
  /** The smoothed-mode marker renderer for this design. */
  renderStops: RenderStopsFn;
}

export const DEFAULT_STATION_DESIGN = 'classic';

export const EXAMPLE_STATION_DEFAULT: ExampleStation = {
  bullet: 'A',
  color: '#dc2626',
  textColor: '#ffffff',
};

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Validate a hex color, else a neutral gray (mirrors routes.ts sanitizeColor;
 *  inlined so the registry stays a light leaf module). */
function okColor(c: string | undefined): string {
  return c && HEX.test(c) ? c : '#888888';
}

/**
 * The example station for the picker: the first non-temporary route that has a
 * non-empty bullet, else the A/red default. Minimal structural param so this
 * stays framework-free (accepts the game's Route[] directly).
 */
export function pickExampleRoute(
  routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>,
): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    const bullet = (r.bullet ?? '').trim();
    if (bullet) return { bullet, color: okColor(r.color), textColor: r.textColor || '#ffffff' };
  }
  return EXAMPLE_STATION_DEFAULT;
}

/**
 * Classic preview: faithful to what renderStops draws for a single-line stop —
 * a hollow disc, a ring in the line color, the bullet centered inside in the
 * theme's neutral ink (NOT the route text color, matching renderStops). Sized
 * for a tile in its own viewBox.
 */
function classicPreview(ex: ExampleStation, dark: boolean): string {
  const fill = dark ? '#18181b' : '#ffffff';
  const ink = dark ? '#ffffff' : '#111111';
  const cx = 22;
  const cy = 22;
  const r = 13;
  const name = ex.bullet;
  // Mirror renderStops' bullet font sizing (dr === r for a plain dot).
  const fs = name.length <= 1 ? r * 1.7 : Math.min(r * 1.7, (2 * r * 0.92) / (0.6 * name.length));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${escapeXml(ex.color)}" stroke-width="6"/>` +
    `<text x="${cx}" y="${(cy + fs * 0.36).toFixed(2)}" text-anchor="middle" ` +
    `font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" ` +
    `font-size="${fs.toFixed(2)}" font-weight="bold" fill="${ink}">${escapeXml(name)}</text>` +
    `</svg>`
  );
}

const classic: StationDesign = {
  id: 'classic',
  name: 'Classic',
  renderPreview: classicPreview,
  renderStops,
};

export const STATION_DESIGNS: StationDesign[] = [classic];

/** Registry lookup; falls back to Classic for unknown/undefined ids. */
export function getStationDesign(id: string | undefined): StationDesign {
  return STATION_DESIGNS.find((d) => d.id === id) ?? classic;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/render/tests/stationDesigns.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all tests pass. Do NOT commit.

---

### Task 2: add a `chevronLeft` icon

**Files:**
- Modify: `src/ui/icons.tsx`

- [ ] **Step 1: Add the icon name and Lucide mapping**

In `src/ui/icons.tsx`, extend the `IconName` union and the `LUCIDE` map.

Change the type (currently ends `... | 'settings'`):

```ts
export type IconName = 'lock' | 'unlock' | 'edit' | 'check' | 'x' | 'trash' | 'settings' | 'chevronLeft';
```

Add one entry to the `LUCIDE` record (after the `settings` line):

```ts
  settings: ['Settings', 'Settings2', 'Cog'],
  chevronLeft: ['ChevronLeft', 'ArrowLeft'],
```

- [ ] **Step 2: Verify the suite still passes**

Run: `npm test`
Expected: unchanged pass (this file has no direct tests; confirms no syntax break). Do NOT commit.

---

### Task 3: `StationDesignPicker.tsx` overlay

**Files:**
- Create: `src/ui/StationDesignPicker.tsx`

Depends on Task 1 (types) and Task 2 (`chevronLeft`).

- [ ] **Step 1: Create the component**

Create `src/ui/StationDesignPicker.tsx`:

```tsx
/**
 * StationDesignPicker — the overlay that opens from the Appearance "Change"
 * button. Covers the map area with a grid of design tiles; each tile shows an
 * example station (rendered by the design's own renderPreview) and its name.
 * Presentational: all data comes through props. Selecting a tile applies
 * instantly (draw-time) and closes.
 */

import { getStationDesign, type StationDesign, type ExampleStation } from '../render/stationDesigns';
import { Icon } from './icons';

export function StationDesignPicker(props: {
  designs: StationDesign[];
  current: string;
  example: ExampleStation;
  dark: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { designs, current, example, dark, onSelect, onClose } = props;
  const bg = dark ? '#18181b' : '#ffffff';
  const text = dark ? '#e4e4e7' : '#1a1a1a';
  const muted = dark ? '#a1a1aa' : '#6b7280';
  const border = 'rgba(136,136,136,0.35)';
  const exampleBg = dark ? '#2a2d34' : '#f5f2ea';
  return (
    <div
      role="dialog"
      aria-label="Station design"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        background: bg,
        color: text,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          onClick={onClose}
          aria-label="Back"
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}
        >
          <Icon name="chevronLeft" size={18} /> Station design
        </button>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', display: 'inline-flex' }}
        >
          <Icon name="x" />
        </button>
      </div>

      <span style={{ fontSize: 12, color: muted }}>Choose how stations are drawn. Applies instantly.</span>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
        {designs.map((d) => {
          const active = d.id === current;
          return (
            <button
              key={d.id}
              onClick={() => { onSelect(d.id); onClose(); }}
              aria-pressed={active}
              style={{
                border: active ? '2px solid #2563eb' : `0.5px solid ${border}`,
                background: active ? (dark ? 'rgba(37,99,235,0.18)' : '#eff4ff') : 'transparent',
                color: text,
                borderRadius: 10,
                padding: '12px 8px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <span
                style={{ width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', background: exampleBg, borderRadius: 8 }}
                dangerouslySetInnerHTML={{ __html: getStationDesign(d.id).renderPreview(example, dark) }}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</span>
              {active && (
                <span style={{ fontSize: 11, color: '#2563eb', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="check" size={13} /> Selected
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the suite still passes**

Run: `npm test`
Expected: unchanged pass. Do NOT commit.

---

### Task 4: route the smoothed renderer through the registry

**Files:**
- Modify: `src/render/types.ts` (add draw-time `stationDesign?`)
- Modify: `src/render/renderOctilinear.ts` (arg field + dispatch + import swap)
- Modify: `src/render/renderGeographic.ts` (thread through `drawSmoothed`)
- Modify: `src/render/schematic.ts` (`drawSmoothedSchematic` passes it)

Depends on Task 1.

- [ ] **Step 1: `types.ts` — add the draw-time option**

In `src/render/types.ts`, inside `interface SchematicOptions`, add after the `megaFallback?: ...` field (around line 72):

```ts
  /** Which station design (marker style) to draw. Resolved via
   *  render/stationDesigns.ts getStationDesign; unknown/undefined → Classic.
   *  Draw-time only — like megaFallback it never changes the layout and is
   *  excluded from the cache fingerprint. Smoothed/topo modes only for now. */
  stationDesign?: string;
```

- [ ] **Step 2: `renderOctilinear.ts` — swap the import**

In `src/render/renderOctilinear.ts`, replace the line (around 27):

```ts
import { renderStops } from './stops';
```

with:

```ts
import { getStationDesign } from './stationDesigns';
```

(There is exactly one `renderStops(...)` call in this file, updated below; no other reference remains.)

- [ ] **Step 3: `renderOctilinear.ts` — add the arg field**

In `interface RenderRibbonsArgs`, add after the `megaFallback?: 'box' | 'curve';` field (around line 125):

```ts
  /** Station design id (marker style); resolved via getStationDesign, unknown →
   *  Classic. Draw-time only, consumed in paintRibbons. */
  stationDesign?: string;
```

- [ ] **Step 4: `renderOctilinear.ts` — dispatch through the registry**

In `paintRibbons`, replace the single `renderStops(...)` call (around line 3092):

```ts
  const stopParts = renderStops(stopsByNode, dark, membersByNode, degByNode, args.showStations !== false, sceneOut ? stopsPrims : undefined, args.megaFallback ?? 'curve');
```

with:

```ts
  const stopParts = getStationDesign(args.stationDesign).renderStops(
    stopsByNode, dark, membersByNode, degByNode, args.showStations !== false,
    sceneOut ? stopsPrims : undefined, args.megaFallback ?? 'curve',
  );
```

- [ ] **Step 5: `renderGeographic.ts` — thread through `drawSmoothed`**

In `src/render/renderGeographic.ts`, extend the `drawSmoothed` `opts` parameter type (around line 1405):

```ts
  opts: { showLabels: boolean; showStations: boolean; megaFallback?: 'box' | 'curve'; landmass?: LandmassParams; stationDesign?: string },
```

Add `stationDesign` to the `args` object built for `paintRibbons` (after the `megaFallback: opts.megaFallback ?? 'curve',` line, around 1445):

```ts
    megaFallback: opts.megaFallback ?? 'curve',
    stationDesign: opts.stationDesign,
```

And in `renderSmoothed` (single-phase path, around line 1461) pass it from opts:

```ts
  return drawSmoothed(pre, { showLabels: opts.showLabels, showStations: opts.showStations, megaFallback: opts.megaFallback, stationDesign: opts.stationDesign });
```

- [ ] **Step 6: `schematic.ts` — pass it from `drawSmoothedSchematic`**

In `src/render/schematic.ts`, inside `drawSmoothedSchematic`, add `stationDesign` to the object passed to `drawSmoothed` (after the `megaFallback: opts.megaFallback,` line, around 88):

```ts
      megaFallback: opts.megaFallback,
      stationDesign: opts.stationDesign,
```

- [ ] **Step 7: Verify the suite still passes**

Run: `npm test`
Expected: all pass (including `stops.test.ts`, which imports `renderStops` from `../stops` directly and is unaffected). Do NOT commit.

---

### Task 5: wire the row, overlay, and persistence into the panel

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

Depends on Tasks 1, 3, 4.

- [ ] **Step 1: Imports**

At the top of `src/ui/SchematicPanel.tsx`, add:

```ts
import { StationDesignPicker } from './StationDesignPicker';
import { STATION_DESIGNS, getStationDesign, pickExampleRoute, DEFAULT_STATION_DESIGN } from '../render/stationDesigns';
```

- [ ] **Step 2: Extend the `RestoredSettings` type (top-level, around line 218)**

Add a field to the top-level `type RestoredSettings = { ... }`:

```ts
  megaFallback?: 'box' | 'curve';
  stationDesign?: string;
```

- [ ] **Step 3: Add state (near the other visual toggles, around line 274)**

After the `megaFallback` state declaration, add:

```ts
  const [stationDesign, setStationDesign] = useState(rvis.stationDesign ?? DEFAULT_STATION_DESIGN);
  // The design picker overlay (Appearance ▸ Change). Draw-time; instant apply.
  const [designPanelOpen, setDesignPanelOpen] = useState(false);
  // The example station shown in the picker tiles: a representative player route
  // (bullet + colors), recomputed each time the overlay opens.
  const designExample = useMemo(() => pickExampleRoute(api.gameState.getRoutes()), [designPanelOpen]);
```

- [ ] **Step 4: Persist it (the per-mode settings effect, around lines 825 and 828)**

Add `stationDesign` to the `writeModeSettings` payload:

```ts
      writeModeSettings(city, modeRef.current, { showStations, showLabels, megaFallback, landmass, landmassDetail, applied, labelScale, stationDesign });
```

and to that effect's dependency array (the array ending `..., labelScale, mountCity]`):

```ts
  }, [showStations, showLabels, megaFallback, landmass, landmassDetail, applied, rasterScale, jpegQuality, exportFormat, labelScale, stationDesign, mountCity]);
```

- [ ] **Step 5: Load it in `switchMode` (around line 468)**

After `setMegaFallback(v.megaFallback ?? DEFAULT_MEGA_FALLBACK);`, add:

```ts
    setStationDesign(v.stationDesign ?? DEFAULT_STATION_DESIGN);
```

- [ ] **Step 6: Carry it through the one-time migration effect (around line 493)**

In the effect that copies shared settings into each mode, add `stationDesign` to the `visual` object:

```ts
      const visual = { showStations: shared.showStations, showLabels: shared.showLabels, megaFallback: shared.megaFallback, applied: shared.applied, labelScale: shared.labelScale, stationDesign: shared.stationDesign };
```

- [ ] **Step 7: Pass it into the smoothed draw (around line 751)**

Change the `drawSmoothedSchematic` call:

```ts
      const drawn = drawSmoothedSchematic(pre, { showLabels, showStations, megaFallback, landmass, landmassDetail, stationDesign }, out);
```

and add `stationDesign` to that `svg` memo's dependency array (the array around line 764 that lists `..., megaFallback, landmass, landmassDetail, geography, ...`):

```ts
  }, [mode, showStations, showLabels, megaFallback, stationDesign, landmass, landmassDetail, geography, smoothedReady, applied, buildInput]);
```

- [ ] **Step 8: Include it in the saved-map settings (`exportMap`, around line 993)**

```ts
    const settings = { mode, showStations, showLabels, megaFallback, landmass, landmassDetail, applied, rasterScale, jpegQuality, exportFormat, labelScale, stationDesign };
```

- [ ] **Step 9: Restore it in `applyBundle` (around lines 1031 and 1064)**

Add to the inline `s` type (the `const s = (bundle.settings ?? {}) as { ... }`):

```ts
      megaFallback?: 'box' | 'curve';
      stationDesign?: string;
```

And add a setter alongside the other `s.*` applies (after the `setMegaFallback` line, around 1063):

```ts
    if (typeof s.stationDesign === 'string') setStationDesign(STATION_DESIGNS.some((d) => d.id === s.stationDesign) ? s.stationDesign : DEFAULT_STATION_DESIGN);
```

- [ ] **Step 10: Add the "Station design" row in the Appearance popover (around line 1936)**

Immediately after the `Appearance` header `</span>` (the `<span ...>Appearance</span>` around line 1934-1936) and BEFORE the `<Slider label="Line thickness" ...>`, insert:

```tsx
              {/* Station design: the marker style. Draw-time (instant repaint),
                  like Label size. Opens the picker overlay. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>Station design</span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{getStationDesign(stationDesign).name}</span>
                </span>
                <button
                  onClick={() => { setDesignPanelOpen(true); setSettingsOpen(false); }}
                  title="Change station design"
                  style={{ fontSize: 12, fontWeight: 600, color: '#ffffff', background: '#2563eb', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}
                >
                  Change
                </button>
              </div>
```

- [ ] **Step 11: Mount the overlay inside the panel root**

Locate the outermost element the component returns (the `<div ref={rootRef} ...>`). Ensure its inline `style` includes `position: 'relative'` (add it if absent — the overlay is `position: absolute; inset: 0`). As the LAST child of that root div (just before its closing `</div>`), add:

```tsx
      {designPanelOpen && (
        <StationDesignPicker
          designs={STATION_DESIGNS}
          current={stationDesign}
          example={designExample}
          dark={api.ui.getResolvedTheme() === 'dark'}
          onSelect={setStationDesign}
          onClose={() => setDesignPanelOpen(false)}
        />
      )}
```

- [ ] **Step 12: Verify the suite still passes and the build is clean**

Run: `npm test`
Expected: all pass.

Run: `npm run build` (or the project's build script — check `package.json` `scripts`; it uses `vite build`).
Expected: build succeeds (esbuild transpile-only; pre-existing `tsc` type errors are NOT a gate). Do NOT commit.

---

### Task 6: final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: green, including the new `stationDesigns.test.ts`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Summary**

Report the created/modified files and the passing test count. Leave everything uncommitted for the user to review.

---

## Self-review notes

- **Spec coverage:** row (T5.10), current name (T5.10), blue Change button (T5.10), overlay grid (T3), example from route + A/red default (T1 `pickExampleRoute`/defaults, T5.3), registry drives smoothed render (T4), per-mode persistence (T5.4/5/6), saved-map round-trip (T5.8/9), Classic-only + byte-identical dispatch (T1 parity test), draw-time/no-fingerprint (T4.1 doc + fingerprint already selective). Geographic mode intentionally deferred (spec Non-goals).
- **Types:** `StationDesign`, `ExampleStation`, `RenderStopsFn`, `getStationDesign`, `pickExampleRoute`, `STATION_DESIGNS`, `DEFAULT_STATION_DESIGN`, `EXAMPLE_STATION_DEFAULT` are defined in Task 1 and referenced consistently in Tasks 3–5. `renderPreview(ex, dark)` signature is consistent between T1 (definition), T1 test, and T3 (call).
- **No commits** anywhere (project rule); each task ends on `npm test`.
