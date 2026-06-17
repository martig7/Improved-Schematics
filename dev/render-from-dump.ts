/**
 * Render the smoothed schematic from the in-game input dump — the EXACT
 * routes/tracks/stations/stationGroups the mod's SchematicPanel passed to
 * generateSchematicSVG (written by the v0.2.0 debug dump to mod storage).
 * This is the canonical offline repro path: geojson reconstructions diverge
 * from live saves (station grouping, edits since export).
 *
 * Usage: npx tsx dev/render-from-dump.ts [dump.json] [out-prefix]
 *   dump.json default: %APPDATA%/metro-maker4/mod-data/improvedschematics.json
 *   IS_DARK=1 renders dark mode (the in-game default look).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import { keepLargestWaterBodies } from '../src/water/bodies';
import type { WaterCollection } from '../src/render/types';

const dumpPath =
  process.argv[2] ??
  process.env.APPDATA + '\\metro-maker4\\mod-data\\improvedschematics.json';
const outPrefix = process.argv[3] ?? 'dev/_dump';

const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
// storage file may be { "debug-render-input": {...} } or the value directly
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;
console.log(
  `dump: at=${dump.at} routes=${routes?.length} tracks=${tracks?.length} ` +
  `stations=${stations?.length} stationGroups=${stationGroups?.length ?? 'none'}`,
);

// Water is cosmetic for graph debugging; use the Seattle coastline if present.
// Filter to match the shipped look (generateWaterFromIndex applies the same
// keep-largest-bodies pass to the runtime ocean-index water).
let water: WaterCollection | undefined;
if (existsSync('sea_water.geojson')) {
  water = keepLargestWaterBodies(
    JSON.parse(readFileSync('sea_water.geojson', 'utf-8')),
    { minFracOfLargest: 0.01 },
  );
}

const svg = generateSchematicSVG({
  routes,
  tracks,
  stations,
  stationGroups,
  water,
  options: {
    mode: 'smoothed',
    width: 2700,
    height: 2700,
    showStations: true,
    showLabels: process.env.IS_LABELS === '1',
    dark: process.env.IS_DARK === '1',
  },
});
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(
  outPrefix + '.png',
  new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng(),
);
console.log(`wrote ${outPrefix}.svg / .png`);
