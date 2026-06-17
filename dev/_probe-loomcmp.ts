// Throwaway: render sub-crops of our smoothed SEA svg to pin down the hairpin location.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('dev/out-sea-smooth.svg', 'utf-8');
function crop(name: string, x: number, y: number, w: number, h: number, px = 1100) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`);
  writeFileSync(`dev/_probe-${name}.png`, new Resvg(s, { fitTo: { mode: 'width', value: px } }).render().asPng());
  console.log(name, 'done');
}
crop('nw-q1', 850, 650, 300, 300);
crop('nw-q2', 1150, 650, 300, 300);
crop('nw-q3', 850, 950, 300, 300);
crop('nw-q4', 1150, 950, 300, 300);
