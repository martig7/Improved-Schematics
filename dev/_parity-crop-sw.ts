// Throwaway: SW (Tacoma clump) crop of the current dump render.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/_dump.svg', 'utf-8');
const crops: Array<[string, string]> = [
  ['dev/_parity-dump-sw.png', '450 1850 1250 900'],
];
for (const [out, box] of crops) {
  const s = box ? svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`) : svg;
  writeFileSync(out, new Resvg(s, { fitTo: { mode: 'width', value: box ? 1000 : 800 }, background: 'white' }).render().asPng());
  console.log('wrote', out);
}
