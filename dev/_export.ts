/** Verify buildExportSvg's area composition headlessly: build the main map, run
 *  the SAME string-surgery the export does (union cutout + outlines + leaders +
 *  nested callout panels, framed on data-frame ∪ panels), write the SVG, and
 *  rasterize it (resvg succeeding == valid markup). Usage: npx tsx dev/_export.ts */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import { cropSubgraph } from '../src/render/cropSubgraph';

process.env.OCTI_WARP = process.env.OCTI_WARP ?? '0.8';
const raw = JSON.parse(readFileSync('improvedschematics-input-sf-difficult.json', 'utf-8'));
const d = raw['debug-render-input'] ?? raw;
const W = 2700, H = 2700, showStations = true;
const input = { routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups, geography: d.geography, options: { mode: 'smoothed' as const, width: W, height: H, showStations, showLabels: false, dark: true } };

const pre = precomputeSmoothedSchematic(input as never);
if (typeof pre === 'string') { console.log('degenerate'); process.exit(0); }
const preO = pre as { stationPx: Map<string, [number, number]>; unproject: (p: [number, number]) => [number, number] };
const svg = drawSmoothedSchematic(pre as never, input.options as never);

type Box = { x0: number; y0: number; x1: number; y1: number };
type Rect = { x: number; y: number; w: number; h: number };
const rawBoxes: { box: Box; at: { x: number; y: number }; name: string; color: string }[] = [
  { box: { x0: 1130, y0: 970, x1: 1360, y1: 1210 }, at: { x: 1780, y: 200 }, name: 'Downtown', color: '#22d3ee' },
  { box: { x0: 1080, y0: 1320, x1: 1300, y1: 1540 }, at: { x: 1780, y: 1560 }, name: '', color: '#e879f9' },
];

// Build per-area descriptors exactly as the live DetailInset does.
type Area = { s: { box: Box; color: string; name: string }; rect: Rect; subSvg: string; gf: Rect };
const areas: Area[] = [];
for (const { box, at, name, color } of rawBoxes) {
  const core = new Set<string>();
  for (const [sid, px] of preO.stationPx) if (px[0] >= box.x0 && px[0] <= box.x1 && px[1] >= box.y0 && px[1] <= box.y1) core.add(sid);
  if (core.size < 2) continue;
  const bl = preO.unproject([box.x0, box.y1]); const tr = preO.unproject([box.x1, box.y0]);
  const subPre = precomputeSmoothedSchematic(cropSubgraph(input as never, core, [bl[0], bl[1], tr[0], tr[1]]));
  if (typeof subPre === 'string') continue;
  const subSvg = drawSmoothedSchematic(subPre as never, { showLabels: false, showStations } as never);
  const gf = (subPre as { geoBboxFrame?: Rect }).geoBboxFrame ?? { x: 0, y: 0, w: W, h: H };
  const w = (box.x1 - box.x0) * 2.5;
  const rect: Rect = { x: at.x, y: at.y, w, h: w * (gf.h / gf.w) }; // child sets h = bodyH
  areas.push({ s: { box, color, name }, rect, subSvg, gf });
}

// data-frame from the main svg (the export's base extent).
const frN = (svg.match(/data-frame="([^"]*)"/)?.[1] ?? '').trim().split(/\s+/).map(Number);
const frame = frN.length === 4 && frN[2] > 0 ? { x: frN[0], y: frN[1], w: frN[2], h: frN[3] } : { x: 0, y: 0, w: W, h: H };

// --- the composition (verbatim shape of buildExportSvg's areas branch) ---
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bg = '#18181b';
const BIG = Math.max(W, H) * 100;
let dPath = `M${-BIG} ${-BIG}H${BIG}V${BIG}H${-BIG}Z`;
for (const a of areas) dPath += `M${a.s.box.x0} ${a.s.box.y0}H${a.s.box.x1}V${a.s.box.y1}H${a.s.box.x0}Z`;
const cutDefs = `<defs><clipPath id="imp-export-cut" clipPathUnits="userSpaceOnUse"><path d="${dPath}" clip-rule="evenodd"/></clipPath></defs>`;
let main = svg.replace(/ data-frame="[^"]*"/, '').replace(/(<svg[^>]*>)/, `$1${cutDefs}`);
for (const cls of ['edges', 'stops', 'stations']) main = main.replace(`<g class="${cls}">`, `<g class="${cls}" clip-path="url(#imp-export-cut)">`);
const mainInner = main.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

let x0 = frame.x, y0 = frame.y, x1 = frame.x + frame.w, y1 = frame.y + frame.h;
for (const a of areas) { x0 = Math.min(x0, a.rect.x); y0 = Math.min(y0, a.rect.y); x1 = Math.max(x1, a.rect.x + a.rect.w); y1 = Math.max(y1, a.rect.y + a.rect.h); }
const mg = Math.max(W, H) * 0.02; x0 -= mg; y0 -= mg; x1 += mg; y1 += mg;
const EW = x1 - x0, EH = y1 - y0;
const stroke = EW * 0.0016, dash = EW * 0.006;

const parts: string[] = [`<rect x="${x0}" y="${y0}" width="${EW}" height="${EH}" fill="${bg}"/>`, mainInner];
for (const a of areas) {
  const cx = (a.s.box.x0 + a.s.box.x1) / 2, cy = (a.s.box.y0 + a.s.box.y1) / 2;
  const px = a.rect.x < cx ? a.rect.x + a.rect.w : a.rect.x;
  parts.push(`<line x1="${cx}" y1="${cy}" x2="${px}" y2="${a.rect.y + a.rect.h / 2}" stroke="${a.s.color}" stroke-width="${stroke * 0.7}" stroke-dasharray="${dash * 0.5} ${dash * 0.5}" opacity="0.5"/>`);
}
for (const a of areas) {
  const b = a.s.box;
  parts.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" rx="3" fill="none" stroke="${a.s.color}" stroke-width="${stroke}" stroke-dasharray="${dash} ${dash}"/>`);
}
for (const a of areas) {
  const r = a.rect, gf = a.gf;
  const headerH = r.w * 0.06, fontPx = headerH * 0.58;
  const label = a.s.name.trim() ? a.s.name.trim() : 'DETAIL';
  const nested = a.subSvg.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" x="${r.x}" y="${r.y + headerH}" width="${r.w}" height="${r.h - headerH}" viewBox="${gf.x} ${gf.y} ${gf.w} ${gf.h}" preserveAspectRatio="xMidYMid meet">`);
  parts.push(
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${bg}" stroke="${a.s.color}" stroke-width="${r.w * 0.006}"/>`,
    nested,
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${headerH}" fill="${a.s.color}" opacity="0.32"/>`,
    `<text x="${r.x + headerH * 0.4}" y="${r.y + headerH * 0.7}" font-family="sans-serif" font-size="${fontPx}" font-weight="600" fill="#e5e5e5">◳ ${esc(label)}</text>`,
  );
}
const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${EW} ${EH}" width="${EW}" height="${EH}">${parts.join('')}</svg>`;

writeFileSync('dev/_export.svg', markup);
writeFileSync('dev/_export.png', new Resvg(markup, { fitTo: { mode: 'width', value: 1600 } }).render().asPng());
console.log(`composed ${areas.length} areas; extent ${Math.round(EW)}x${Math.round(EH)}; wrote dev/_export.svg + .png`);
