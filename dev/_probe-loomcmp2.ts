import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
const svg = readFileSync('dev/out-sea-smooth.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, 'viewBox="860 700 220 260"');
writeFileSync('dev/_probe-hairpin.png', new Resvg(s, { fitTo: { mode: 'width', value: 1000 } }).render().asPng());
console.log('done');
