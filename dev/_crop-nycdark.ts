// Throwaway: parametrized crop of the dark NYC-dump render.
// Usage: npx tsx dev/_crop-nycdark.ts [x y w h [out]]
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const [x = '890', y = '1440', w = '180', h = '150', out = 'dev/_nyc-dark.png'] = process.argv.slice(2);
const svg = readFileSync('dev/_dumpnycdark.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`);
writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 900 } }).render().asPng());
console.log('wrote ' + out);
