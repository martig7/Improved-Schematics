import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
const svg = readFileSync('dev/out-sea-smooth.svg', 'utf-8');
// original viewBox 0 0 W H — find it
const vb = svg.match(/viewBox="([\d. ]+)"/)![1].split(' ').map(Number);
const [, , W, H] = vb;
const crops: Array<[string, number, number, number, number]> = [
  ['sw', 0.05 * W, 0.62 * H, 0.5 * W, 0.38 * H],   // cyan birds-nest area
  ['mid', 0.25 * W, 0.2 * H, 0.45 * W, 0.45 * H],  // central hubs
];
for (const [name, x, y, w, hh] of crops) {
  const cropped = svg.replace(/viewBox="[\d. ]+"/, `viewBox="${x} ${y} ${w} ${hh}"`);
  const r = new Resvg(cropped, { fitTo: { mode: 'width', value: 1100 } });
  writeFileSync(`dev/_sea-${name}.png`, r.render().asPng());
  console.log(`dev/_sea-${name}.png`);
}
