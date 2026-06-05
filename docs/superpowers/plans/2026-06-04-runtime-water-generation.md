# Runtime Water Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the geographic water layer at runtime from each city's `ocean_depth_index` so the background appears in all three render modes, and fix the dark-theme land color.

**Architecture:** A pure geometry pipeline under `src/water/` (mask → marching-squares boundary → Douglas-Peucker + Chaikin smoothing → geographic `WaterCollection`), plus a thin runtime loader (`fetch` + `DecompressionStream`) and panel wiring (generate on first open, cache by city). No renderer changes beyond colors — all modes already consume `WaterCollection`.

**Tech Stack:** TypeScript, `node --test` via tsx, pnpm, browser `fetch`/`DecompressionStream` in-game.

**Spec:** `docs/superpowers/specs/2026-06-04-runtime-water-generation-design.md`

**Verified facts (do not re-derive):**
- `ocean_depth_index.json.gz` decoded: `{ cs, bbox:[minLng,minLat,maxLng,maxLat], grid:[W,H], cells:[[col,row,...depthIdx]], depths, stats }`.
- `cells` = sparse list of water grid cells. NYC: grid `[185,187]`, 13,062 water cells.
- **Row 0 = south (minLat)**; latitude increases with row (verified: Atlantic-south band has 3.5× the water cells of the north band).
- Corner→geo: for corner `(cx,cy)`, `cx∈[0,W] cy∈[0,H]`: `lng = minLng + (cx/W)*(maxLng-minLng)`, `lat = minLat + (cy/H)*(maxLat-minLat)`.
- Renderers fill water with `fill-rule="evenodd"`, so **one feature containing all rings** yields correct land-holes — no explicit nesting needed.

---

## File structure

```
src/water/
  types.ts            # OceanIndex type
  grid.ts             # buildWaterMask(index) -> WaterGrid { mask, W, H, cornerToGeo }
  marchingSquares.ts  # traceRings(grid) -> Ring[]  (closed corner-space loops)
  simplify.ts         # douglasPeucker, chaikin
  generate.ts         # generateWaterFromIndex(index) -> WaterCollection   (pure)
  oceanIndex.ts       # fetchOceanIndex(cityCode), generateWater(cityCode)  (runtime, cached)
src/render/types.ts        # MODIFY: dark land/water colors
src/render/renderGeographic.ts  # MODIFY: already reads dark colors — confirm
src/render/renderOctilinear.ts  # MODIFY: dark water color already present — confirm
src/ui/SchematicPanel.tsx  # MODIFY: fetch+generate water on first open, cache, state
dev/water-test.ts          # NEW: generate NYC water from disk, compare to nyc_water.geojson
```

---

## Task 1: OceanIndex type + water grid

**Files:**
- Create: `src/water/types.ts`, `src/water/grid.ts`
- Test: `src/water/grid.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterMask } from './grid';
import type { OceanIndex } from './types';

const idx: OceanIndex = {
  cs: 1,
  bbox: [-74, 40, -73, 41], // 1°x1°
  grid: [2, 2],
  cells: [[0, 0], [1, 0]], // bottom row water
  depths: [],
  stats: {},
};

test('buildWaterMask marks listed cells as water', () => {
  const g = buildWaterMask(idx);
  assert.equal(g.W, 2);
  assert.equal(g.H, 2);
  assert.equal(g.mask[0 * 2 + 0], 1);
  assert.equal(g.mask[0 * 2 + 1], 1);
  assert.equal(g.mask[1 * 2 + 0], 0);
});

test('cornerToGeo maps grid corners to bbox corners (row 0 = south)', () => {
  const g = buildWaterMask(idx);
  assert.deepEqual(g.cornerToGeo(0, 0), [-74, 40]); // SW
  assert.deepEqual(g.cornerToGeo(2, 2), [-73, 41]); // NE
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./grid` not found.

- [ ] **Step 3: Implement**

```ts
// src/water/types.ts
export interface OceanIndex {
  cs: number;
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  grid: [number, number];                 // [W, H]
  cells: number[][];                      // [col, row, ...depthIdx]
  depths?: unknown[];
  stats?: unknown;
}
```

```ts
// src/water/grid.ts
import type { OceanIndex } from './types';

export interface WaterGrid {
  mask: Uint8Array; // length W*H, 1 = water; index r*W + c
  W: number;
  H: number;
  cornerToGeo(cx: number, cy: number): [number, number]; // cx∈[0,W], cy∈[0,H]
}

export function buildWaterMask(index: OceanIndex): WaterGrid {
  const [W, H] = index.grid;
  const [minLng, minLat, maxLng, maxLat] = index.bbox;
  const mask = new Uint8Array(W * H);
  for (const cell of index.cells) {
    const c = cell[0];
    const r = cell[1];
    if (c >= 0 && c < W && r >= 0 && r < H) mask[r * W + c] = 1;
  }
  const cornerToGeo = (cx: number, cy: number): [number, number] => [
    minLng + (cx / W) * (maxLng - minLng),
    minLat + (cy / H) * (maxLat - minLat),
  ];
  return { mask, W, H, cornerToGeo };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/water/types.ts src/water/grid.ts src/water/grid.test.ts
git commit -m "feat(water): ocean index type + water mask grid"
```

---

## Task 2: Marching-squares boundary tracing

**Files:**
- Create: `src/water/marchingSquares.ts`
- Test: `src/water/marchingSquares.test.ts`

Method: directed boundary edges with **water-on-left**, stitched into closed rings. For a
water cell `(c,r)` occupying corner-square `[c,c+1]×[r,r+1]`, emit a directed edge for each
side whose neighbor is non-water:
- bottom (neighbor `(c,r-1)`): `(c,r) → (c+1,r)`
- right  (neighbor `(c+1,r)`): `(c+1,r) → (c+1,r+1)`
- top    (neighbor `(c,r+1)`): `(c+1,r+1) → (c,r+1)`
- left   (neighbor `(c-1,r)`): `(c,r+1) → (c,r)`

Each edge's start corner maps to its end corner; follow the chain from each unused edge until
it returns to the start = one ring. (Orientation is irrelevant — renderers use evenodd.)

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRings } from './marchingSquares';
import { buildWaterMask } from './grid';
import type { OceanIndex } from './types';

function idx(W: number, H: number, cells: number[][]): OceanIndex {
  return { cs: 1, bbox: [0, 0, W, H], grid: [W, H], cells, depths: [], stats: {} };
}

test('single water cell → one 4-corner ring', () => {
  const rings = traceRings(buildWaterMask(idx(3, 3, [[1, 1]])));
  assert.equal(rings.length, 1);
  // ring is closed (first === last) and has 5 points (4 corners + close)
  const r = rings[0];
  assert.deepEqual(r[0], r[r.length - 1]);
  assert.equal(r.length, 5);
});

test('water square with a land hole → two rings (outer + hole)', () => {
  // 3x3 water with center land
  const cells: number[][] = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) if (!(c === 1 && r === 1)) cells.push([c, r]);
  const rings = traceRings(buildWaterMask(idx(3, 3, cells)));
  assert.equal(rings.length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./marchingSquares` not found.

- [ ] **Step 3: Implement**

```ts
// src/water/marchingSquares.ts
import type { WaterGrid } from './grid';

export type Corner = [number, number]; // grid-corner coords (cx, cy)
export type Ring = Corner[];           // closed: first === last

const key = (x: number, y: number) => x + ',' + y;

export function traceRings(grid: WaterGrid): Ring[] {
  const { mask, W, H } = grid;
  const water = (c: number, r: number) => c >= 0 && c < W && r >= 0 && r < H && mask[r * W + c] === 1;

  // directed edges, water on left
  const edges = new Map<string, Corner>(); // startKey -> end corner
  const starts: Corner[] = [];
  const add = (sx: number, sy: number, ex: number, ey: number) => {
    edges.set(key(sx, sy), [ex, ey]);
    starts.push([sx, sy]);
  };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!water(c, r)) continue;
      if (!water(c, r - 1)) add(c, r, c + 1, r);         // bottom
      if (!water(c + 1, r)) add(c + 1, r, c + 1, r + 1); // right
      if (!water(c, r + 1)) add(c + 1, r + 1, c, r + 1); // top
      if (!water(c - 1, r)) add(c, r + 1, c, r);         // left
    }
  }

  const used = new Set<string>();
  const rings: Ring[] = [];
  for (const s of starts) {
    const sk = key(s[0], s[1]);
    if (used.has(sk)) continue;
    const ring: Ring = [s];
    let curKey = sk;
    let cur = s;
    while (true) {
      used.add(curKey);
      const next = edges.get(curKey);
      if (!next) break;
      ring.push(next);
      curKey = key(next[0], next[1]);
      cur = next;
      if (curKey === sk) break;
      if (used.has(curKey)) break;
    }
    void cur;
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/water/marchingSquares.ts src/water/marchingSquares.test.ts
git commit -m "feat(water): marching-squares boundary tracing"
```

---

## Task 3: Simplify (Douglas-Peucker + Chaikin)

**Files:**
- Create: `src/water/simplify.ts`
- Test: `src/water/simplify.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { douglasPeucker, chaikin } from './simplify';

test('douglasPeucker drops a collinear midpoint', () => {
  const pts: [number, number][] = [[0, 0], [1, 0], [2, 0]];
  const out = douglasPeucker(pts, 0.01);
  assert.deepEqual(out, [[0, 0], [2, 0]]);
});

test('douglasPeucker keeps a sharp corner', () => {
  const pts: [number, number][] = [[0, 0], [1, 1], [2, 0]];
  assert.equal(douglasPeucker(pts, 0.5).length, 3);
});

test('chaikin rounds a corner and keeps endpoints of an open path', () => {
  const pts: [number, number][] = [[0, 0], [1, 0], [1, 1]];
  const out = chaikin(pts, 1, false);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [1, 1]);
  assert.ok(out.length > pts.length);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./simplify` not found.

- [ ] **Step 3: Implement**

```ts
// src/water/simplify.ts
export type Pt = [number, number];

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Ramer–Douglas–Peucker on an open polyline. */
export function douglasPeucker(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = douglasPeucker(pts.slice(0, idx + 1), eps);
  const right = douglasPeucker(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Chaikin corner-cutting. `closed` keeps the loop; open keeps endpoints. */
export function chaikin(pts: Pt[], iterations: number, closed: boolean): Pt[] {
  let out = pts.slice();
  for (let it = 0; it < iterations; it++) {
    const next: Pt[] = [];
    if (!closed) next.push(out[0]);
    const n = out.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = out[i];
      const b = out[(i + 1) % n];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(out[n - 1]);
    out = next;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/water/simplify.ts src/water/simplify.test.ts
git commit -m "feat(water): polyline simplify + chaikin smoothing"
```

---

## Task 4: Generate WaterCollection (pure core)

**Files:**
- Create: `src/water/generate.ts`
- Test: `src/water/generate.test.ts`

Pipeline: `buildWaterMask` → `traceRings` → per ring: `douglasPeucker(eps=0.75)` then
`chaikin(2, closed)` in corner space → map corners to geo via `cornerToGeo` → collect all rings
into **one** `Polygon` feature (evenodd handles holes). Drop rings with < 3 points after simplify.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWaterFromIndex } from './generate';
import type { OceanIndex } from './types';

test('generateWaterFromIndex makes a geographic polygon from water cells', () => {
  const idx: OceanIndex = {
    cs: 1, bbox: [-74, 40, -72, 42], grid: [2, 2],
    cells: [[0, 0]], depths: [], stats: {},
  };
  const wc = generateWaterFromIndex(idx);
  assert.equal(wc.type, 'FeatureCollection');
  assert.ok(wc.features.length >= 1);
  const ring = wc.features[0].geometry.coordinates[0];
  // all coords within bbox
  for (const [lng, lat] of ring) {
    assert.ok(lng >= -74 - 1e-9 && lng <= -72 + 1e-9);
    assert.ok(lat >= 40 - 1e-9 && lat <= 42 + 1e-9);
  }
});

test('generateWaterFromIndex returns empty collection for no water', () => {
  const idx: OceanIndex = { cs: 1, bbox: [0, 0, 1, 1], grid: [2, 2], cells: [], depths: [], stats: {} };
  const wc = generateWaterFromIndex(idx);
  assert.equal(wc.features.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — module `./generate` not found.

- [ ] **Step 3: Implement**

```ts
// src/water/generate.ts
import type { OceanIndex } from './types';
import type { WaterCollection, WaterFeature } from '../render/types';
import { buildWaterMask } from './grid';
import { traceRings } from './marchingSquares';
import { douglasPeucker, chaikin, type Pt } from './simplify';

const DP_EPS = 0.75;       // corner units (~¾ cell)
const CHAIKIN_PASSES = 2;

export function generateWaterFromIndex(index: OceanIndex): WaterCollection {
  const grid = buildWaterMask(index);
  const rings = traceRings(grid);
  const geoRings: [number, number][][] = [];
  for (const ring of rings) {
    // ring is closed (first===last); simplify on the open form then re-close
    const open = ring.slice(0, -1) as Pt[];
    if (open.length < 3) continue;
    const dp = douglasPeucker(open, DP_EPS);
    if (dp.length < 3) continue;
    const smooth = chaikin(dp, CHAIKIN_PASSES, true);
    const geo = smooth.map(([cx, cy]) => grid.cornerToGeo(cx, cy));
    geo.push(geo[0]); // close
    geoRings.push(geo);
  }
  const features: WaterFeature[] = geoRings.length
    ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: geoRings } }]
    : [];
  return { type: 'FeatureCollection', features };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/water/generate.ts src/water/generate.test.ts
git commit -m "feat(water): generate WaterCollection from ocean index"
```

---

## Task 5: Runtime loader (fetch + gunzip + cache)

**Files:**
- Create: `src/water/oceanIndex.ts`

No unit test (browser `fetch`/`DecompressionStream`); validated via the dev harness (Task 6)
and in-game (Task 8).

- [ ] **Step 1: Implement**

```ts
// src/water/oceanIndex.ts
import type { OceanIndex } from './types';
import type { WaterCollection } from '../render/types';
import { generateWaterFromIndex } from './generate';

const api = window.SubwayBuilderAPI;
const cache = new Map<string, WaterCollection | null>();

async function fetchOceanIndex(cityCode: string): Promise<OceanIndex | null> {
  const files = api.cities.getCityDataFiles(cityCode);
  const url = files?.oceanDepthIndex;
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    let text: string;
    if (url.endsWith('.gz')) {
      const ds = new DecompressionStream('gzip');
      const stream = res.body!.pipeThrough(ds);
      text = await new Response(stream).text();
    } else {
      text = await res.text();
    }
    return JSON.parse(text) as OceanIndex;
  } catch (err) {
    console.warn('[ImprovedSchematics] ocean index load failed:', err);
    return null;
  }
}

/** Generate (and cache) the water layer for a city. Null if unavailable. */
export async function generateWater(cityCode: string): Promise<WaterCollection | null> {
  if (cache.has(cityCode)) return cache.get(cityCode)!;
  const index = await fetchOceanIndex(cityCode);
  const water = index ? generateWaterFromIndex(index) : null;
  cache.set(cityCode, water);
  return water;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/water/oceanIndex.ts
git commit -m "feat(water): runtime ocean-index loader with cache"
```

---

## Task 6: Dev harness — generate NYC water + compare

**Files:**
- Create: `dev/water-test.ts`

- [ ] **Step 1: Implement**

```ts
// dev/water-test.ts
import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { generateWaterFromIndex } from '../src/water/generate';
import type { OceanIndex } from '../src/water/types';

const city = process.argv[2] ?? 'NYC';
const gz = join(process.env.APPDATA!, 'metro-maker4', 'cities', 'data', city, 'ocean_depth_index.json.gz');
const index = JSON.parse(gunzipSync(readFileSync(gz)).toString()) as OceanIndex;

const wc = generateWaterFromIndex(index);
writeFileSync('dev/water-out.geojson', JSON.stringify(wc));

const rings = wc.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
let pts = 0;
for (const f of wc.features) for (const r of f.geometry.coordinates) pts += r.length;
console.log(`${city}: ${wc.features.length} features, ${rings} rings, ${pts} points`);
console.log(`index bbox: ${index.bbox.join(', ')}`);
```

- [ ] **Step 2: Run it**

Run: `pnpm exec tsx dev/water-test.ts`
Expected: prints feature/ring/point counts; writes `dev/water-out.geojson`. Sanity: rings in
the low tens–low hundreds, points bounded (smoothing keeps it reasonable). If the count is huge
(thousands of rings), increase `DP_EPS`.

- [ ] **Step 3: Visual check via the schematic harness**

Run: `pnpm exec tsx dev/render-test.ts "$APPDATA\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\new_york_freeplay_590fec73.json" dev/water-out.geojson`
Then rasterize `dev/out-geo.svg` → PNG and confirm the generated coastline matches NYC (Hudson,
East River, harbor) and is not vertically flipped. If flipped, the row orientation is wrong —
but it has been verified as row 0 = south, so this should be correct.

- [ ] **Step 4: Commit**

```bash
git add dev/water-test.ts
git commit -m "test(water): dev harness generating city water from ocean index"
```

---

## Task 7: Dark-theme land/water colors

**Files:**
- Modify: `src/render/types.ts`

The renderers already branch on `dark` for land (`#18181b`) and water (`#1e3a4a`); the problem
is the dark land is indistinguishable from the panel. Lighten it so the map area reads as land.

- [ ] **Step 1: Add explicit dark theme colors**

In `src/render/types.ts`, add a dark palette and export it:

```ts
export const DARK_THEME: SchematicTheme = {
  ...DEFAULT_THEME,
  land: '#2a2d34',   // visibly lighter than the panel (#18181b-ish)
  water: '#24506b',
  stationFill: '#1b1b1f',
  stationStroke: '#cccccc',
};
```

- [ ] **Step 2: Use it in both renderers**

In `renderGeographic.ts` and `renderOctilinear.ts`, when `dark` is true, source land/water from
`DARK_THEME` instead of the hardcoded `#18181b`/`#1e3a4a`. (Replace the two local `const land =`/
`const water =`/`bg =` expressions accordingly.)

- [ ] **Step 3: Build + render check**

Run: `pnpm typecheck && pnpm test && pnpm exec tsx dev/render-test.ts "$APPDATA\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\new_york_freeplay_590fec73.json" dev/water-out.geojson`
Expected: passes; geographic/octi SVGs show a distinct land color.

- [ ] **Step 4: Commit**

```bash
git add src/render/types.ts src/render/renderGeographic.ts src/render/renderOctilinear.ts
git commit -m "feat(render): visible dark-theme land/water palette"
```

---

## Task 8: Panel integration — generate water on first open

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

- [ ] **Step 1: Resolve the current city code**

Add a hook to capture the current city. In `SchematicPanel`, read it from the API. The mod's
`main.ts` registers via `onMapReady`; the city code is available from `api.hooks.onCityLoad`
(value passed to the callback). Capture it module-side in `main.ts` and expose it, or read the
current city from the API if available. Implementation:

In `src/main.ts`, record the latest city code:

```ts
export const modState: { cityCode: string | null } = { cityCode: null };
api.hooks.onCityLoad((cityCode) => { modState.cityCode = cityCode; });
```

- [ ] **Step 2: Fetch + store water on mount**

In `SchematicPanel.tsx`:

```ts
import { useMemo, useRef, useEffect, useState } from 'react';
import { generateSchematicSVG } from '../render/schematic';
import type { RenderMode, WaterCollection } from '../render/types';
import { generateWater } from '../water/oceanIndex';
import { modState } from '../main';

// inside the component, replace the `water` constant:
const [water, setWater] = useState<WaterCollection | undefined>(undefined);
useEffect(() => {
  const city = modState.cityCode;
  if (!city) return;
  let alive = true;
  generateWater(city).then((wc) => { if (alive && wc) setWater(wc); });
  return () => { alive = false; };
}, []);
```

Keep `water` in the existing `useMemo` dependency array so the SVG regenerates when it arrives.

- [ ] **Step 3: Build + typecheck**

Run: `pnpm typecheck && pnpm build`
Expected: PASS; `dist/index.js` rebuilt.

- [ ] **Step 4: Commit**

```bash
git add src/ui/SchematicPanel.tsx src/main.ts
git commit -m "feat(ui): generate + show water on first panel open"
```

---

## Task 9: Verify in game

- [ ] **Step 1: Relink + launch**

Run: `pnpm dev:link` then `pnpm exec tsx scripts/run.ts` (background). Load a coastal city
(e.g. NYC) and build a route.

- [ ] **Step 2: Confirm**

Open the Improved Schematic panel. Confirm: land is a visible color; after a moment, water
appears (coastline) in Geographic and Smoothed (aligned) and as a backdrop in Schematic. Check
`debug/latest.log` for no `ocean index load failed` errors and no exceptions.

- [ ] **Step 3: Final commit (any fixes)**

```bash
git add -A
git commit -m "chore: runtime water generation verified in game"
```

---

## Self-review notes

- **Spec coverage:** access/decode (Task 5), mask (Task 1), marching squares (Task 2),
  DP+Chaikin smoothing (Task 3), generate→WaterCollection (Task 4), runtime cache (Task 5),
  panel-on-first-open (Task 8), dark-land fix (Task 7), harness/compare (Task 6), error handling
  (Task 5 returns null; Task 4 empty collection). All covered.
- **Deviation from spec (intentional):** ring nesting / `signedArea` dropped — all rings go into
  one evenodd polygon, which the renderers already fill correctly. Simpler and correct.
- **Type consistency:** `OceanIndex`, `WaterGrid`, `Ring`/`Corner`, `Pt`, and `WaterCollection`/
  `WaterFeature` (from `src/render/types.ts`) are defined once and reused. `generateWaterFromIndex`
  (pure) vs `generateWater` (runtime) names are consistent across Tasks 4/5/6/8.
- **Calibration risk:** `DP_EPS`/`CHAIKIN_PASSES` are tunable in Task 6 if the output is too
  coarse or too heavy; row orientation is pre-verified (row 0 = south).
```
