// Throwaway: crop of the Crockett St 1/2 area (bundle crimp check).
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, 'viewBox="990 920 200 180"');
writeFileSync('dev/_crockett.png', new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
console.log('wrote dev/_crockett.png');
