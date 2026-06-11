// Throwaway: crop the 307 Pl / 320 Pl tail + the 88 Way bundle-exit area.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_307pl.png', '1650 1760 180 160'],
  ['dev/_88way.png', '1540 1640 180 160'],
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
