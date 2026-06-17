// Throwaway: Task-1 verification crops of the live-dump render.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_t1-center.png', '880 1130 360 400'], // blue/pink window
  ['dev/_t1-sw.png', '300 1900 900 800'],     // Tacoma clump
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
