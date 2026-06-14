# Improved Schematics

A **Subway Builder** mod that renders your transit system as a real-looking
subway map: route lines drawn over simplified land and water context, with proper
station markers, interchange capsules, and an octilinear ("straightened") layout.

It adds a floating panel to the game that reads your live network and generates
an SVG on demand.

## Render modes

The panel offers three layouts (`generateSchematicSVG` dispatches on the mode):

- **Geographic** — routes in their true geographic positions over the land/water
  backdrop. The faithful "where it actually is" view.
- **Smoothed** — a TypeScript port of the [LOOM](https://github.com/ad-freiburg/loom)
  octilinearization pipeline: parallel corridors are bundled, the layout is
  relaxed onto an octilinear (0/45/90°) grid, lines are ordered and de-tangled
  within each bundle, and stations become rigid-row markers / interchange
  capsules. This is the flagship "looks like a printed metro map" view.

## Status

Actively developed. Send me any saves that you want me to look at via discord (id gcm)

- [x] Runtime water generation from each city's `ocean_depth_index`
- [x] Geographic projection shared by water and routes
- [x] Geographic render mode (routes + stations over land/water)
- [x] Smoothed mode: full LOOM octilinear pipeline (topo merge → density warp →
      octilinearizer → bundle merge → line ordering → ribbon rendering)
- [x] Station markers: dots, multi-line bullets, elbow/row interchange capsules,
      collision sliding, transfer detection
- [x] In-game floating panel reading live game state; dark/light themes
- [x] Water decluttering (keep only the largest bodies)
- [ ] Label placement polish, framing/rotation controls
- [ ] Further improvements to capsule optimization (punish number of angles)
- [ ] Improvements to balancing between geographic accuracy and clean-ness of the octolinear rendering.

## Architecture

The renderer is framework-free (no React/DOM in the render path), so it runs
unchanged in Node for offline testing.

```
src/
  main.ts                  # entry: registers the floating panel
  state.ts                 # mod state (current city, panel prefs)
  ui/SchematicPanel.tsx    # React panel; generates SVG from live gameState

  render/
    schematic.ts           # generateSchematicSVG(): dispatch by mode
    renderGeographic.ts    # geographic + smoothed renderers
    renderOctilinear.ts    # octilinear ribbon + station renderer (renderRibbons)
    routes.ts              # extract route polylines from game routes/tracks
    stops.ts               # station dots / bullets / interchange capsules
    transfers.ts           # transfer-pair detection between nearby stations
    projection.ts          # geo → SVG transform (cos-lat corrected)
    labels.ts              # station label placement
    types.ts               # shared types, themes, default options

    layout/                # the LOOM octilinear pipeline (smoothed mode)
      graph.ts             #   transit graph + station-group resolution
      topo.ts              #   LOOM topo merge: bundle parallel corridors
      densityWarp.ts       #   density-equalizing spatial warp
      gridGraph.ts octi.ts #   octilinearizer: grid graph + local-search cost model
      imageMerge.ts        #   merge coincident paths into bundles
      lineOrder.ts untangle.ts  # order + de-tangle lines within bundles
      offsets.ts           #   per-edge parallel lane offsets
      rowPlace.ts chainPlace.ts # rigid-row station marker placement
      octilinear.ts hananRouter.ts ...  # game-style grid-snap layout (schematic mode)

  water/                   # runtime land/water pipeline (pure, testable)
    oceanIndex.ts          # load the city's ocean_depth_index via the modding API
    grid.ts                # sparse depth cells → boolean water mask + geo mapper
    marchingSquares.ts     # trace coastline rings from the mask
    simplify.ts            # Douglas–Peucker + Chaikin smoothing
    bodies.ts              # group rings into bodies, keep only the largest
    generate.ts            # generateWaterFromIndex(): rings → WaterCollection

  types/                   # Subway Builder modding API type definitions

scripts/                   # run.ts (launch game), link.ts (symlink dist → mods)
dev/render-test.ts         # offline harness: real save + water → SVG, no game needed
```

Most modules ship with `*.test.ts` unit tests next to them.

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

## How the water layer works

Land and water come from each city's `ocean_depth_index` (a sparse depth grid)
loaded at runtime through the game's modding API. The pure pipeline in
`src/water/`:

1. Build a boolean water mask from the sparse depth cells (`grid.ts`).
2. Trace closed coastline rings with marching squares (`marchingSquares.ts`).
3. Simplify and smooth each ring — Douglas–Peucker then Chaikin (`simplify.ts`).
4. Group rings into distinct bodies (outer ring + its land holes) and keep only
   the largest, dropping the swarm of tiny ponds (`bodies.ts`).

The renderers fill the result with `fill-rule="evenodd"`, so nested rings become
land holes automatically.

## Credits

- Smoothed mode is based on the octilinearization approach from
  [LOOM](https://github.com/ad-freiburg/loom), ported to TypeScript, with a lot of improvements and adaptations.
- Built for Subway Builder using its modding API.

## License

MIT © Giancarlo Martinelli (gcm)