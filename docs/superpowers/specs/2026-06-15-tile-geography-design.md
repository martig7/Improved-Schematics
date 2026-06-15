# Tile-derived Geography (water + parks) — Design

**Date:** 2026-06-15
**Branch:** `feat/tile-geography` (based on `master`)
**Status:** Design — pending implementation plan

## Problem

Today the schematic's only "geography" is a water/coastline layer, procedurally traced
from `ocean_depth_index.json` (a coarse ~300 m sparse grid; for Liverpool: bbox
`[-3.247, 53.229, -2.484, 53.583]`, cell size `0.0027°`, grid `169×132`). It produces a
blocky coast and **no parks / green space at all** — the local city data
(`roads.geojson`, `buildings_index.json`, `demand_data.json`, `runways_taxiways.geojson`)
contains no land-use or park information.

We want richer geography — **crisp water/coastline + parks/green space** — sourced from
**live OSM-style vector map tiles**, while preserving the existing **density-based
expansion (warp)** feature: the geography must distort along with the network.

## Goal & constraints

- Render **water + coastline** (crisp, tile-derived) and **parks / green space**
  (`leisure=park`, `landuse=grass/forest/meadow`, `natural=wood`, …) as background
  geography beneath the network.
- Geography must be **vector polygons in geographic `[lng,lat]`** so the existing
  density warp distorts it — confirmed free via the warped projection (see below).
- **In-game only.** Headless/batch export (`scripts/run.ts`, `*_GEN` cities) is out of
  scope; geography simply does not render there.
- **Single fallback: render no background.** If geography cannot be acquired for any
  reason, render no geography backdrop. No `ocean_depth_index` fallback, no alternate
  provider in v1.

## Key prior findings (grounding)

**Distortion is free.** The density warp wraps the projection itself —
`proj.toSVG = (c) => warp(baseProj.toSVG(c))` in `renderGeographic.ts` (`precomputeSmoothed`).
The warp is a provably fold-free, monotone, per-axis mapping (`buildDensityWarp` in
`src/render/layout/densityWarp.ts`). Water polygons already render through this warped
`proj` via `waterGroup(...)`. **Any** polygon in `[lng,lat]` rendered through the same
`proj` distorts identically to stations/routes — no per-layer warp code needed. This
integration exists on `master`.

**MapLibre is the tile engine.** The game runs on MapLibre GL and exposes it to the mod:
- `api.utils.getMap(): maplibregl.Map | null` — the live map.
- `api.map.registerSource(id, { type:'vector', tiles:[...] })` — register vector sources.
- MapLibre bundles the MVT decoder (`@mapbox/vector-tile`, `pbf`) transitively, and
  `map.querySourceFeatures(sourceId, { sourceLayer })` returns vector-tile features **as
  GeoJSON in `[lng,lat]`**.

So we never touch protobuf or raw tile math; MapLibre does network + decode, we harvest
GeoJSON. Raw external `fetch()` is avoided (the water loader documents that `fetch()` of
local paths fails in the Electron renderer; `oceanIndex.ts`), which is the main reason to
let MapLibre own I/O.

## Approach (v1)

**Harvest the game's own basemap vector tiles** (Approach "A"). If the game's basemap is
not a usable vector source, geography renders nothing (the single fallback). A
self-registered alternate provider (Protomaps) and self-decoding MVT are **explicitly
deferred** — we verify empirically what the game exposes before building alternates.

### Acquisition pipeline (`src/geography/`, parallel to `src/water/`)

1. **`getMap()`** — if `null`, return `null` (→ no background).
2. **`schemaProbe.ts`** — read `map.getStyle().sources`; pick the first `type:'vector'`
   source; sniff its schema and produce a `layerMap` describing which `sourceLayer` +
   property predicates correspond to `water` and `green`. Recognize common schemas:
   - OpenMapTiles: `water`; `landcover` (class `wood`/`grass`); `landuse`/`park`.
   - Protomaps basemaps: `water`; `landuse` (kind `park`/`forest`/`grass`); `natural`.
   - Mapbox Streets: `water`; `landuse`.
   Returns `null` if no usable vector source / unrecognized schema → no background.
3. **`harvest.ts`** — build a **hidden offscreen** `maplibregl.Map` (detached, sized,
   `visibility:hidden`) with a minimal style containing only the probed source +
   transparent layers for the target `sourceLayer`s (this forces tile loads).
   `fitBounds(cityBbox)`, await `'idle'`, then `querySourceFeatures(sourceId, {sourceLayer})`
   per category. Dedup by feature id. Dispose the map + container. Offscreen so the
   player's real map view is never disturbed.
4. **`classify.ts`** — bucket each feature into `'water' | 'green'` via the probed
   `layerMap`. Drop everything else.
5. **`geography.ts`** — public `generateGeography(cityCode): Promise<GeographyData | null>`,
   cached in a `Map` keyed by `cityCode` (mirrors `generateWater`).

### Output type (`src/geography/types.ts`)

```ts
interface GeoPolyFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
}
interface GeographyData {
  bbox: [number, number, number, number];
  water: GeoPolyFeature[];   // crisp tile coast (supersedes ocean_depth_index)
  green: GeoPolyFeature[];   // parks / green space
}
```

Tile features come clipped per-tile (with a buffer) and may duplicate across tiles. With
**opaque fills**, overlapping clipped polygons render seamlessly, so **no polygon
union/stitching** is needed (YAGNI).

### Rendering (`src/render/`)

- Generalize the existing `waterGroup(water, proj, color)` into a reusable
  `polyGroup(features, proj, fill)`.
- Add a `geographyBackdrop(geo, proj, opts)` that emits **water → green** polygon groups
  (in that z-order). It does **not** own the base land/background rect — that existing
  rect (filled with `landColor`) stays in the renderer and is **not** gated on geography,
  so "no background" means no water/green, never a blank canvas. Routes/stations render on
  top, unchanged.
- Add `greenColor` to `SchematicOptions` (alongside existing `waterColor`/`landColor`),
  with a sensible default that can be re-themed.
- Wire `geographyBackdrop` into the existing geography render paths where `waterGroup` is
  called today: `precomputeSmoothed` (warped `proj` → geography distorts with the network)
  and `renderGeographicTopo` / pure-geographic (un-warped `proj`).
- When `GeographyData` is present it is the **sole** backdrop source.

### Water supersession (consequence to confirm)

`ocean_depth_index` water is **no longer rendered** once this lands; tile water replaces
it with no fallback. If harvest fails (no map / no vector source / no tiles), **no water
shows** — same visual as a city without an ocean index today. The `src/water/` code is
left in place but unwired from the render path (candidate for later removal; out of scope).

### UI / caching (`src/ui/SchematicPanel.tsx`)

Mirror the water pattern: on panel open / city load, call `generateGeography(cityCode)`,
store the result in state, fold it into the memoized `SchematicInput`. `undefined` until
loaded — geography pops in asynchronously like water does today.

## Scope cuts (YAGNI)

- Self-decoding MVT / raw tile fetch (Approach "C").
- Headless / batch-export support.
- Protomaps / alternate provider registration (Approach "B") — deferred until the probe
  shows the game's basemap is unusable.
- `ocean_depth_index` fallback and water/source precedence logic.
- Polygon union/stitching.
- Full land-use palette (industrial/residential tinting), built-up/urban land.

## Risks (validate early in implementation)

- **Game basemap may be raster or an unrecognized vector schema** → probe returns `null`
  → no background. This is the accepted single-fallback behavior; the probe tells us
  empirically whether harvesting is viable.
- **Offscreen-map coverage**: `querySourceFeatures` only returns features for *loaded*
  tiles; verify `fitBounds` + `'idle'` at the chosen zoom covers the whole city bbox.
- **Small parks dropping out** at low zoom (vector simplification); may need a minimum
  zoom for the extraction map.

## Testing

- Unit: `classify` (schema → category mapping for OpenMapTiles / Protomaps / Mapbox
  fixtures); `schemaProbe` (recognizes / rejects sample styles).
- Pipeline: `generateGeography` returns `null` cleanly when `getMap()` is `null`.
- Render: `geographyBackdrop` emits expected SVG groups + z-order; polygons pass through
  the warped `proj` (distortion smoke test reusing the existing warp test harness).
- Manual in-game: open panel on Liverpool, confirm crisp coast + parks appear and distort
  with density expansion enabled.
