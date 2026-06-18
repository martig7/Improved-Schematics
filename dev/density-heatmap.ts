/**
 * Density heatmap — visualizes the EXCESS-density field that densityBoxWarp
 * thresholds (densityGrid2D), so we can see whether it's a sharp peak or a broad
 * plateau, and what a given percentile cutoff actually selects. Overlays the
 * cutoff contour + the resulting dense boxes, and prints the e distribution.
 *
 * Usage: npx tsx dev/density-heatmap.ts [dump.json] [out-prefix] [sigmaBins] [pct]
 *   honours OCTI_BOX_PCT etc. for the box overlay.
 */
process.env.OCTI_WARP_CAPTURE_ONLY = '1';
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import { __warpDebug } from '../src/render/renderGeographic';
import { densityGrid2D } from '../src/render/layout/densityWarp2d';
import { findDenseBoxes } from '../src/render/layout/densityBoxWarp';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-difficult-nyc.json';
const outPrefix = process.argv[3] ?? 'dev/_density';
const sigmaBins = Number(process.argv[4] ?? 2.5);
const frac = Number(process.argv[5] ?? 0.4); // cutoff as fraction of peak density
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;

// render once to capture the exact weighted warp samples
generateSchematicSVG({
  routes: dump.routes, tracks: dump.tracks, stations: dump.stations, stationGroups: dump.stationGroups,
  geography: dump.geography,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
});
if (!__warpDebug) { console.error('no warp captured'); process.exit(1); }
const { width, height, samples } = __warpDebug;
const box = { minX: 0, minY: 0, maxX: width, maxY: height };

const B = 96;
// maxScale: 1e9 disables densityGrid2D's clip — the clip (default 8) flattens
// the peak (Manhattan and the outer boroughs both peg at the cap), hiding the
// gradient box-finding needs.
const grid = densityGrid2D(samples, box, { bins: B, sigmaBins, maxScale: 1e9 });
const e = grid.e;

// distribution
const sorted = Array.from(e).sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(B * B - 1, Math.max(0, Math.floor((p / 100) * (B * B - 1))))];
const emax = sorted[B * B - 1];
const cutoff = frac * emax;
let above = 0;
for (let i = 0; i < B * B; i++) if (e[i] >= cutoff && e[i] > 0) above++;
console.log(`e: min=${sorted[0].toFixed(2)} median=${q(50).toFixed(2)} p90=${q(90).toFixed(2)} p99=${q(99).toFixed(2)} max=${emax.toFixed(2)}`);
console.log(`cutoff(${frac}·max)=${cutoff.toFixed(3)} → ${above}/${B * B} cells dense (${(100 * above / (B * B)).toFixed(1)}% of grid), sigmaBins=${sigmaBins}`);

// sequential heat: e<=0 faint blue, e>0 white→red by e/emax
const color = (v: number): string => {
  if (v <= 0) { const t = Math.min(1, -v); const c = Math.round(255 - 40 * t); return `rgb(${c},${c},255)`; }
  const t = emax > 0 ? Math.min(1, v / emax) : 0;
  return `rgb(255,${Math.round(255 * (1 - t))},${Math.round(255 * (1 - t * 0.85))})`;
};

const cw = width / B, ch = height / B;
let cells = '';
for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
  const v = e[j * B + i];
  const above2 = v >= cutoff && v > 0;
  cells += `<rect x="${(i * cw).toFixed(1)}" y="${(j * ch).toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" fill="${color(v)}"${above2 ? ' stroke="#000" stroke-width="0.6" stroke-opacity="0.5"' : ''}/>`;
}
// dense boxes for this pct
let boxes = '';
for (const b of findDenseBoxes(samples, box, { bins: B, sigmaBins, frac })) {
  boxes += `<rect x="${b.x0.toFixed(1)}" y="${b.y0.toFixed(1)}" width="${(b.x1 - b.x0).toFixed(1)}" height="${(b.y1 - b.y0).toFixed(1)}" fill="none" stroke="#00a" stroke-width="6"/>`;
}
const svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#fff"/>${cells}${boxes}<text x="20" y="40" font-family="sans-serif" font-size="34" fill="#000">e≤0 blue · peak red · cutoff cells outlined · dense boxes (blue), frac${frac} σ${sigmaBins}</text></svg>`;
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(outPrefix + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng());
console.log(`wrote ${outPrefix}.png`);
