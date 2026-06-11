// Throwaway: crops of the Harvey Rd junction + 244 St bundle join.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_harvey.png', '1530 1790 200 170'],
  ['dev/_244st.png', '1230 1680 140 140'],
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 900 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
