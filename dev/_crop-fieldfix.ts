// Throwaway: crops of the user's four field-report windows after the
// station-fidelity round.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_ff-sw.png', '300 1900 900 800'],      // Tacoma overview (fingers + triangle)
  ['dev/_ff-tip.png', '540 2140 280 240'],     // Tacoma tip triangle, tight
  ['dev/_ff-320pl.png', '1660 1760 240 200'],  // 307/320 Pl terminus
  ['dev/_ff-94av.png', '1540 1000 240 200'],   // 94 Av (was in water)
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
