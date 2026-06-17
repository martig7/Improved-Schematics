// Throwaway: re-rasterize the smoothed SVG cropped to midtown for inspection.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import type { Route, Track } from '../src/types/game-state';
import type { WaterCollection } from '../src/render/types';

const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const save = APP + 'new_york_freeplay_590fec73.json';
const data = JSON.parse(readFileSync(save, 'utf-8')).data ?? JSON.parse(readFileSync(save, 'utf-8'));
const w: WaterCollection = JSON.parse(readFileSync('nyc_water.geojson', 'utf-8'));
let svg = generateSchematicSVG({
  routes: (data.routes ?? []) as Route[],
  tracks: (data.tracks ?? []) as Track[],
  stations: data.stations ?? [],
  water: w,
  options: { mode: 'smoothed', width: 2000, height: 2000, showStations: true, showLabels: false },
});
// crop viewBox to the dense center
svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="950 950 500 500"');
writeFileSync('dev/_chk-nyc-mid.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng());
console.log('done');
