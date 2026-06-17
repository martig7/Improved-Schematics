// Throwaway: parametrized crop of the labeled NYC-dump render.
// Usage: npx tsx dev/_crop-lbl.ts [x y w h [out]]
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const [x = '900', y = '850', w = '160', h = '140', out = 'dev/_ovd.png'] = process.argv.slice(2);
const svg = readFileSync('dev/_dumpnyclbl.svg', 'utf-8');
const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`);
writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 1000 }, background: 'white' }).render().asPng());
console.log('wrote ' + out);
