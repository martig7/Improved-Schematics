/**
 * FAST no-octi warp preview. Captures the warp inputs (unwarped network + weighted
 * samples) before octi via OCTI_WARP_CAPTURE_ONLY (~1s, skips the ~70s octi pass),
 * then applies a tuned box warp and draws: the warp MESH (a uniform grid through
 * the warp — shows where space is stretched/compressed), the warped NETWORK, and
 * the dense box(es) being expanded. Lets us tune frac/expand/margin in seconds.
 *
 * Usage: npx tsx dev/warp-preview.ts [dump.json] [out-prefix] [frac] [expand] [margin] [growthCap]
 */
process.env.OCTI_WARP_CAPTURE_ONLY = '1';
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import { __warpDebug } from '../src/render/renderGeographic';
import { buildBoxExpandWarp, buildSepBoxWarp, findDenseBoxes } from '../src/render/layout/densityBoxWarp';
import type { Pixel } from '../src/render/layout/types';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-difficult-nyc.json';
const outPrefix = process.argv[3] ?? 'dev/_warp-preview';
const frac = Number(process.argv[4] ?? 0.4);
const expand = Number(process.argv[5] ?? 4);
const marginFrac = Number(process.argv[6] ?? 3);
const growthCap = Number(process.argv[7] ?? 1);
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const d = raw['debug-render-input'] ?? raw;

const t0 = Date.now ? 0 : 0; // (timing omitted — capture is the cost)
generateSchematicSVG({
  routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups,
  geography: d.geography,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
});
void t0;
if (!__warpDebug) { console.error('capture failed'); process.exit(1); }
const { width, height, nodesRaw, edges, samples } = __warpDebug;
const box = { minX: 0, minY: 0, maxX: width, maxY: height };

// OCTI_WARP_MODE=box → box only; default 'both' = separable global magnification
// + box local expansion (the dense box is found in separable-warped space, so its
// overlay is omitted here; the mesh shows the expansion).
const mode = process.env.OCTI_WARP_MODE ?? 'both';
const W = mode === 'box'
  ? buildBoxExpandWarp(samples, box, { frac, expand, marginFrac, growthCap })
  : buildSepBoxWarp(samples, box, { alpha: 0.8, maxScale: 8 }, { frac, expand, marginFrac, growthCap });
const boxes = mode === 'box' ? findDenseBoxes(samples, box, { frac }) : [];

// warped network nodes
const wn = nodesRaw.map((p) => W(p));
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const p of wn) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
const pad = 40;

// warp mesh: uniform grid lines pushed through the warp
const G = 36, SUB = 6;
let mesh = '';
const polyline = (pts: Pixel[]) => `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="#bbb" stroke-width="1"/>`;
for (let i = 0; i <= G; i++) {
  const colX: Pixel[] = [], rowY: Pixel[] = [];
  for (let j = 0; j <= G * SUB; j++) {
    colX.push(W([(i / G) * width, (j / (G * SUB)) * height]));
    rowY.push(W([(j / (G * SUB)) * width, (i / G) * height]));
  }
  mesh += polyline(colX) + polyline(rowY);
}
// network
let net = '';
for (const [a, b] of edges) net += `<line x1="${wn[a][0].toFixed(1)}" y1="${wn[a][1].toFixed(1)}" x2="${wn[b][0].toFixed(1)}" y2="${wn[b][1].toFixed(1)}" stroke="#06c" stroke-width="1.6" stroke-opacity="0.8"/>`;
for (const p of wn) net += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="#c30"/>`;
// dense boxes: unwarped region (dashed) + warped (solid) so you see the expansion
let bx = '';
for (const b of boxes) {
  bx += `<rect x="${b.x0.toFixed(1)}" y="${b.y0.toFixed(1)}" width="${(b.x1 - b.x0).toFixed(1)}" height="${(b.y1 - b.y0).toFixed(1)}" fill="none" stroke="#090" stroke-width="3" stroke-dasharray="10 8"/>`;
  const c = [W([b.x0, b.y0]), W([b.x1, b.y0]), W([b.x1, b.y1]), W([b.x0, b.y1])];
  bx += `<polygon points="${c.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="#090" stroke-width="3"/>`;
}

const vbX = Math.min(minX, 0) - pad, vbY = Math.min(minY, 0) - pad;
const vbW = Math.max(maxX, width) - vbX + pad, vbH = Math.max(maxY, height) - vbY + pad;
const svg = `<svg viewBox="${vbX.toFixed(0)} ${vbY.toFixed(0)} ${vbW.toFixed(0)} ${vbH.toFixed(0)}" xmlns="http://www.w3.org/2000/svg"><rect x="${vbX.toFixed(0)}" y="${vbY.toFixed(0)}" width="${vbW.toFixed(0)}" height="${vbH.toFixed(0)}" fill="#fff"/>${mesh}${bx}${net}<text x="${(vbX + 20).toFixed(0)}" y="${(vbY + 50).toFixed(0)}" font-family="sans-serif" font-size="40" fill="#000">${mode} warp · frac ${frac} · expand ${expand} · margin ${marginFrac} · growth ${growthCap}</text></svg>`;
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(outPrefix + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1400 }, background: 'white' }).render().asPng());
console.log(`wrote ${outPrefix}.png — ${wn.length} nodes, ${edges.length} edges, ${boxes.length} box(es), frac=${frac} expand=${expand} margin=${marginFrac} growth=${growthCap}`);
