# Improved Schematics

A **Subway Builder** mod that renders your transit system as a real-looking
subway map: route lines drawn over simplified land, water, and park context, with proper
station markers, interchange capsules, and an octilinear ("straightened") layout.

It adds a floating panel to the game that reads your live network and generates
an SVG on demand.

## Render modes

The panel offers two layouts (`generateSchematicSVG` dispatches on the mode):

- **Geographic** — routes in their true geographic positions over the land/water
  backdrop. The faithful "where it actually is" view.
- **Smoothed** — a TypeScript port of the [LOOM](https://github.com/ad-freiburg/loom)
  octilinearization pipeline: parallel corridors are bundled, the layout is
  relaxed onto an octilinear (0/45/90°) grid, lines are ordered into rigid blocks
  within each bundle, and stations become rigid-row markers / interchange
  capsules. This is the flagship "looks like a printed metro map" view.

## Status

Actively developed. Send me any saves that you want me to look at via discord (id gcm)

- [x] Land / water / parks backdrop harvested from the game's basemap vector tiles
- [x] Geographic projection (cos-lat corrected) shared by the backdrop and routes,
      rotated to each city's map bearing
- [x] Geographic render mode (routes + stations over land/water/parks)
- [x] Smoothed mode: full LOOM octilinear pipeline (topo merge → demand-driven box
      warp → octilinearizer → bundle merge → block-based line ordering → ribbon
      rendering)
- [x] Station markers: dots, multi-line bullets, elbow/row interchange capsules,
      collision sliding, transfer detection, split station complexes
- [x] Density-driven map expansion (per-box demand warp over density, contraction,
      and capsule-collision oracles; high-degree hubs split and expanded)
- [x] In-game floating panel reading live game state; dark/light themes; per-mode
      appearance settings
- [x] Detail areas: Manually select an area for rerender as an inset panel
- [ ] Label placement polish, more framing controls
- [ ] Further capsule optimization (punish the number of angles)
- [ ] Better balance between geographic accuracy and octilinear cleanliness
- [ ] Route selection settings
- [ ] Station dot styles

## Architecture

The renderer is framework-free (no React/DOM in the render path), so it runs
unchanged in Node for offline testing.

```
src/
  main.ts                  # entry: registers the floating panel
  state.ts                 # mod state (current city, panel prefs)
  env.ts                   # guarded env-var reads (dev knobs + debug flags)
  ui/SchematicPanel.tsx    # React panel; generates SVG from live gameState

  render/
    schematic.ts           # generateSchematicSVG(): dispatch geographic vs smoothed
    renderGeographic.ts    # geographic renderer + smoothed-pipeline driver
    renderOctilinear.ts    # reusable ribbon + station renderer (renderRibbons)
    geoSimplify.ts         # landmass backdrop styling (blob simplification)
    geographyBackdrop.ts   # draw the land / water / parks backdrop
    routes.ts              # extract route polylines from game routes/tracks
    stops.ts               # station dots / bullets / interchange capsules
    projection.ts          # geo → SVG transform (cos-lat corrected)
    rotateInput.ts         # rotate input to each city's map bearing
    labels.ts              # station label placement
    cacheFingerprint.ts mapCache.ts persist.ts  # layout cache + save/load
    types.ts               # shared types, themes, default options

    layout/                # the LOOM octilinear pipeline (smoothed mode)
      graph.ts             #   transit graph + station-group resolution
      topo.ts              #   LOOM topo merge: bundle parallel corridors
      densityBoxWarp.ts    #   demand-driven per-box map expansion
      gridGraph.ts octi.ts #   octilinearizer: grid graph + local-search cost model
      imageMerge.ts        #   merge coincident paths into bundles
      bundleOrder.ts blockAlgebra.ts  # order lines into rigid blocks within bundles
      offsets.ts           #   per-edge parallel lane offsets
      rowPlace.ts chainPlace.ts  # rigid-row station marker placement
      hookSuppress.ts capsuleSlide.ts  # artifact suppression + capsule sliding TODO: suppress artifacts gracefully by construction

  geography/               # live land / water / parks backdrop, harvested from the basemap
    schemaProbe.ts         # detect the basemap's vector schema
    harvest.ts             # pull tagged water/green features from the vector source
    classify.ts            # bucket features into water vs green (parks)
    clean.ts combine.ts    # simplify/smooth polygons; merge nearby park fragments
    geography.ts           # orchestrator: probe → harvest → classify → clean (cached)
    geoCache.ts warm.ts    # per-city cache + background warm-up

  water/                   # ocean_depth_index coastline pipeline (offline/dev; see below)
    grid.ts marchingSquares.ts simplify.ts bodies.ts generate.ts

  types/                   # Subway Builder modding API type definitions

scripts/                   # run.ts (launch game), link.ts (symlink dist → mods)
dev/                       # offline harnesses: render-from-dump.ts, render-test.ts, ...
```

Unit tests live in a sibling `tests/` subfolder; env-gated debug and diagnostics
live in a sibling `debug/` subfolder. Superseded modules are moved to the
repo-root `old/` folder (mirrored paths + a README pointing at the replacement),
never left in place.

## Development

Uses [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm typecheck         # tsc --noEmit
pnpm test              # tsx --test over src/**/*.test.ts
pnpm build             # vite build → dist/index.js (+ manifest.json)
pnpm render            # offline render harness → dev/ SVG/PNG
pnpm dev:link          # symlink dist/ into the game's mods folder
pnpm dev               # watch-build + launch the game together
```

The offline harness rasterizes SVG → PNG with
[`@resvg/resvg-js`](https://github.com/yisibl/resvg-js), so no external tools are
needed to preview a render.

## How the land & water backdrop works

The in-game backdrop (land, water, and parks) is harvested at runtime from the
game's basemap vector tiles, in `src/geography/`:

1. Probe the basemap style for a usable vector source and its schema
   (`schemaProbe.ts`).
2. Harvest tagged water and green (park) polygons over the map's demand extent
   (`harvest.ts`), then bucket them into water vs. green (`classify.ts`).
3. Merge nearby park fragments, then simplify, smooth, and drop sub-threshold
   polygons (`combine.ts`, `clean.ts`). Results are cached per city (`geoCache.ts`).

The renderers fill polygons with `fill-rule="evenodd"`, so nested rings become
land holes automatically.

An earlier self-contained pipeline in `src/water/` derives coastlines from a
city's `ocean_depth_index` depth grid (marching squares → Douglas–Peucker /
Chaikin → keep-largest-bodies). It still backs the offline dev harnesses and
tests; the runtime loader that fed it in-game now lives under `old/`.

## Credits

- Smoothed mode is based on the octilinearization approach from
  [LOOM](https://github.com/ad-freiburg/loom), ported to TypeScript, with a lot of improvements and adaptations.
- Built for Subway Builder using its modding API.

## License

MIT © Giancarlo Martinelli (gcm)
