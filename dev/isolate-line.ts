/**
 * Paint a SINGLE line's drawn dByLine geometry (nothing else) for a crisp
 * before/after of a contiguity fix. Compares the dump's CACHED geometry (the
 * shipped/buggy draw) against a RECOMPUTE (current source) for the same line.
 *
 *   tsx dev/isolate-line.ts <label> [dump.json] [cx,cy] [span]
 */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { deserializeMap } from '../src/render/persist';
import { drawSmoothedSchematic } from '../src/render/schematic';
import type { SmoothedPrecomputed } from '../src/render/schematic';

const label = process.argv[2] ?? '1';
const dumpPath = process.argv[3] ?? 'improvedschematics-input-nyc-difficult-NEW.json';
const center = (process.argv[4] ?? '1244,1364').split(',').map(Number);
const span = Number(process.argv[5] ?? 220);

function paintOnly(pre: SmoothedPrecomputed): { d: string; color: string } {
  const geom = pre.geometry!;
  let lineId = label, color = '#ee352e';
  for (const [id, l] of geom.lineById) if (l.label === label || id === label) { lineId = id; color = l.color; break; }
  const d = (geom.dByLine.get(lineId) ?? []).join(' ');
  return { d, color };
}

function svgFor(pre: SmoothedPrecomputed, title: string): string {
  const { d, color } = paintOnly(pre);
  const vb = `${center[0] - span / 2} ${center[1] - span / 2} ${span} ${span}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${span}" height="${span}">` +
    `<rect x="0" y="0" width="2700" height="2700" fill="#18181b"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    // endpoint dots: reveal every sub-path break as a visible dot pair
    `</svg>`;
}

// cached (as shipped in dump)
const b1 = deserializeMap(readFileSync(dumpPath, 'utf-8'));
const preCached = b1.pre as SmoothedPrecomputed;
// force-draw to populate geometry if absent (cached dumps already have it)
drawSmoothedSchematic(preCached, { showLabels: false, showStations: false });
const svgBefore = svgFor(preCached, 'cached');

// recomputed (current source)
const b2 = deserializeMap(readFileSync(dumpPath, 'utf-8'));
const preRecomp = b2.pre as SmoothedPrecomputed;
delete preRecomp.geometry;
drawSmoothedSchematic(preRecomp, { showLabels: false, showStations: false });
const svgAfter = svgFor(preRecomp, 'recompute');

const W = 760;
const pb = new Resvg(svgBefore, { fitTo: { mode: 'width', value: W }, background: '#18181b' }).render().asPng();
const pa = new Resvg(svgAfter, { fitTo: { mode: 'width', value: W }, background: '#18181b' }).render().asPng();
writeFileSync('dev/_iso-before.png', pb);
writeFileSync('dev/_iso-after.png', pa);
const b64 = (x: Buffer): string => x.toString('base64');
const comp = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * 2 + 30}" height="${W + 40}">` +
  `<rect width="100%" height="100%" fill="#000"/>` +
  `<image x="10" y="30" width="${W}" height="${W}" xlink:href="data:image/png;base64,${b64(pb)}"/>` +
  `<image x="${W + 20}" y="30" width="${W}" height="${W}" xlink:href="data:image/png;base64,${b64(pa)}"/>` +
  `<text x="${W / 2}" y="22" fill="#fff" font-family="sans-serif" font-size="16" text-anchor="middle">line ${label} BEFORE (cached/shipped)</text>` +
  `<text x="${W + 20 + W / 2}" y="22" fill="#fff" font-family="sans-serif" font-size="16" text-anchor="middle">line ${label} AFTER (fixed)</text>` +
  `</svg>`;
writeFileSync('dev/_iso-compare.png', new Resvg(comp, { fitTo: { mode: 'width', value: W * 2 + 30 } }).render().asPng());
console.log(`wrote dev/_iso-compare.png (line ${label} @ ${center} span ${span})`);
