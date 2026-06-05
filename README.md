# Improved Schematics

A Subway Builder mod that generates a geographic schematic map of your transit
system with simplified land and water context — like a real subway map, instead
of the built-in schematic's plain black background.

## Status

Early development.

- [x] Water/land extraction pipeline (Python prototype, validated)
- [x] Mod scaffold (TypeScript + Vite, builds to `dist/index.js`)
- [x] Geographic projection shared by water + routes
- [x] Route line + station rendering to SVG (validated against real saves)
- [x] In-game floating panel reading live game state
- [ ] Runtime water generation from `ocean_depth_index` (next milestone)
- [ ] Label placement, framing/rotation controls

## Architecture

```
src/
  main.ts                 # entry: registers the floating panel
  ui/SchematicPanel.tsx   # React panel; generates SVG from live gameState
  render/
    projection.ts         # geo → SVG transform (cos-lat corrected), shared by all layers
    routes.ts             # extractRouteLines(routes, tracks) from stCombos paths
    schematic.ts          # generateSchematicSVG(): composes water + lines + stations
    types.ts              # shared types, default theme/options
  types/                  # Subway Builder modding API type definitions
scripts/                  # run.ts (launch game), link.ts (symlink dist → mods folder)
dev/render-test.ts        # standalone harness: real save + water → SVG, no game needed
```

The renderer is framework-free (no React/DOM), so `dev/render-test.ts` can
exercise the exact in-game rendering path in Node.

## Development

```bash
pnpm install
pnpm typecheck         # tsc --noEmit
pnpm build             # → dist/index.js + manifest.json
pnpm render            # dev harness → dev/out.svg (NYC sample)
pnpm dev:link          # symlink dist/ into the game's mods folder
```

To preview a harness render as PNG: `python -c "import cairosvg; cairosvg.svg2png(url='dev/out.svg', write_to='dev/out.png')"`

## Data source

Land/water comes from each city's `ocean_depth_index.json.gz` (a sparse depth
grid). The pipeline upsamples 8×, Gaussian-blurs to smooth the grid staircase,
extracts contours, and renders water polygons on a land background. See the
Python prototype scripts and `*_water.geojson` outputs.
