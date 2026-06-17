// Throwaway: crops of the live-dump render for hairpin verification.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_dump-west.png', '280 1280 440 440'],   // user screenshot loop location
  ['dev/_dump-spur.png', '820 590 440 440'],    // original NW spur location
];
for (const [out, box] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
