/**
 * Dev harness: render the schematic from a real save file + precomputed water,
 * without needing the game running. Outputs an SVG file.
 *
 * Usage:
 *   pnpm render                          # defaults to the NYC sample
 *   tsx dev/render-test.ts <save.json> <water.geojson> <out.svg>
 *
 * The save JSON is the plain-text format (migration-backup / *.json), whose
 * `data.routes`, `data.tracks`, `data.stations` match the live gameState API
 * shapes returned by getRoutes()/getTracks()/getStations().
 */

import { readFileSync, writeFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
import type { Route, Track } from '../src/types/game-state';
import type { WaterCollection, StationPoint } from '../src/render/types';

const DEFAULTS = {
  save:
    process.env.APPDATA +
    '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\new_york_freeplay_590fec73.json',
  water: 'nyc_water.geojson',
  out: 'dev/out.svg',
};

const [, , saveArg, waterArg, outArg] = process.argv;
const savePath = saveArg ?? DEFAULTS.save;
const waterPath = waterArg ?? DEFAULTS.water;
const outPath = outArg ?? DEFAULTS.out;

const save = JSON.parse(readFileSync(savePath, 'utf-8'));
const data = save.data ?? save;

const routes: Route[] = data.routes ?? [];
const tracks: Track[] = data.tracks ?? [];
const stations: StationPoint[] = (data.stations ?? []).map((s: any) => ({
  id: s.id,
  name: s.name,
  coords: s.coords,
}));

const water: WaterCollection = JSON.parse(readFileSync(waterPath, 'utf-8'));

const svg = generateSchematicSVG({
  routes,
  tracks,
  water,
  stations,
  options: { width: 800, height: 800, showStations: true, showLabels: false },
});

writeFileSync(outPath, svg);
console.log(
  `Rendered ${routes.length} routes, ${tracks.length} tracks, ${stations.length} stations, ` +
    `${water.features.length} water polys → ${outPath} (${(svg.length / 1024).toFixed(0)}KB)`,
);
