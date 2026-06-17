// Throwaway: recentered Tacoma crops for the lower-warp configs (network
// shifts NE in SVG space when the density warp is weakened/disabled).
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const jobs: Array<[tag: string, vb: string]> = [
  ['_tg-w03-aoff', '550 1850 900 800'],
  ['_tg-w03-a005', '550 1850 900 800'],
  ['_tg-w03-a015', '550 1850 900 800'],
  ['_tg-w00-aoff', '850 1800 900 800'],
  ['_tg-w00-a005', '850 1800 900 800'],
  ['_tg-w00-a015', '850 1800 900 800'],
];
for (const [tag, vb] of jobs) {
  const svg = readFileSync(`dev/${tag}.svg`, 'utf-8').replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  writeFileSync(
    `dev/${tag}-tacoma2.png`,
    new Resvg(svg, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng(),
  );
  console.log(`recrop ${tag} @ ${vb}`);
}
