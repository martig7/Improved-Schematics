// Throwaway: crops for the Lake pair re-fusion + 88 Way elbows.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_lakes2.png', '560 2160 180 140'],
  ['dev/_88way.png', '1540 1640 180 160'],
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
