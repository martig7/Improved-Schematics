// One-off: render the current Seattle dump (smoothed mode) to an SVG file so
// _chk-markerfit.ts can gate station-vs-station marker overlaps after the
// rigid-slide change. Usage: npx tsx dev/_render-sea-rigid.ts
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
import { keepLargestWaterBodies } from '../src/water/bodies';
import type { WaterCollection } from '../src/render/types';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-dump-current-seattle.json';
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;

let water: WaterCollection | undefined;
if (existsSync('sea_water.geojson')) {
  try {
    water = keepLargestWaterBodies(JSON.parse(readFileSync('sea_water.geojson', 'utf-8')), { minFracOfLargest: 0.01 });
  } catch { water = undefined; }
}

const svg = generateSchematicSVG({
  routes, tracks, stations, stationGroups, water,
  geography: dump.geography, // projection bounds — match the game's input
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
} as never);
const out = process.argv[3] ?? 'dev/_sea-rigid.svg';
writeFileSync(out, svg);
console.log(`wrote ${out} (${svg.length} bytes)`);
