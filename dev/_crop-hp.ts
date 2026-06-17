// Throwaway: tight crop of the L-spur hairpin region (before-fix coords
// apex ~(949,754), base mesh ~(947,850)) from the Seattle smoothed render.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

let svg = readFileSync('dev/out-sea-smooth.svg', 'utf-8');
svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="780 620 420 420"');
writeFileSync('dev/_hp-after.png', new Resvg(svg, { fitTo: { mode: 'width', value: 900 } }).render().asPng());
console.log('done');
