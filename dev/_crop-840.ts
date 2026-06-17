// Throwaway: crop the NW spur from the 840x880 (in-game panel size) render.
// 2700-space spur box (780-1200, 620-1040) scaled by 840/2700 ~= 0.311.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

let svg = readFileSync('dev/_sea-840.svg', 'utf-8');
svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="235 190 140 140"');
writeFileSync('dev/_sea-840-spur.png', new Resvg(svg, { fitTo: { mode: 'width', value: 800 } }).render().asPng());
console.log('done');
