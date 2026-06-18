/** Full smoothed render WITH labels + stations; optional crop window in design coords.
 *  Usage: npx tsx dev/_render-labeled.ts <out> [cx cy half] */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
const raw = JSON.parse(readFileSync('improvedschematics-input-difficult-nyc.json', 'utf-8'));
const d = raw['debug-render-input'] ?? raw;
const out = process.argv[2] ?? 'dev/_labeled';
const svg = generateSchematicSVG({
  routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups,
  geography: d.geography,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: true, dark: process.env.IS_DARK === '1' },
});
writeFileSync(out + '.svg', svg);
const bg = process.env.IS_DARK === '1' ? '#09090b' : 'white';
writeFileSync(out + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: 2000 }, background: bg }).render().asPng());
if (process.argv[3] && process.argv[4] && process.argv[5]) {
  const cx = Number(process.argv[3]), cy = Number(process.argv[4]), half = Number(process.argv[5]);
  const crop = svg.replace(/viewBox="[^"]*"/, `viewBox="${cx - half} ${cy - half} ${2 * half} ${2 * half}"`);
  writeFileSync(out + '-crop.png', new Resvg(crop, { fitTo: { mode: 'width', value: 1000 }, background: bg }).render().asPng());
  console.log(`wrote ${out}-crop.png @ (${cx},${cy}) half ${half}`);
}
console.log(`wrote ${out}.png`);
