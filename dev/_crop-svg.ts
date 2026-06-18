/** Crop an existing SVG to a design-coord window and rasterize (for before/
 *  after marker comparisons). Usage: tsx dev/_crop-svg.ts <in.svg> <out.png> cx cy half [scale] */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
const [, , inSvg, outPng, cxs, cys, halfs, scales] = process.argv;
const cx = Number(cxs), cy = Number(cys), half = Number(halfs), scale = Number(scales ?? 6);
const svg = readFileSync(inSvg, 'utf-8').replace(/viewBox="[^"]*"/, `viewBox="${cx - half} ${cy - half} ${2 * half} ${2 * half}"`);
writeFileSync(outPng, new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(2 * half * scale) }, background: 'white' }).render().asPng());
console.log(`wrote ${outPng} (window ${2 * half}px @ (${cx},${cy}), ${scale}×)`);
