/**
 * Faithful box-verification render: same call as dev/box-diag.ts (passes
 * `geography`, so the projection bounds — and thus the octi layout and marker
 * boxes — match the measured counts), but writes an SVG + PNG instead of the
 * diagnostic log. Optional crop window.
 *
 * Usage: npx tsx dev/_render-boxes.ts <dump.json> <out-prefix> [pngWidth] [cx cy half]
 *   cx cy half → also writes <out>-crop.png, a 2*half px window around (cx,cy)
 *   in DESIGN coords (the 2700×2700 canvas) rasterized at native scale.
 */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';

const dumpPath = process.argv[2];
const outPrefix = process.argv[3] ?? 'dev/_boxes';
const pngWidth = Number(process.argv[4] ?? 1600);
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;

const svg = generateSchematicSVG({
  routes,
  tracks,
  stations,
  stationGroups,
  geography: dump.geography,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false, dark: process.env.IS_DARK === '1' },
});
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(
  outPrefix + '.png',
  new Resvg(svg, { fitTo: { mode: 'width', value: pngWidth }, background: process.env.IS_DARK === '1' ? '#09090b' : 'white' }).render().asPng(),
);
console.log(`wrote ${outPrefix}.svg / .png (${pngWidth}px wide)`);

if (process.argv[5] && process.argv[6] && process.argv[7]) {
  const cx = Number(process.argv[5]);
  const cy = Number(process.argv[6]);
  const half = Number(process.argv[7]);
  // crop in design coords by overriding the SVG viewBox, then rasterize 1:1
  const cropSvg = svg.replace(/viewBox="[^"]*"/, `viewBox="${cx - half} ${cy - half} ${2 * half} ${2 * half}"`);
  writeFileSync(
    outPrefix + '-crop.png',
    new Resvg(cropSvg, { fitTo: { mode: 'width', value: Math.round(2 * half * 3) }, background: process.env.IS_DARK === '1' ? '#09090b' : 'white' }).render().asPng(),
  );
  console.log(`wrote ${outPrefix}-crop.png (window ${2 * half}px @ (${cx},${cy}), 3×)`);
}
