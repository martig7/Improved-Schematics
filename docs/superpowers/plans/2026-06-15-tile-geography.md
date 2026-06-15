# Tile-derived Geography (water + parks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render crisp water/coastline + parks/green space sourced from the game's live MapLibre vector tiles as a distortable SVG backdrop beneath the transit network.

**Architecture:** A new `src/geography/` module probes the running game's MapLibre style for a usable OSM-style vector source, harvests `water` + land-use/green features for the city bbox via an offscreen MapLibre map + `querySourceFeatures`, classifies them into `water`/`green` polygon collections in `[lng,lat]`, and caches per city. The renderer draws them through the **same** (warped, in smoothed mode) projection the network uses, so geography distorts for free. If anything fails, the single fallback is to render no backdrop.

**Tech Stack:** TypeScript, MapLibre GL (runtime borrowed from the live game map — never bundled), `node:test` + `node:assert/strict`, Vite (IIFE bundle).

**Key facts (verified on `master`):**
- Test runner: `npm test` → `tsx --test "src/**/*.test.ts"`. Single file: `npx tsx --test <path>`. Typecheck: `npm run typecheck` → `tsc --noEmit`.
- `Coordinate = [lng, lat]`, `BoundingBox = [minLng, minLat, maxLng, maxLat]` (`src/types/core.d.ts`).
- `api.utils.getMap(): maplibregl.Map | null`; `maplibregl` is an **ambient type only** — no maplibre runtime is imported anywhere in `src/`. The offscreen map borrows the constructor from the live instance (`gameMap.constructor`).
- Water is rendered today by `waterGroup(water, proj, fill)` at three sites in `src/render/renderGeographic.ts`: pure `renderGeographic` (~line 274), `renderGeographicTopo` (~line 373), and `precomputeSmoothed` (~line 667, the **warped** `proj`). The base land rect is owned by the renderer/`renderRibbons`, not the water group.
- Theme colors live in `SchematicTheme` (`src/render/types.ts`): `land`, `water`, … (not top-level options).

---

## File Structure

**Create:**
- `src/geography/types.ts` — `GeoPolyFeature`, `GeographyData`, `GeoSchema`, `GeoCategory`, `TaggedFeature`.
- `src/geography/normalize.ts` — `toPolyFeatures()` (GeoJSON Polygon/MultiPolygon → `GeoPolyFeature[]`).
- `src/geography/schemaProbe.ts` — `probeVectorSchema(style)` → `ProbeResult | null`.
- `src/geography/classify.ts` — `classifyFeature()`, `bucketFeatures()`.
- `src/geography/harvest.ts` — `harvestTaggedFeatures(map, probe, bbox)` (offscreen MapLibre; integration).
- `src/geography/geography.ts` — `generateGeography(cityCode, bbox, deps?)` (cached orchestrator).
- `src/render/geographyBackdrop.ts` — `polyGroup()`, `geographyBackdrop()`.
- Test files alongside each pure module.

**Modify:**
- `src/render/types.ts` — add `green` to `SchematicTheme`, `DEFAULT_THEME`, `DARK_THEME`.
- `src/render/renderGeographic.ts` — add `geography?` to `GeoInput`; replace the 3 `waterGroup(input.water,…)` sites with `geographyBackdrop(input.geography,…)`; remove the now-unused local `waterGroup` and water-color consts.
- `src/render/schematic.ts` — add `geography?` to `SchematicInput`.
- `src/ui/SchematicPanel.tsx` — load `geography` (replacing the `water` load), pass it into the render input, key the caches on it.

**Left untouched (per spec):** `src/water/*` stays in the tree but the geographic/smoothed paths no longer call it. `renderOctilinear.ts` (schematic mode, not reachable from the panel's mode selector) keeps using `input.water`.

---

## Task 1: Geography types + feature normalizer

**Files:**
- Create: `src/geography/types.ts`
- Create: `src/geography/normalize.ts`
- Test: `src/geography/normalize.test.ts`

- [ ] **Step 1: Create the shared types**

Create `src/geography/types.ts`:

```ts
import type { Coordinate, BoundingBox } from '../types/core';

/** Which OSM vector-tile schema the game's basemap uses. */
export type GeoSchema = 'openmaptiles' | 'protomaps' | 'mapbox';

/** Geography category we keep; everything else is dropped. */
export type GeoCategory = 'water' | 'green';

/** A single-ring-set polygon feature in geographic coords (first ring exterior, rest holes). */
export interface GeoPolyFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Coordinate[][] };
}

/** Tile-derived geography for one city, ready to project + render. */
export interface GeographyData {
  bbox: BoundingBox;
  water: GeoPolyFeature[];
  green: GeoPolyFeature[];
}

/** A raw harvested feature tagged with the source-layer it came from. */
export interface TaggedFeature {
  sourceLayer: string;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
```

- [ ] **Step 2: Write the failing test**

Create `src/geography/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPolyFeatures } from './normalize';

test('toPolyFeatures: keeps a Polygon as one feature', () => {
  const out = toPolyFeatures([
    { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].geometry.type, 'Polygon');
  assert.deepEqual(out[0].geometry.coordinates[0][1], [1, 0]);
});

test('toPolyFeatures: splits a MultiPolygon into one feature per polygon', () => {
  const out = toPolyFeatures([
    {
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[2, 2], [3, 2], [3, 3], [2, 2]]],
        ],
      },
    },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].geometry.coordinates[0][0], [2, 2]);
});

test('toPolyFeatures: drops non-polygon geometry', () => {
  const out = toPolyFeatures([
    { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ]);
  assert.equal(out.length, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test src/geography/normalize.test.ts`
Expected: FAIL — `Cannot find module './normalize'`.

- [ ] **Step 4: Write the implementation**

Create `src/geography/normalize.ts`:

```ts
import type { Coordinate } from '../types/core';
import type { GeoPolyFeature, TaggedFeature } from './types';

type GeomInput = Pick<TaggedFeature, 'geometry'>;

/** Flatten GeoJSON Polygon/MultiPolygon geometries into single-Polygon features.
 *  Non-polygon geometries (points, lines) are dropped. */
export function toPolyFeatures(items: GeomInput[]): GeoPolyFeature[] {
  const out: GeoPolyFeature[] = [];
  for (const it of items) {
    const geom = it.geometry;
    if (geom.type === 'Polygon') {
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: geom.coordinates as Coordinate[][] } });
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as Coordinate[][][]) {
        out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly } });
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/geography/normalize.test.ts`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/geography/types.ts src/geography/normalize.ts src/geography/normalize.test.ts
git commit -m "feat(geography): types + Polygon/MultiPolygon normalizer"
```

---

## Task 2: Schema probe

Detects whether the game's MapLibre style has a usable OSM-style vector source and which source-layers carry water + green.

**Files:**
- Create: `src/geography/schemaProbe.ts`
- Test: `src/geography/schemaProbe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/geography/schemaProbe.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeVectorSchema } from './schemaProbe';

test('probeVectorSchema: recognizes an OpenMapTiles-style source', () => {
  const style = {
    sources: { osm: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      { source: 'osm', 'source-layer': 'water' },
      { source: 'osm', 'source-layer': 'landcover' },
      { source: 'osm', 'source-layer': 'landuse' },
    ],
  };
  const r = probeVectorSchema(style);
  assert.ok(r);
  assert.equal(r!.sourceId, 'osm');
  assert.equal(r!.schema, 'openmaptiles');
  assert.ok(r!.sourceLayers.includes('water'));
  assert.ok(r!.sourceLayers.includes('landcover'));
});

test('probeVectorSchema: recognizes a Protomaps-style source by its natural layer', () => {
  const style = {
    sources: { proto: { type: 'vector', url: 'pmtiles://x' } },
    layers: [
      { source: 'proto', 'source-layer': 'water' },
      { source: 'proto', 'source-layer': 'natural' },
    ],
  };
  const r = probeVectorSchema(style);
  assert.ok(r);
  assert.equal(r!.schema, 'protomaps');
  assert.ok(r!.sourceLayers.includes('natural'));
});

test('probeVectorSchema: returns null for a raster-only style', () => {
  const style = {
    sources: { sat: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'] } },
    layers: [{ source: 'sat' }],
  };
  assert.equal(probeVectorSchema(style), null);
});

test('probeVectorSchema: returns null when a vector source lacks water', () => {
  const style = {
    sources: { v: { type: 'vector', tiles: ['x'] } },
    layers: [{ source: 'v', 'source-layer': 'transportation' }],
  };
  assert.equal(probeVectorSchema(style), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/geography/schemaProbe.test.ts`
Expected: FAIL — `Cannot find module './schemaProbe'`.

- [ ] **Step 3: Write the implementation**

Create `src/geography/schemaProbe.ts`:

```ts
import type { GeoSchema } from './types';

/** Minimal read-only view of a MapLibre style (we only read sources + layers). */
export interface StyleLike {
  sources?: Record<string, { type?: string; [k: string]: unknown }>;
  layers?: Array<{ source?: string; 'source-layer'?: string }>;
}

export interface ProbeResult {
  sourceId: string;
  /** The vector source spec copied verbatim from the style (for the offscreen map). */
  source: unknown;
  schema: GeoSchema;
  /** Source-layers to query (water + green layers present in the style). */
  sourceLayers: string[];
}

/** Ordered so the most specific signature wins. `collect` lists every green
 *  source-layer to query; `requireAny` is the discriminator that must be present
 *  for the schema to match (so Protomaps's `natural` distinguishes it from the
 *  OpenMapTiles/Mapbox `landuse` schemas, which classify identically anyway). */
const SIGNATURES: Array<{ schema: GeoSchema; water: string[]; collect: string[]; requireAny: string[] }> = [
  { schema: 'protomaps', water: ['water'], collect: ['natural', 'landuse'], requireAny: ['natural'] },
  { schema: 'openmaptiles', water: ['water'], collect: ['landcover', 'park', 'landuse'], requireAny: ['landcover', 'park'] },
  { schema: 'mapbox', water: ['water'], collect: ['landuse', 'landcover'], requireAny: ['landuse', 'landcover'] },
];

/** Find the first vector source whose layers match a known OSM schema. */
export function probeVectorSchema(style: StyleLike): ProbeResult | null {
  const sources = style.sources ?? {};
  for (const [sourceId, src] of Object.entries(sources)) {
    if (!src || src.type !== 'vector') continue;
    const present = new Set<string>();
    for (const l of style.layers ?? []) {
      if (l.source === sourceId && l['source-layer']) present.add(l['source-layer']!);
    }
    for (const sig of SIGNATURES) {
      const hasWater = sig.water.some((w) => present.has(w));
      const discriminates = sig.requireAny.some((g) => present.has(g));
      if (!hasWater || !discriminates) continue;
      const greens = sig.collect.filter((g) => present.has(g));
      const sourceLayers = [...new Set([...sig.water.filter((w) => present.has(w)), ...greens])];
      return { sourceId, source: src, schema: sig.schema, sourceLayers };
    }
  }
  return null;
}
```

Note: `requireAny` is the discriminator — Protomaps is matched by its unique `natural` layer; OpenMapTiles/Mapbox both use `landuse`+`class` and classify identically downstream, so a mix-up between those two is harmless.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/geography/schemaProbe.test.ts`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/geography/schemaProbe.ts src/geography/schemaProbe.test.ts
git commit -m "feat(geography): probe MapLibre style for an OSM vector source"
```

---

## Task 3: Classify + bucket features

**Files:**
- Create: `src/geography/classify.ts`
- Test: `src/geography/classify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/geography/classify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFeature, bucketFeatures } from './classify';
import type { TaggedFeature } from './types';

test('classifyFeature: water source-layer is always water', () => {
  assert.equal(classifyFeature('water', {}, 'openmaptiles'), 'water');
});

test('classifyFeature: green land-cover/use values map to green', () => {
  assert.equal(classifyFeature('landcover', { class: 'wood' }, 'openmaptiles'), 'green');
  assert.equal(classifyFeature('natural', { 'pmap:kind': 'forest' }, 'protomaps'), 'green');
  assert.equal(classifyFeature('landuse', { class: 'park' }, 'mapbox'), 'green');
  assert.equal(classifyFeature('park', {}, 'openmaptiles'), 'green');
});

test('classifyFeature: non-green land-use is dropped', () => {
  assert.equal(classifyFeature('landuse', { class: 'residential' }, 'mapbox'), null);
  assert.equal(classifyFeature('transportation', {}, 'openmaptiles'), null);
});

test('bucketFeatures: splits + normalizes into water/green polygon sets', () => {
  const feats: TaggedFeature[] = [
    { sourceLayer: 'water', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { sourceLayer: 'landuse', properties: { class: 'grass' }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
    { sourceLayer: 'landuse', properties: { class: 'industrial' }, geometry: { type: 'Polygon', coordinates: [[[4, 4], [5, 4], [5, 5], [4, 4]]] } },
  ];
  const { water, green } = bucketFeatures(feats, 'openmaptiles');
  assert.equal(water.length, 1);
  assert.equal(green.length, 1);
  assert.deepEqual(green[0].geometry.coordinates[0][0], [2, 2]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/geography/classify.test.ts`
Expected: FAIL — `Cannot find module './classify'`.

- [ ] **Step 3: Write the implementation**

Create `src/geography/classify.ts`:

```ts
import { toPolyFeatures } from './normalize';
import type { GeoCategory, GeoPolyFeature, GeoSchema, TaggedFeature } from './types';

/** Land-use/land-cover/natural values we treat as green space, across schemas. */
const GREEN_VALUES = new Set([
  'park', 'grass', 'forest', 'wood', 'meadow', 'scrub', 'garden', 'grassland',
  'recreation_ground', 'cemetery', 'nature_reserve', 'farmland', 'heath', 'orchard',
  'allotments', 'village_green', 'golf_course', 'pitch', 'national_park',
]);

/** Classify a harvested feature into a geography category, or null to drop it.
 *  Reads the value from whichever property key the schema uses (class / kind /
 *  pmap:kind / subclass / type). */
export function classifyFeature(
  sourceLayer: string,
  props: Record<string, unknown>,
  _schema: GeoSchema,
): GeoCategory | null {
  if (sourceLayer === 'water') return 'water';
  if (sourceLayer === 'park') return 'green'; // OpenMapTiles dedicated park layer
  const value = String(
    props['class'] ?? props['kind'] ?? props['pmap:kind'] ?? props['subclass'] ?? props['type'] ?? '',
  ).toLowerCase();
  return GREEN_VALUES.has(value) ? 'green' : null;
}

/** Classify every feature and normalize the kept ones into polygon collections. */
export function bucketFeatures(
  features: TaggedFeature[],
  schema: GeoSchema,
): { water: GeoPolyFeature[]; green: GeoPolyFeature[] } {
  const water: TaggedFeature[] = [];
  const green: TaggedFeature[] = [];
  for (const f of features) {
    const cat = classifyFeature(f.sourceLayer, f.properties ?? {}, schema);
    if (cat === 'water') water.push(f);
    else if (cat === 'green') green.push(f);
  }
  return { water: toPolyFeatures(water), green: toPolyFeatures(green) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/geography/classify.test.ts`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/geography/classify.ts src/geography/classify.test.ts
git commit -m "feat(geography): classify + bucket features into water/green"
```

---

## Task 4: Offscreen-map harvester (integration)

This is the one module that needs the live MapLibre runtime + DOM + network, so it is **not** unit-tested — it is exercised by the in-game verification in Task 9. It borrows the MapLibre constructor from the live game map (so we never bundle a second copy) and uses a hidden offscreen map to load all tiles for the city bbox without disturbing the player's view.

**Files:**
- Create: `src/geography/harvest.ts`

- [ ] **Step 1: Write the implementation**

Create `src/geography/harvest.ts`:

```ts
import type { Map as MlMap, StyleSpecification, SourceSpecification } from 'maplibre-gl';
import type { BoundingBox } from '../types/core';
import type { TaggedFeature } from './types';
import type { ProbeResult } from './schemaProbe';

const TAG = '[ImprovedSchematics] geography:';
const CONTAINER_PX = 1024; // offscreen canvas size; larger = higher fitBounds zoom = more detail
const IDLE_TIMEOUT_MS = 10_000;

function nextIdleOrTimeout(map: MlMap): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, IDLE_TIMEOUT_MS);
    map.once('idle', done);
  });
}

/**
 * Build a hidden offscreen MapLibre map carrying only the probed vector source,
 * fit it to the city bbox, wait for tiles to load, and return every feature from
 * the target source-layers tagged with its layer name. The view of the real game
 * map is never touched. Returns [] on any failure (caller treats as "no geography").
 */
export async function harvestTaggedFeatures(
  gameMap: MlMap,
  probe: ProbeResult,
  bbox: BoundingBox,
): Promise<TaggedFeature[]> {
  // Borrow the constructor from the live instance — we never import the runtime.
  const MapCtor = gameMap.constructor as typeof MlMap;

  const container = document.createElement('div');
  container.style.cssText =
    `position:absolute;left:-99999px;top:0;width:${CONTAINER_PX}px;height:${CONTAINER_PX}px;visibility:hidden;`;
  document.body.appendChild(container);

  // Minimal style: just the probed source + transparent fill layers for each
  // target source-layer, which forces MapLibre to fetch + decode those tiles.
  const style: StyleSpecification = {
    version: 8,
    sources: { [probe.sourceId]: probe.source as SourceSpecification },
    layers: probe.sourceLayers.map((sl, i) => ({
      id: `harvest-${i}`,
      type: 'fill' as const,
      source: probe.sourceId,
      'source-layer': sl,
      paint: { 'fill-opacity': 0 },
    })),
  };

  let map: MlMap | null = null;
  try {
    map = new MapCtor({ container, style, interactive: false, attributionControl: false, fadeDuration: 0 });
    await new Promise<void>((resolve) => map!.once('load', () => resolve()));
    map.fitBounds(
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { animate: false, padding: 0, duration: 0 },
    );
    await nextIdleOrTimeout(map);

    const out: TaggedFeature[] = [];
    for (const sl of probe.sourceLayers) {
      const feats = map.querySourceFeatures(probe.sourceId, { sourceLayer: sl });
      for (const f of feats) {
        out.push({
          sourceLayer: sl,
          properties: (f.properties ?? {}) as Record<string, unknown>,
          geometry: f.geometry as TaggedFeature['geometry'],
        });
      }
    }
    return out;
  } catch (err) {
    console.warn(`${TAG} offscreen harvest failed:`, err);
    return [];
  } finally {
    map?.remove();
    container.remove();
  }
}
```

Risk notes (validated in Task 9, not blocking here):
- The copied source may rely on the game's `transformRequest`/auth for tile URLs; if tile requests 403/404 on the offscreen map, harvest returns `[]` → no backdrop (the accepted fallback, and the empirical signal that Approach A doesn't work for this basemap).
- `querySourceFeatures` returns tile-clipped, possibly duplicated geometry in `[lng,lat]`; opaque fills make this seamless, so no union is done.

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors (exit 0). If maplibre-gl type names differ in `^5.x`, adjust the imported type names (`Map`, `StyleSpecification`, `SourceSpecification`) to match — do not change behavior.

- [ ] **Step 3: Commit**

```bash
git add src/geography/harvest.ts
git commit -m "feat(geography): offscreen-map tile harvester (integration)"
```

---

## Task 5: Orchestrator with injected dependencies

**Files:**
- Create: `src/geography/geography.ts`
- Test: `src/geography/geography.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/geography/geography.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeography } from './geography';
import type { GeographyDeps } from './geography';
import type { TaggedFeature } from './types';
import type { ProbeResult } from './schemaProbe';

const BBOX = [-3.25, 53.22, -2.48, 53.58] as [number, number, number, number];

const PROBE: ProbeResult = { sourceId: 'osm', source: {}, schema: 'openmaptiles', sourceLayers: ['water', 'landuse'] };

const RAW: TaggedFeature[] = [
  { sourceLayer: 'water', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  { sourceLayer: 'landuse', properties: { class: 'park' }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
];

test('buildGeography: returns null when there is no map', async () => {
  const deps: GeographyDeps = { getMap: () => null, probe: () => PROBE, harvest: async () => RAW };
  assert.equal(await buildGeography(BBOX, deps), null);
});

test('buildGeography: returns null when the probe finds no usable source', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => null, harvest: async () => RAW };
  assert.equal(await buildGeography(BBOX, deps), null);
});

test('buildGeography: buckets harvested features into water + green', async () => {
  const deps: GeographyDeps = {
    getMap: () => ({ getStyle: () => ({}) }) as never,
    probe: () => PROBE,
    harvest: async () => RAW,
  };
  const geo = await buildGeography(BBOX, deps);
  assert.ok(geo);
  assert.equal(geo!.water.length, 1);
  assert.equal(geo!.green.length, 1);
  assert.deepEqual(geo!.bbox, BBOX);
});

test('buildGeography: returns null when nothing was harvested', async () => {
  const deps: GeographyDeps = { getMap: () => ({ getStyle: () => ({}) }) as never, probe: () => PROBE, harvest: async () => [] };
  assert.equal(await buildGeography(BBOX, deps), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/geography/geography.test.ts`
Expected: FAIL — `Cannot find module './geography'`.

- [ ] **Step 3: Write the implementation**

Create `src/geography/geography.ts`:

```ts
import type { Map as MlMap } from 'maplibre-gl';
import type { BoundingBox } from '../types/core';
import type { GeographyData, TaggedFeature } from './types';
import { probeVectorSchema, type ProbeResult, type StyleLike } from './schemaProbe';
import { harvestTaggedFeatures } from './harvest';
import { bucketFeatures } from './classify';

const TAG = '[ImprovedSchematics] geography:';
const cache = new Map<string, GeographyData | null>();

/** Injectable seams so the orchestrator is testable without a live map. */
export interface GeographyDeps {
  getMap: () => MlMap | null;
  probe: (style: StyleLike) => ProbeResult | null;
  harvest: (map: MlMap, probe: ProbeResult, bbox: BoundingBox) => Promise<TaggedFeature[]>;
}

// window.SubwayBuilderAPI is accessed lazily (only when getMap is actually
// called in-game), so importing this module under node:test never touches it.
const defaultDeps: GeographyDeps = {
  getMap: () => window.SubwayBuilderAPI.utils.getMap(),
  probe: probeVectorSchema,
  harvest: harvestTaggedFeatures,
};

/** Probe → harvest → classify. Returns null (→ no backdrop) on any failure. */
export async function buildGeography(bbox: BoundingBox, deps: GeographyDeps = defaultDeps): Promise<GeographyData | null> {
  try {
    const map = deps.getMap();
    if (!map) return null;
    const probe = deps.probe(map.getStyle() as unknown as StyleLike);
    if (!probe) {
      console.warn(`${TAG} no usable vector source in the basemap`);
      return null;
    }
    const raw = await deps.harvest(map, probe, bbox);
    const { water, green } = bucketFeatures(raw, probe.schema);
    if (water.length === 0 && green.length === 0) return null;
    return { bbox, water, green };
  } catch (err) {
    console.warn(`${TAG} build failed:`, err);
    return null;
  }
}

/** Cached per city. The first bbox seen for a city wins (harvested once per
 *  session); pad the bbox at the call site to cover expected network growth. */
export async function generateGeography(
  cityCode: string,
  bbox: BoundingBox,
  deps: GeographyDeps = defaultDeps,
): Promise<GeographyData | null> {
  if (cache.has(cityCode)) return cache.get(cityCode) ?? null;
  const result = await buildGeography(bbox, deps);
  cache.set(cityCode, result);
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/geography/geography.test.ts`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/geography/geography.ts src/geography/geography.test.ts
git commit -m "feat(geography): cached orchestrator (probe -> harvest -> classify)"
```

---

## Task 6: Render backdrop + theme green

**Files:**
- Modify: `src/render/types.ts` (add `green` to theme + both presets)
- Create: `src/render/geographyBackdrop.ts`
- Test: `src/render/geographyBackdrop.test.ts`

- [ ] **Step 1: Add the green theme color**

In `src/render/types.ts`, add `green` to the `SchematicTheme` interface (after `water`, around line 47):

```ts
  water: string;
  /** Parks / green-space fill. */
  green: string;
```

Add it to `DEFAULT_THEME` (after `water: '#a8d4e6',`):

```ts
  green: '#cfe6c3',
```

Add it to `DARK_THEME` (after `water: '#24506b',`):

```ts
  green: '#33503b',
```

- [ ] **Step 2: Write the failing test**

Create `src/render/geographyBackdrop.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geographyBackdrop } from './geographyBackdrop';
import { DEFAULT_THEME } from './types';
import type { Projection } from './projection';
import type { GeographyData } from '../geography/types';

// Identity-ish projection: lng→x, lat→y (no flip) so assertions are simple.
const proj: Projection = { width: 100, height: 100, toSVG: ([lng, lat]) => [lng, lat] };

const GEO: GeographyData = {
  bbox: [0, 0, 10, 10],
  water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] } }],
  green: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] } }],
};

test('geographyBackdrop: returns "" when geography is undefined', () => {
  assert.equal(geographyBackdrop(undefined, proj, DEFAULT_THEME, false), '');
});

test('geographyBackdrop: emits a green group then a water group (water on top)', () => {
  const svg = geographyBackdrop(GEO, proj, DEFAULT_THEME, false);
  const greenIdx = svg.indexOf(DEFAULT_THEME.green);
  const waterIdx = svg.indexOf(DEFAULT_THEME.water);
  assert.ok(greenIdx >= 0, 'has green fill');
  assert.ok(waterIdx >= 0, 'has water fill');
  assert.ok(greenIdx < waterIdx, 'green is drawn before water');
  assert.ok(svg.includes('M0 0 L10 0 L10 10'), 'projects water ring');
});

test('geographyBackdrop: omits an empty category', () => {
  const svg = geographyBackdrop({ ...GEO, green: [] }, proj, DEFAULT_THEME, false);
  assert.ok(!svg.includes(DEFAULT_THEME.green));
  assert.ok(svg.includes(DEFAULT_THEME.water));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test src/render/geographyBackdrop.test.ts`
Expected: FAIL — `Cannot find module './geographyBackdrop'`.

- [ ] **Step 4: Write the implementation**

Create `src/render/geographyBackdrop.ts`:

```ts
import type { Projection } from './projection';
import type { SchematicTheme } from './types';
import { DARK_THEME } from './types';
import type { GeographyData, GeoPolyFeature } from '../geography/types';

const r = (n: number): number => Math.round(n * 10) / 10;

/** Render a set of polygon features as one filled SVG group through `proj`. */
export function polyGroup(features: GeoPolyFeature[], proj: Projection, fill: string): string {
  let paths = '';
  for (const f of features) {
    if (f.geometry.type !== 'Polygon') continue;
    let d = '';
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = proj.toSVG(c);
        d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
      });
      d += 'Z ';
    }
    if (d.trim()) paths += `<path d="${d.trim()}"/>`;
  }
  if (!paths) return '';
  return `<g fill="${fill}" fill-rule="evenodd" stroke="none">${paths}</g>`;
}

/**
 * Tile-derived geography backdrop: green first, then water on top (cleaner coast
 * where generalized land-use bleeds into water). Returns '' when geography is
 * absent — the single "no background" fallback. Rendered through whatever `proj`
 * the caller passes, so in smoothed mode it rides the density warp for free.
 */
export function geographyBackdrop(
  geo: GeographyData | undefined,
  proj: Projection,
  theme: SchematicTheme,
  dark: boolean,
): string {
  if (!geo) return '';
  const greenFill = dark ? DARK_THEME.green : theme.green;
  const waterFill = dark ? DARK_THEME.water : theme.water;
  return polyGroup(geo.green, proj, greenFill) + polyGroup(geo.water, proj, waterFill);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/render/geographyBackdrop.test.ts`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/render/types.ts src/render/geographyBackdrop.ts src/render/geographyBackdrop.test.ts
git commit -m "feat(render): geography backdrop (green+water) + theme green"
```

---

## Task 7: Wire geography into the renderer

Replaces the three water-render sites with the new backdrop and threads `geography` through the input types. The new logic is unit-tested in Task 6; this task is type-safe plumbing verified by `npm run typecheck` + the full suite.

**Files:**
- Modify: `src/render/renderGeographic.ts`
- Modify: `src/render/schematic.ts`

- [ ] **Step 1: Update imports + GeoInput in `renderGeographic.ts`**

Leave the existing `./types` import as-is (`WaterCollection` is still used by `GeoInput.water`; the backdrop receives `theme` as an inferred type, so no `SchematicTheme` import is needed here). Add the backdrop + geography imports after the existing imports (after line 30):

```ts
import { geographyBackdrop } from './geographyBackdrop';
import type { GeographyData } from '../geography/types';
```

Add `geography` to `GeoInput` (after the `water?: WaterCollection;` line, ~line 38):

```ts
  water?: WaterCollection;
  geography?: GeographyData;
```

- [ ] **Step 2: Remove the now-unused `waterGroup`**

Delete the `waterGroup` function (lines 57–73). It is replaced by `geographyBackdrop`. (`polyGroup` lives in the new file; nothing else in this file references `waterGroup`.)

- [ ] **Step 3: Replace the three water-render sites**

In `renderGeographic` — remove the unused `const water = …` line (~line 255) and replace the `if (input.water) { … }` block (~lines 274–277) with:

```ts
  const backdrop = geographyBackdrop(input.geography, proj, theme, dark);
  if (backdrop) parts.push(backdrop);
```

In `renderGeographicTopo` — replace the two lines (~372–373):

```ts
  const waterColor = dark ? DARK_THEME.water : theme.water;
  const waterOverlay = input.water ? waterGroup(input.water, proj, waterColor) : '';
```

with:

```ts
  const waterOverlay = geographyBackdrop(input.geography, proj, theme, dark);
```

In `precomputeSmoothed` — replace the two lines (~666–667, where `proj` is the **warped** projection):

```ts
  const waterColor = dark ? DARK_THEME.water : theme.water;
  const waterOverlay = input.water ? waterGroup(input.water, proj, waterColor) : '';
```

with:

```ts
  const waterOverlay = geographyBackdrop(input.geography, proj, theme, dark);
```

- [ ] **Step 4: Add `geography` to `SchematicInput`**

In `src/render/schematic.ts`, add the import and the field. After line 12 add:

```ts
import type { GeographyData } from '../geography/types';
```

In the `SchematicInput` interface, after `water?: WaterCollection;` (line 34):

```ts
  water?: WaterCollection;
  geography?: GeographyData;
```

(`generateSchematicSVG` and `precomputeSmoothedSchematic` already spread `...input` into `renderGeographic`/`precomputeSmoothed`, so `geography` flows through automatically.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors (exit 0). If tsc reports `'SchematicTheme' is declared but never used` or a leftover `DARK_THEME`/`waterColor` unused-var error, remove the dangling reference it names — those are the consts we superseded.

- [ ] **Step 6: Run the full test suite (nothing regressed)**

Run: `npm test`
Expected: all suites pass, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/render/renderGeographic.ts src/render/schematic.ts
git commit -m "feat(render): draw tile geography backdrop in all geographic paths"
```

---

## Task 8: Wire geography into the panel UI

Replaces the `ocean_depth_index` water load with the tile-geography load, derives the harvest bbox from the live stations, and keys the caches on `geography`.

**Files:**
- Modify: `src/ui/SchematicPanel.tsx`

- [ ] **Step 1: Swap imports**

Replace the water import (line 22) and the `WaterCollection` type import (line 21):

```ts
import type { RenderMode } from '../render/types';
import { generateGeography } from '../geography/geography';
import type { GeographyData } from '../geography/types';
import { computeBounds, padBounds } from '../render/projection';
```

(Drop `generateWater` and the `WaterCollection` import — both become unused.)

- [ ] **Step 2: Replace the `water` state + loader**

Replace the state (line 75) and the loader effect (lines 76–86):

```ts
  // Tile-derived geography (water + parks) for the current city, harvested from
  // the game's MapLibre vector tiles on first open. Undefined = no backdrop.
  const [geography, setGeography] = useState<GeographyData | undefined>(undefined);
  useEffect(() => {
    const city = modState.cityCode ?? api.utils.getCityCode?.();
    if (!city) return;
    const stations = api.gameState.getStations();
    const b = computeBounds(stations.map((s) => ({ points: [s.coords] })));
    if (!b) return; // no stations yet → nothing to frame
    const bbox = padBounds(b, 0.15);
    let alive = true;
    generateGeography(city, bbox).then((g) => {
      if (alive && g) setGeography(g);
    });
    return () => {
      alive = false;
    };
  }, []);
```

- [ ] **Step 3: Pass `geography` into the render input**

In `buildInput` (line 153), replace `water,` with `geography,`.

- [ ] **Step 4: Re-key the caches from `water` to `geography`**

`smoothedCacheRef` declaration (line 134):

```ts
  const smoothedCacheRef = useRef<{ pre: SmoothedPrecomputed | string; geography: GeographyData | undefined } | null>(null);
```

`geoIdRef` declaration (line 141):

```ts
  const geoIdRef = useRef<{ mode: RenderMode; geography: GeographyData | undefined } | null>(null);
```

Smoothed cache check + build (lines 168–170):

```ts
      if (!cache || cache.geography !== geography) {
        const t0 = performance.now();
        cache = { pre: precomputeSmoothedSchematic(buildInput()), geography };
```

Geographic layout-identity check (lines 184–185):

```ts
    if (!geoIdRef.current || geoIdRef.current.mode !== mode || geoIdRef.current.geography !== geography) {
      geoIdRef.current = { mode, geography };
    }
```

`useMemo` dependency array (line 189): replace `water` with `geography`:

```ts
  }, [mode, showStations, showLabels, geography, smoothedReady]);
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors (exit 0). If `s.coords` is flagged, confirm the field name on the game `Station` type in `src/types/game-state.d.ts` and use the correct one (it is the `[lng,lat]` coordinate field the panel already passes as `stations`).

- [ ] **Step 6: Build the bundle**

Run: `npm run build`
Expected: Vite writes `dist/index.js` with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/SchematicPanel.tsx
git commit -m "feat(ui): load tile geography backdrop, keyed per city"
```

---

## Task 9: Full verification + in-game smoke test (the "verify A" gate)

**Files:** none (verification only)

- [ ] **Step 1: Full automated suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests `# fail 0`, tsc exit 0, Vite build succeeds.

- [ ] **Step 2: Load the mod in-game on Liverpool (LIV)**

Start the game with the mod (`npm run dev`), open the Improved Schematics panel on a Liverpool save that has at least one route.

- [ ] **Step 3: Confirm the backdrop and capture the empirical result**

Verify in **Geographic** mode:
- The Mersey/coast renders as crisp water and parks render as green polygons, OR
- No backdrop appears — open the console and read the `[ImprovedSchematics] geography:` log to learn *why* (no usable vector source / harvest failed). **This is the Approach-A verification result.** If the basemap is raster or tiles fail to load on the offscreen map, that is the signal to revisit Approach B (Protomaps) in a follow-up — out of scope here.

Verify in **Smoothed** mode (click Generate Map):
- The geography distorts together with the network (parks/water stretch where the map dilates), confirming it rides the density warp.

- [ ] **Step 4: Record the outcome**

If the backdrop renders: capture a screenshot for the PR. If it does not: note the console reason in the PR description so the Approach-B decision has evidence.

- [ ] **Step 5: Final commit (if any tuning edits were needed)**

```bash
git add -A
git commit -m "chore(geography): in-game verification tuning"
```

---

## Notes & accepted limitations

- **Single fallback:** any failure (no map, raster basemap, unknown schema, tile load failure, empty harvest) → `null` → no backdrop. `ocean_depth_index` is no longer rendered in geographic/smoothed modes.
- **Harvested once per city** at first panel open, using the station-derived bbox padded 15%. Network growth beyond that bbox won't be covered until cache reset (process restart). Acceptable for v1.
- **Deferred:** Protomaps/alternate provider (Approach B), self-decoded MVT (C), headless/batch export, polygon union, full land-use palette.
