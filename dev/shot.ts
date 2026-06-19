/**
 * Screenshot a single station's neighbourhood from a dump — for eyeballing
 * local layout/label changes without hunting pixel coordinates by hand.
 *
 * Usage:
 *   npx tsx dev/shot.ts <dump.json> "<station name or node id>" [out.png] [opts]
 * Options (key=value):
 *   span=<px>     crop window size in the 2700² render space (default 520)
 *   width=<px>    output PNG width (default 1100)
 * Env: any OCTI_* / IS_DARK pass through to the render, so you can A/B a flag:
 *   OCTI_NO_LABEL_REANCHOR=1 npx tsx dev/shot.ts <dump> "Morgan Av" before.png
 *
 * Resolves the target by exact node id (data-station-id) first, else by label
 * text (exact, then case-insensitive substring). Prints all matches; on
 * ambiguity it shoots the first and lists the rest so you can pass a node id.
 */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import type { GeographyData } from '../src/geography/types';

const [dumpPath, query, outArg, ...rest] = process.argv.slice(2);
if (!dumpPath || !query) {
  console.error('usage: tsx dev/shot.ts <dump.json> "<station name or node id>" [out.png] [span=520] [width=1100]');
  process.exit(1);
}
const opts = Object.fromEntries(rest.map((a) => a.split('=')));
const span = Number(opts.span) || 520;
const width = Number(opts.width) || 1100;
const out = outArg ?? 'dev/_shot.png';

const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;

const svg = generateSchematicSVG({
  routes: dump.routes,
  tracks: dump.tracks,
  stations: dump.stations,
  stationGroups: dump.stationGroups,
  geography: dump.geography as GeographyData | undefined,
  options: {
    mode: 'smoothed',
    width: 2700,
    height: 2700,
    showStations: true,
    showLabels: true,
    dark: process.env.IS_DARK === '1',
  },
});

// Each label is <g class="imp-lbl" data-station-id="ID" transform="translate(X,Y)">…<text …>NAME</text>
type Hit = { id: string; name: string; x: number; y: number };
const hits: Hit[] = [];
const re = /<g class="imp-lbl" data-station-id="([^"]+)" transform="translate\(([-\d.]+),([-\d.]+)\)">.*?<text [^>]*>([^<]*)<\/text>/g;
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) hits.push({ id: m[1], x: Number(m[2]), y: Number(m[3]), name: m[4] });

const q = query.toLowerCase();
let matches = hits.filter((h) => h.id === query);
if (matches.length === 0) matches = hits.filter((h) => h.name.toLowerCase() === q);
if (matches.length === 0) matches = hits.filter((h) => h.name.toLowerCase().includes(q));
if (matches.length === 0) {
  console.error(`no station matching "${query}". ${hits.length} labelled stations rendered.`);
  process.exit(2);
}
const target = matches[0];
console.log(`shot: "${target.name}" (${target.id}) at (${target.x.toFixed(0)},${target.y.toFixed(0)})` +
  (matches.length > 1 ? `  [+${matches.length - 1} more: ${matches.slice(1, 6).map((h) => `${h.name}/${h.id}`).join(', ')}]` : ''));

const vb = `${(target.x - span / 2).toFixed(1)} ${(target.y - span / 2).toFixed(1)} ${span} ${span}`;
const cropped = svg
  .replace(/viewBox="[^"]*"/, `viewBox="${vb}"`)
  .replace(/width="\d+"/, `width="${span}"`)
  .replace(/height="\d+"/, `height="${span}"`);
writeFileSync(out, new Resvg(cropped, { fitTo: { mode: 'width', value: width }, background: 'white' }).render().asPng());
console.log(`wrote ${out}  (span=${span} width=${width})`);
