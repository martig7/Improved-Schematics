# Runtime Water Generation — Design

**Date:** 2026-06-04
**Status:** Approved, ready for planning
**Mod:** Improved Schematics (Subway Builder)

## Goal

Generate the land/water background at runtime from each city's `ocean_depth_index`,
so the geographic water context (the mod's whole premise) appears in all three render
modes instead of a flat, empty background. Also fix the dark-theme land color so the
background reads intentionally even when a city has no water data.

This completes the README's deferred "runtime water generation" milestone.

## Data source (verified)

Per-city file `…/cities/data/<CITY>/ocean_depth_index.json.gz`, reachable in-game via
`api.cities.getCityDataFiles(cityCode).oceanDepthIndex` (a URL). The live map's ocean is
served as **vector tiles** (`map://<city>/ocean_foundations/{z}/{x}/{y}.mvt`), which would
be clipped/partial if queried — so the gzip index is the authoritative full-coverage source.

Decoded format (NYC example):
```
{
  cs: 0.0027,                         // ~lat-degree cell size (informational)
  bbox: [minLng, minLat, maxLng, maxLat],
  grid: [W, H],                       // e.g. [185, 187]
  cells: [[col, row, ...depthIdx]],   // 13,062 entries = water-containing cells (37.8%)
  depths: [{ b, d, p }],              // 25,306 pre-computed depth polygons (NOT used)
  stats: { … }
}
```

`cells` is a sparse list of grid cells that contain water; the trailing ints index into
`depths[]` and are ignored. This is effectively a boolean land/water raster.

## Approach: grid + marching squares (chosen)

1. **Water mask** — build a `W×H` `Uint8Array`; mark each `cells[i] = [col,row,…]` as water.
2. **Marching squares** — trace closed coastline contour rings in cell space.
3. **Simplify** — Douglas-Peucker (epsilon ≈ half a cell) to drop near-collinear points,
   then 1–2 Chaikin passes to round the staircase into a natural coastline.
4. **Ring nesting** — orient rings by signed area; nest holes (inland land) inside exterior
   water rings by containment; emit GeoJSON `Polygon`s (exterior + holes). Renderers already
   draw with `fill-rule="evenodd"`.
5. **Project to geography** — map each cell `(col,row)` to `[lng,lat]` by a linear
   `bbox`/`grid` fit: `lng = bbox[0] + (col/W)*(bbox[2]-bbox[0])`,
   `lat = bbox[1] + (row/H)*(bbox[3]-bbox[1])`. Row orientation (north/south) is verified
   once against `nyc_water.geojson` and fixed accordingly.

Output: a geographic `WaterCollection` (~tens of polygons), the exact type the renderers
already consume — so Geographic/Smoothed get aligned water and Schematic gets the affine
backdrop, with no renderer changes.

Rejected alternative: merging the 25,306 `depths[]` polygons (needs heavy polygon union, or
renders thousands of polygons). Not worth it.

## Module structure

```
src/water/
  types.ts           # OceanIndex type
  oceanIndex.ts      # fetchOceanIndex(cityCode): Promise<OceanIndex|null>
                     #   — getCityDataFiles().oceanDepthIndex -> fetch -> gunzip -> parse
  grid.ts            # buildWaterMask(index) -> { mask, W, H, toGeo(col,row) }
  marchingSquares.ts # traceContours(mask, W, H) -> Ring[] (closed cell-space loops)
  simplify.ts        # douglasPeucker, chaikin, signedArea, nestRings
  generate.ts        # generateWaterFromIndex(index): WaterCollection   (pure core)
                     # generateWater(cityCode): Promise<WaterCollection|null>  (runtime: fetch+core, cached)
```

Separation: `generateWaterFromIndex` is pure (used by tests + the dev harness, which reads
the `.gz` from disk with `zlib`); `fetchOceanIndex`/`generateWater` handle the in-game fetch
(`DecompressionStream('gzip')`, no new dependency) and per-city-code memo cache.

## Integration

- `SchematicPanel`: on first open, resolve the current city code (via the API — `onCityLoad`
  callback value / cities API), call `generateWater(cityCode)` (async, memoized by city code),
  store the resulting `WaterCollection` in state, and pass it into `generateSchematicSVG`.
  Until it resolves, the panel renders land-only; when it resolves, the panel re-renders with
  water. Switching modes/labels does not regenerate water.
- **Dark-land fix** (in the renderers/theme): give land a visible distinct color in the dark
  theme and water a dark-appropriate tint, so the background is intentional even with no water.

## Testing

- Unit: marching squares on tiny hand-built masks (single square, donut/hole, two islands);
  `nestRings` (hole inside exterior); `douglasPeucker`/`chaikin` invariants; `toGeo` corners
  map to `bbox` corners.
- Dev harness `dev/water-test.ts`: read NYC `ocean_depth_index.json.gz` from disk, run
  `generateWaterFromIndex`, write `dev/water-out.geojson`, compare feature count + bbox to the
  validated `nyc_water.geojson`, and render via the existing schematic harness for a visual check.

## Error handling

- City has no `oceanDepthIndex` (inland cities): `fetchOceanIndex` returns `null`; modes render
  land-only. No error surfaced to the player.
- Fetch/gunzip/parse failure: log to console, return `null`, never throw into the panel.
- Empty/degenerate mask: return an empty `WaterCollection`.

## Out of scope

- Depth-based water shading (the `d` values) — water is a single flat color for now.
- Rivers/lakes not present in `ocean_depth_index`.
