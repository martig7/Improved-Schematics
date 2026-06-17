import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
let svg = readFileSync('dev/out-loom-sea.svg', 'utf-8');
function crop(name: string, x: number, y: number, w: number, h: number, px = 1200) {
  let s = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`)
             .replace(/width="[^"]*"/, `width="${w}"`).replace(/height="[^"]*"/, `height="${h}"`);
  s = s.replace(/<g>/, '<g><rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#ffffff"/>');
  writeFileSync(`dev/_probe-${name}.png`, new Resvg(s, { fitTo: { mode: 'width', value: px }, background: 'white' }).render().asPng());
  console.log(name, 'done');
}
// spur region: stations span x 2080-2550, y 4660-6150
crop('loom-spur', 1750, 4350, 1300, 2200, 1300);
