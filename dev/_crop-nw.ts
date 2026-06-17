// Throwaway: crop the existing Seattle smoothed SVG to the NW-of-core area
// where the in-game hairpin loop shows, at high resolution.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

let svg = readFileSync('dev/out-sea-smooth.svg', 'utf-8');
// Full map is 2700x2700; displayed-thumbnail core NW sits around x 0.33-0.50, y 0.26-0.43.
svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="850 650 600 600"');
writeFileSync('dev/_sea-nw.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng());
console.log('done');
