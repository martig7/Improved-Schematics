// Throwaway: render geographic mode with/without topo merge and rasterize to
// PNG for the visual checkpoint. Not committed.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import type { Route, Track } from '../src/types/game-state';
import type { WaterCollection } from '../src/render/types';

const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const cases = [
  { name: 'nyc', save: APP + 'new_york_freeplay_590fec73.json', water: 'nyc_water.geojson' },
];

function render(save: string, water: string, mode: 'geographic' | 'smoothed', useTopoMerge: boolean): string {
  const data = JSON.parse(readFileSync(save, 'utf-8')).data ?? JSON.parse(readFileSync(save, 'utf-8'));
  const routes: Route[] = data.routes ?? [];
  const tracks: Track[] = data.tracks ?? [];
  const stations = data.stations ?? [];
  const w: WaterCollection = JSON.parse(readFileSync(water, 'utf-8'));
  return generateSchematicSVG({
    routes, tracks, stations, water: w,
    options: { mode, width: 2000, height: 2000, showStations: true, showLabels: false, useTopoMerge },
  });
}

function toPng(svg: string, out: string) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1400 } });
  writeFileSync(out, r.render().asPng());
}

for (const c of cases) {
  for (const topo of [false, true]) {
    const svg = render(c.save, c.water, 'geographic', topo);
    const tag = topo ? 'topo' : 'baseline';
    toPng(svg, `dev/_chk-${c.name}-geo-${tag}.png`);
    console.log(`${c.name} geo ${tag} → dev/_chk-${c.name}-geo-${tag}.png (${(svg.length / 1024).toFixed(0)}KB svg)`);
  }
  const smooth = render(c.save, c.water, 'smoothed', false);
  toPng(smooth, `dev/_chk-${c.name}-smoothed.png`);
  console.log(`${c.name} smoothed → dev/_chk-${c.name}-smoothed.png (${(smooth.length / 1024).toFixed(0)}KB svg)`);
}
