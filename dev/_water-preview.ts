/**
 * Preview the water-body filter at a given policy. Renders the SEA dump with
 * sea_water.geojson filtered by keepLargestWaterBodies(spec).
 *
 * Usage: npx tsx dev/_water-preview.ts <outPrefix> <spec>
 *   spec: "all" | "n=<k>" | "frac=<0..1>"   e.g. n=1, n=5, frac=0.01
 *   IS_DARK=1 for dark mode.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import { keepLargestWaterBodies, decomposeWaterBodies, type WaterFilterSpec } from '../src/water/bodies';
import type { WaterCollection } from '../src/render/types';

const outPrefix = process.argv[2] ?? 'dev/_water';
const specArg = process.argv[3] ?? 'all';
const dumpPath = 'improvedschematics-input.json';

const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;

let water: WaterCollection | undefined;
if (existsSync('sea_water.geojson')) water = JSON.parse(readFileSync('sea_water.geojson', 'utf-8'));

let spec: WaterFilterSpec = {};
if (specArg.startsWith('n=')) spec = { maxBodies: Number(specArg.slice(2)) };
else if (specArg.startsWith('frac=')) spec = { minFracOfLargest: Number(specArg.slice(5)) };

if (water) {
  const before = decomposeWaterBodies(water).length;
  if (specArg !== 'all') water = keepLargestWaterBodies(water, spec);
  const after = water.features.length;
  console.log(`spec=${specArg} bodies ${before} -> ${after}`);
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
    showLabels: false,
    dark: process.env.IS_DARK === '1',
  },
});
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(
  outPrefix + '.png',
  new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng(),
);
console.log(`wrote ${outPrefix}.svg / .png`);
