/** Rasterize dev/out-smooth.svg and dev/out-loom-nyc.svg for visual comparison. */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

function toPng(svgPath: string, pngPath: string) {
  if (!existsSync(svgPath)) {
    console.error('Missing', svgPath);
    return;
  }
  const svg = readFileSync(svgPath, 'utf-8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1400 } }).render().asPng();
  writeFileSync(pngPath, png);
  console.log(`${svgPath} → ${pngPath} (${(svg.length / 1024).toFixed(0)} KB svg)`);
}

toPng('dev/out-smooth.svg', 'dev/out-smooth.png');
toPng('dev/out-loom-nyc.svg', 'dev/out-loom-nyc.png');
