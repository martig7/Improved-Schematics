// Throwaway: crops of the two terminus-branch areas (1 Pl yellow, 12 Av lime).
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_term-1pl.png', '1890 160 160 150'],
  ['dev/_term-12av.png', '2030 1260 160 150'],
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 800 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
