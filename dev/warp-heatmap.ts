/**
 * Density-warp heatmap. Visualizes WHERE the smoothed pipeline dilates vs
 * compresses space — i.e. the local area magnification of the density-equalizing
 * warp (src/render/layout/densityWarp.ts), which is what blows Manhattan up and
 * shrinks the empty edges before octilinearization.
 *
 * The warp is separable (x' = fx(x), y' = fy(y)), so a uniform input grid maps
 * to a non-uniform RECTANGULAR mesh. Each cell is filled by its magnification
 * J = (warped area / input area); J>1 = space stretched (warm), J<1 = squeezed
 * (cool), J=1 = untouched (white). The warped network is overlaid in the SAME
 * pre-octi space so you can see which areas the warp is enlarging.
 *
 * Usage: npx tsx dev/warp-heatmap.ts [dump.json] [out-prefix]
 *   honours OCTI_WARP / OCTI_CROWD / OCTI_MAXSCALE / OCTI_LINECAP so you can see
 *   exactly what a given knob does to the warp.
 */
process.env.OCTI_WARP_CAPTURE_ONLY = '1';
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { precomputeSmoothedSchematic } from '../src/render/schematic';
import { __warpDebug } from '../src/render/renderGeographic';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-difficult-nyc.json';
const outPrefix = process.argv[3] ?? 'dev/_warp-heatmap';
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;

const pre = precomputeSmoothedSchematic({
  routes: dump.routes, tracks: dump.tracks, stations: dump.stations, stationGroups: dump.stationGroups,
  geography: dump.geography,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
});
if (typeof pre === 'string' && pre !== 'CAPTURE_ONLY') { console.error('DEGENERATE render:', pre); process.exit(1); }
if (!__warpDebug) { console.error('no warp captured (warp disabled? OCTI_WARP=0?)'); process.exit(1); }

const { warp, width, height, nodes, edges } = __warpDebug;

// Separable: fx(x) = warp([x, 0])[0], fy(y) = warp([0, y])[1].
const N = 90; // grid cells per axis
const xs: number[] = [], ys: number[] = [];
for (let i = 0; i <= N; i++) { xs.push((i / N) * width); ys.push((i / N) * height); }
const X = xs.map((x) => warp([x, 0])[0]); // warped x grid lines
const Y = ys.map((y) => warp([0, y])[1]); // warped y grid lines

// magnification per cell = (ΔX/Δx)·(ΔY/Δy)
const sx = (i: number) => (X[i + 1] - X[i]) / (xs[i + 1] - xs[i]);
const sy = (j: number) => (Y[j + 1] - Y[j]) / (ys[j + 1] - ys[j]);

// warped extent → viewBox
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const v of X) { minX = Math.min(minX, v); maxX = Math.max(maxX, v); }
for (const v of Y) { minY = Math.min(minY, v); maxY = Math.max(maxY, v); }
const pad = 20;
const vbW = maxX - minX + 2 * pad, vbH = maxY - minY + 2 * pad;

// first pass: compute J per cell + the true symmetric log range, so the colour
// scale ADAPTS to the actual magnification (no fixed clamp hiding gradient)
const Js: number[][] = [];
let lhalf = 0.1;
for (let i = 0; i < N; i++) {
  Js[i] = [];
  for (let j = 0; j < N; j++) {
    const J = sx(i) * sy(j);
    Js[i][j] = J;
    lhalf = Math.max(lhalf, Math.abs(Math.log2(J)));
  }
}
// diverging colour over [-lhalf, +lhalf] in log2; blue=squeezed, red=stretched
const color = (J: number): string => {
  const t = Math.max(-1, Math.min(1, Math.log2(J) / lhalf));
  if (t >= 0) { const c = Math.round(255 * (1 - t)); return `rgb(255,${c},${c})`; }
  const c = Math.round(255 * (1 + t)); return `rgb(${c},${c},255)`;
};

let body = '';
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    body += `<rect x="${X[i].toFixed(1)}" y="${Y[j].toFixed(1)}" width="${(X[i + 1] - X[i]).toFixed(1)}" height="${(Y[j + 1] - Y[j]).toFixed(1)}" fill="${color(Js[i][j])}" stroke="#0000000a" stroke-width="0.3"/>`;
  }
}
// network overlay (warped, pre-octi space): white casing then dark line so it
// reads on both the red (stretched) and blue (squeezed) regions
let net = '';
for (const [a, b] of edges) {
  const p = nodes[a], q = nodes[b];
  net += `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="#fff" stroke-width="2.4" stroke-opacity="0.7"/>`;
}
for (const [a, b] of edges) {
  const p = nodes[a], q = nodes[b];
  net += `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="#111" stroke-width="1" stroke-opacity="0.85"/>`;
}
for (const p of nodes) net += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.6" fill="#111" stroke="#fff" stroke-width="0.5"/>`;

// legend
const lx = minX - pad + 12, ly = minY - pad + 12;
const fmt = (lg: number) => { const v = Math.pow(2, lg); return (v >= 1 ? v.toFixed(1) : v.toFixed(2)) + '×'; };
const stops: [string, string][] = ([[-1, 'squeezed'], [-0.5, ''], [0, '(no warp)'], [0.5, ''], [1, 'stretched']] as [number, string][])
  .map(([t, note]) => [color(Math.pow(2, t * lhalf)), `${fmt(t * lhalf)} ${note}`.trim()]);
let legend = `<g font-family="sans-serif" font-size="14"><rect x="${lx - 6}" y="${ly - 6}" width="186" height="${stops.length * 22 + 12}" fill="#ffffffdd" stroke="#888" stroke-width="0.5"/>`;
stops.forEach(([c, lbl], k) => {
  legend += `<rect x="${lx}" y="${ly + k * 22}" width="18" height="18" fill="${c}" stroke="#999" stroke-width="0.5"/><text x="${lx + 24}" y="${ly + k * 22 + 14}" fill="#111">${lbl}</text>`;
});
legend += `</g>`;

const svg = `<svg viewBox="${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" xmlns="http://www.w3.org/2000/svg"><rect x="${(minX - pad).toFixed(1)}" y="${(minY - pad).toFixed(1)}" width="${vbW.toFixed(1)}" height="${vbH.toFixed(1)}" fill="#fff"/>${body}${net}${legend}</svg>`;
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(outPrefix + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1500 }, background: 'white' }).render().asPng());

// stats
let jmin = Infinity, jmax = -Infinity;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const J = sx(i) * sy(j); jmin = Math.min(jmin, J); jmax = Math.max(jmax, J); }
console.log(`wrote ${outPrefix}.svg / .png — ${nodes.length} nodes, ${edges.length} edges; magnification range J=${jmin.toFixed(2)}..${jmax.toFixed(2)} (OCTI_WARP=${process.env.OCTI_WARP ?? '0.8 default'}, OCTI_CROWD=${process.env.OCTI_CROWD ?? '1 default'})`);
