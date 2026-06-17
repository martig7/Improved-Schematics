// Throwaway: count per-color edge path elements + coordinate extents in the
// smoothed SVG, to verify no line is dropped or flung off-canvas by the warp.
import { readFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
import type { Route, Track } from '../src/types/game-state';
import type { WaterCollection } from '../src/render/types';

const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const raw = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8'));
const data = raw.data ?? raw;
const w: WaterCollection = JSON.parse(readFileSync('nyc_water.geojson', 'utf-8'));

const svg = generateSchematicSVG({
  routes: (data.routes ?? []) as Route[],
  tracks: (data.tracks ?? []) as Track[],
  stations: data.stations ?? [],
  water: w,
  options: { mode: 'smoothed', width: 2000, height: 2000, showStations: true, showLabels: false },
});

const edgesBlock = svg.match(/<g class="edges">[\s\S]*?<\/g>/)?.[0] ?? '';
const strokes = new Map<string, { n: number; minX: number; maxX: number; minY: number; maxY: number }>();
for (const m of edgesBlock.matchAll(/<path[^>]*stroke="([^"]+)"[^>]*d="([^"]+)"|<path[^>]*d="([^"]+)"[^>]*stroke="([^"]+)"/g)) {
  const color = m[1] ?? m[4];
  const d = m[2] ?? m[3];
  const s = strokes.get(color) ?? { n: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  s.n++;
  for (const c of d.matchAll(/(-?[\d.]+)[, ](-?[\d.]+)/g)) {
    const x = Number(c[1]);
    const y = Number(c[2]);
    if (x < s.minX) s.minX = x;
    if (x > s.maxX) s.maxX = x;
    if (y < s.minY) s.minY = y;
    if (y > s.maxY) s.maxY = y;
  }
  strokes.set(color, s);
}
console.log('warp =', process.env.OCTI_WARP ?? '(default)');
for (const [color, s] of [...strokes.entries()].sort()) {
  console.log(
    color.padEnd(8),
    String(s.n).padStart(3),
    'paths  x:[' + s.minX.toFixed(0) + ',' + s.maxX.toFixed(0) + '] y:[' + s.minY.toFixed(0) + ',' + s.maxY.toFixed(0) + ']',
  );
}
