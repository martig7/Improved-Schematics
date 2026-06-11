// Throwaway: crop the overdraw location SE (2282-2326, 2076-2087).
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, 'viewBox="1100 1000 120 90"');
writeFileSync('dev/_ovd.png', new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
console.log('wrote dev/_ovd.png');
