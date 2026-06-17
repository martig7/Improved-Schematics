// Throwaway: parametrized crop of any SVG.
// Usage: npx tsx dev/_crop-any.ts <in.svg> <x> <y> <w> <h> <out.png>
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const [file, x, y, w, h, out] = process.argv.slice(2);
const svg = readFileSync(file, 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`);
writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 1000 }, background: 'white' }).render().asPng());
console.log('wrote ' + out);
