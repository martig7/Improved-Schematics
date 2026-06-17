import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
for (const label of ['c080', 'base']) {
  let svg = readFileSync(`dev/_spike-fs-${label}.svg`, 'utf-8');
  svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="300 1750 800 800"');
  writeFileSync(`dev/_spike-fs-${label}-sw.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1000 }, background: 'white' }).render().asPng());
}
console.log('done');
