// Throwaway: crop the Tacoma window + full map from each _tg-* matrix SVG.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const tags: string[] = [];
for (const w of ['06', '03', '00']) for (const a of ['off', '005', '015']) tags.push(`_tg-w${w}-a${a}`);

for (const tag of tags) {
  const svgPath = `dev/${tag}.svg`;
  if (!existsSync(svgPath)) {
    console.log(`skip ${tag} (no svg)`);
    continue;
  }
  const svg = readFileSync(svgPath, 'utf-8');
  // Tacoma SW sub-network window
  const tac = svg.replace(/viewBox="[^"]*"/, 'viewBox="300 1900 900 800"');
  writeFileSync(
    `dev/${tag}-tacoma.png`,
    new Resvg(tac, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng(),
  );
  // Full map at the same width for global-health comparison
  writeFileSync(
    `dev/${tag}-full.png`,
    new Resvg(svg, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng(),
  );
  console.log(`cropped ${tag}`);
}
