// One-off: rasterize an SVG to PNG, optionally cropping a region.
// Usage: npx tsx dev/_raster.ts in.svg out.png [width] [cropX,cropY,cropW,cropH]
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
const [inp, outp] = [process.argv[2], process.argv[3]];
const w = +(process.argv[4] ?? 2200);
let svg = readFileSync(inp, 'utf-8');
if (process.argv[5]) {
  const [cx, cy, cw, ch] = process.argv[5].split(',').map(Number);
  svg = svg.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${cx} ${cy} ${cw} ${ch}" width="${cw}" height="${ch}">`);
}
const png = new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();
writeFileSync(outp, png);
console.log(`${inp} -> ${outp} @${w}px ${process.argv[5] ?? '(full)'}`);
