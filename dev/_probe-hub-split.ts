/**
 * Task-4 split-hub feasibility probe.
 * Renders improvedschematics-input.json (SEA) in smoothed mode and writes
 * dev/_probe-hub-split.svg + dev/_probe-hub-split.png.
 *
 * Usage:
 *   npx tsx dev/_probe-hub-split.ts                   # flag off (baseline)
 *   OCTI_SPLIT_HUBS=1 npx tsx dev/_probe-hub-split.ts # split on
 *   IS_DARK=1 OCTI_SPLIT_HUBS=1 npx tsx dev/_probe-hub-split.ts  # dark + split
 */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';

const raw = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;

const svg = generateSchematicSVG({
  routes,
  tracks,
  stations,
  stationGroups,
  options: {
    mode: 'smoothed',
    width: 2700,
    height: 2700,
    showStations: true,
    showLabels: false,
    dark: process.env.IS_DARK === '1',
  },
});

writeFileSync('dev/_probe-hub-split.svg', svg);
writeFileSync(
  'dev/_probe-hub-split.png',
  new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng(),
);
console.log('wrote dev/_probe-hub-split.svg / .png');
