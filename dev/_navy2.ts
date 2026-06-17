import { readFileSync, writeFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
const APP = process.env.APPDATA + '/metro-maker4/migration-backups/2025-11-21_23-54-40-398Z/';
const raw = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8'));
const data = raw.data ?? raw;
const svg = generateSchematicSVG({
  routes: data.routes ?? [], tracks: data.tracks ?? [], stations: data.stations ?? [],
  water: JSON.parse(readFileSync('nyc_water.geojson', 'utf-8')),
  options: { mode: 'smoothed', width: 2000, height: 2000, showStations: true, showLabels: false },
});
const count = (svg.match(/0039a6/g) ?? []).length;
console.log('warp', process.env.OCTI_WARP ?? 'default', '-> #0039a6 occurrences:', count);
writeFileSync('dev/_navy-' + (process.env.OCTI_WARP ?? 'def') + '.svg', svg);
