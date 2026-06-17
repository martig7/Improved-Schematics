// Throwaway: parametrized crop of the live-dump render.
// Usage: npx tsx dev/_crop-ovd.ts [x y w h]
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const [x = '900', y = '850', w = '160', h = '140'] = process.argv.slice(2);
const svg = readFileSync('dev/_dump.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`);
writeFileSync('dev/_ovd.png', new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
console.log('wrote dev/_ovd.png');
