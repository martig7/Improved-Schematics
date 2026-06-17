// Throwaway: parametrized crop of the NYC-dump render.
// Usage: npx tsx dev/_crop-nyc.ts [x y w h [out]]
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const [x = '900', y = '850', w = '160', h = '140', out = 'dev/_ovd.png'] = process.argv.slice(2);
const svg = readFileSync('dev/_dumpnyc.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`);
writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
console.log('wrote ' + out);
