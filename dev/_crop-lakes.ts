// Throwaway: tight crop on the Lake Steilacoom Dr / Lake Av pair (marker
// separation check) from the live-dump render.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_lakes.png', '560 2160 180 140'],
  ['dev/_lakes-wide.png', '450 2050 400 320'],
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
