// Throwaway (dHat sweep): downtown/north crop for global-fragmentation check.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
for (const d of [16, 12]) {
  let s = readFileSync(`dev/_parity-dhat${d}.svg`, 'utf-8');
  s = s.replace(/viewBox="[^"]*"/, 'viewBox="850 300 800 700"');
  writeFileSync(
    `dev/_parity-dhat${d}-north.png`,
    new Resvg(s, { fitTo: { mode: 'width', value: 1000 }, background: 'white' }).render().asPng(),
  );
  console.log(d);
}
