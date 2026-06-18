/** Measure how much a warp grows the canvas bbox (the "10x blowup" check).
 *  Captures pre-octi inputs, applies the warp to a dense grid over the canvas,
 *  and prints warped-bbox / canvas ratios per axis. Usage:
 *    npx tsx dev/_warp-extent.ts [dump.json] [mode] [expand] [margin] */
process.env.OCTI_WARP_CAPTURE_ONLY = '1';
import { readFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
import { __warpDebug } from '../src/render/renderGeographic';
import { buildBoxExpandWarp, buildSepBoxWarp } from '../src/render/layout/densityBoxWarp';
import type { Pixel } from '../src/render/layout/types';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-difficult-nyc.json';
const mode = process.argv[3] ?? 'both';
const expand = Number(process.argv[4] ?? 4);
const marginFrac = Number(process.argv[5] ?? 3);
const growthCap = Number(process.argv[6] ?? 1);
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const d = raw['debug-render-input'] ?? raw;
generateSchematicSVG({
  routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups,
  geography: d.geography,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
});
if (!__warpDebug) { console.error('capture failed'); process.exit(1); }
const { width, height, samples } = __warpDebug;
const box = { minX: 0, minY: 0, maxX: width, maxY: height };
const W = mode === 'box'
  ? buildBoxExpandWarp(samples, box, { expand, marginFrac, growthCap })
  : buildSepBoxWarp(samples, box, { alpha: 0.8, maxScale: 8 }, { expand, marginFrac, growthCap });

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const N = 60;
for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
  const p: Pixel = [(i / N) * width, (j / N) * height];
  const q = W(p);
  if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
  if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
}
const wW = maxX - minX, wH = maxY - minY;
console.log(`${mode} expand=${expand} margin=${marginFrac} growthCap=${growthCap}`);
console.log(`  canvas      ${width} x ${height}`);
console.log(`  warped bbox ${wW.toFixed(0)} x ${wH.toFixed(0)}   (x off ${minX.toFixed(0)}..${maxX.toFixed(0)})`);
console.log(`  GROWTH      ${(wW / width).toFixed(2)}x  by  ${(wH / height).toFixed(2)}x`);
