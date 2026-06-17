// Throwaway: center crop of the live-dump render (blue/pink separation gate).
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_dump-center.png', '1000 1250 800 500'],
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 1200 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
