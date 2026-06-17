// Throwaway: labeled render cropped to the Lake Steilacoom / Lake Av pair.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
let svg = generateSchematicSVG({
  routes, tracks, stations, stationGroups,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: true, dark: false },
});
svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="540 2140 240 180"');
writeFileSync('dev/_lakes-lbl.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1100 }, background: 'white' }).render().asPng());
console.log('wrote dev/_lakes-lbl.png');
