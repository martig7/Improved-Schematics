/**
 * Render the NEW v2 dump (a serialized MapBundle) the way the game does: draw
 * the precomputed `pre` via drawSmoothed. This paints the EXACT cached ribbon
 * geometry — so the drawn route gaps are reproduced faithfully.
 *
 *   tsx dev/render-dump.ts [dump.json] [outPrefix] [opts]
 * opts:
 *   --recompute       delete pre.geometry → recompute via computeRibbonGeometry
 *                     (lets OCTI_* trace flags fire, and tests source fixes)
 *   --gaps            overlay red rings at every drawn gap (>= --vis px)
 *   --vis <px>        gap visibility threshold (default 2)
 *   --crop "<name>"   crop+zoom to the station whose label matches (substring)
 *   --span <px>       crop window in 2700² space (default 560)
 *   --width <px>      output PNG width (default 1300)
 * Env OCTI_JOIN_TRACE=<lineId> etc. pass through (need --recompute to fire).
 */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { deserializeMap } from '../src/render/persist';
import { drawSmoothedSchematic } from '../src/render/schematic';
import type { SmoothedPrecomputed } from '../src/render/schematic';
import type { Pixel } from '../src/render/layout/types';
import { analyzeLine } from './contig';

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(n);
const val = (n: string, d?: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--recompute' && args[i - 1] !== '--gaps'));
const dumpPath = positional[0] ?? 'improvedschematics-input-nyc-difficult-NEW.json';
const outPrefix = positional[1] ?? 'dev/_dumpv2';
const VIS = Number(val('--vis', '2'));
const span = Number(val('--span', '560'));
const width = Number(val('--width', '1300'));

const bundle = deserializeMap(readFileSync(dumpPath, 'utf-8'));
const pre = bundle.pre as SmoothedPrecomputed;
console.log(`dump ${dumpPath}: ${pre.width}x${pre.height} dark=${pre.dark} hasGeometry=${!!pre.geometry}`);

if (flag('--recompute')) { delete pre.geometry; console.log('cleared pre.geometry → will recompute'); }

const settings = (bundle.settings ?? {}) as { showLabels?: boolean; showStations?: boolean };
let svg = drawSmoothedSchematic(pre, {
  showLabels: process.env.IS_LABELS === '1' || !!settings.showLabels,
  showStations: process.env.IS_LABELS === '0' ? false : (settings.showStations ?? true),
});

// gap overlay — from the (now-final) pre.geometry
const geom = pre.geometry!;
const stationLabels: Array<{ pos: Pixel; label: string }> = [];
for (const st of pre.stations) { const p = pre.nodePx.get(st.nodeId); const l = pre.layout.nodes.get(st.nodeId)?.label; if (p && l) stationLabels.push({ pos: p, label: l }); }
const nearest = (p: Pixel): { label: string; pos: Pixel } => { let best = stationLabels[0]; let bd = Infinity; for (const s of stationLabels) { const d = (s.pos[0] - p[0]) ** 2 + (s.pos[1] - p[1]) ** 2; if (d < bd) { bd = d; best = s; } } return best; };

const allGaps: Array<{ at: Pixel; dist: number; label: string }> = [];
for (const [lineId, l] of geom.lineById) {
  const lr = analyzeLine(lineId, l.label ?? '?', l.color ?? '?', geom.dByLine.get(lineId) ?? []);
  for (const g of lr.gaps) if (g.dist >= VIS) allGaps.push({ at: g.at, dist: g.dist, label: l.label ?? lineId });
}
console.log(`drawn gaps >= ${VIS}px: ${allGaps.length}`);

if (flag('--gaps')) {
  const rings = allGaps.map((g) => `<circle cx="${g.at[0].toFixed(1)}" cy="${g.at[1].toFixed(1)}" r="13" fill="none" stroke="#ff2d2d" stroke-width="2.5"/>`).join('');
  svg = svg.replace('</svg>', `<g class="gap-markers">${rings}</g></svg>`);
}

// optional crop
let cropNote = '';
const cropXY = val('--cropxy');
if (cropXY) {
  const [cx, cy] = cropXY.split(',').map(Number);
  const vb = `${(cx - span / 2).toFixed(1)} ${(cy - span / 2).toFixed(1)} ${span} ${span}`;
  svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`).replace(/width="\d+"/, `width="${span}"`).replace(/height="\d+"/, `height="${span}"`);
  cropNote = ` (cropped @ ${cx},${cy})`;
}
const cropName = val('--crop');
if (cropName && !cropXY) {
  const match = stationLabels.find((s) => s.label.toLowerCase().includes(cropName.toLowerCase()));
  if (match) {
    const [cx, cy] = match.pos;
    const vb = `${(cx - span / 2).toFixed(1)} ${(cy - span / 2).toFixed(1)} ${span} ${span}`;
    svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`).replace(/width="\d+"/, `width="${span}"`).replace(/height="\d+"/, `height="${span}"`);
    cropNote = ` (cropped @ ${match.label})`;
  } else console.log(`no station matching "${cropName}"`);
}

writeFileSync(outPrefix + '.svg', svg);
writeFileSync(outPrefix + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: pre.dark ? '#18181b' : 'white' }).render().asPng());
console.log(`wrote ${outPrefix}.svg / .png${cropNote}`);
