// Throwaway (dHat sweep): tight zoom crops of the blue/pink diagonal and the
// Tacoma clump from the already-rendered per-dHat SVGs.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const CENTER_VB = '880 1130 360 400'; // blue/pink diagonal tight
const SW_VB = '450 1850 750 650'; // Tacoma clump tight

function crop(svgPath: string, vb: string, outPng: string, width: number) {
  let svg = readFileSync(svgPath, 'utf-8');
  svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  writeFileSync(
    outPng,
    new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'white' }).render().asPng(),
  );
}

for (const d of [16, 12, 8, 6, 4]) {
  const p = `dev/_parity-dhat${d}`;
  if (!existsSync(`${p}.svg`)) continue;
  crop(`${p}.svg`, CENTER_VB, `${p}-centerzoom.png`, 900);
  crop(`${p}.svg`, SW_VB, `${p}-swzoom.png`, 1000);
  console.log(`${p}-centerzoom.png / -swzoom.png`);
}
