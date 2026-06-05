/**
 * Dev harness: render the schematic from a real save file + precomputed water,
 * without needing the game running. Emits one SVG per render mode.
 *
 * Usage:
 *   pnpm render                          # defaults to the NYC sample save
 *   tsx dev/render-test.ts <save.json> <water.geojson>
 *
 * The save JSON is the plain-text format (migration-backup / *.json), whose
 * `data.routes`, `data.tracks`, `data.stations` match the live gameState API
 * shapes returned by getRoutes()/getTracks()/getStations(). Full station fields
 * (trackGroupId, stNodeIds, trackIds, buildType) are required by the graph-based
 * (smoothed/schematic) modes, so we pass stations through unmodified.
 */

import { readFileSync, writeFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
import type { Route, Track } from '../src/types/game-state';
import type { WaterCollection, RenderMode } from '../src/render/types';

const DEFAULTS = {
  save:
    process.env.APPDATA +
    '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\new_york_freeplay_590fec73.json',
  water: 'nyc_water.geojson',
};

const [, , saveArg, waterArg] = process.argv;
const savePath = saveArg ?? DEFAULTS.save;
const waterPath = waterArg ?? DEFAULTS.water;

const save = JSON.parse(readFileSync(savePath, 'utf-8'));
const data = save.data ?? save;

const routes: Route[] = data.routes ?? [];
const tracks: Track[] = data.tracks ?? [];
const stations = data.stations ?? []; // full objects (trackGroupId, stNodeIds, …)
const water: WaterCollection = JSON.parse(readFileSync(waterPath, 'utf-8'));

const modes: { mode: RenderMode; out: string }[] = [
  { mode: 'geographic', out: 'dev/out-geo.svg' },
  { mode: 'smoothed', out: 'dev/out-smooth.svg' },
  { mode: 'schematic', out: 'dev/out-octi.svg' },
];

for (const { mode, out } of modes) {
  const svg = generateSchematicSVG({
    routes,
    tracks,
    water,
    stations,
    options: { mode, width: 900, height: 900, showStations: true, showLabels: true },
  });
  writeFileSync(out, svg);
  console.log(`${mode.padEnd(11)} → ${out} (${(svg.length / 1024).toFixed(0)}KB)`);
}

console.log(
  `\nFrom ${routes.length} routes, ${tracks.length} tracks, ${stations.length} stations, ` +
    `${water.features.length} water polys.`,
);
