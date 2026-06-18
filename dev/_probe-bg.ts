import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
let svg = readFileSync('dev/_dark-fit.svg', 'utf-8');
// expand the viewBox well beyond the canvas so any overflow content shows; bg=magenta
svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="-1350 -1350 5400 5400"').replace(/width="2700" height="2700"/, 'width="5400" height="5400"');
writeFileSync('dev/_overflow-check.png', new Resvg(svg, { fitTo: { mode: 'width', value: 600 }, background: '#ff00ff' }).render().asPng());
console.log('wrote dev/_overflow-check.png (canvas [0..2700] is the inner quarter; magenta = void, any map out there = overflow)');
