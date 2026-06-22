/** Render the smoothed map as it appears in game WITH detail areas: the main map
 *  with each selection cut out, a colored dashed outline around each cut, and the
 *  re-simulated detail panel placed as a callout (colored border + header), all
 *  composited into one SVG/PNG. Mirrors SchematicPanel + DetailInset headlessly.
 *  Usage: OCTI_WARP=0.8 npx tsx dev/_ingame.ts */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import { cropSubgraph } from '../src/render/cropSubgraph';

// Mirrors SEL_COLORS in src/ui/DetailInset.tsx (inlined; importing it would drag React).
const SEL_COLORS = ['#22d3ee', '#e879f9', '#fb923c', '#4ade80']; // cyan, magenta, orange, green

process.env.OCTI_WARP = process.env.OCTI_WARP ?? '0.8';
const raw = JSON.parse(readFileSync('improvedschematics-input-sf-difficult.json', 'utf-8'));
const d = raw['debug-render-input'] ?? raw;
const W = 2700, H = 2700;
const showStations = true;
const input = { routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups, geography: d.geography, options: { mode: 'smoothed' as const, width: W, height: H, showStations, showLabels: false, dark: true } };

const pre = precomputeSmoothedSchematic(input as never);
if (typeof pre === 'string') { console.log('degenerate'); process.exit(0); }
const preO = pre as { stationPx: Map<string, [number, number]>; unproject: (p: [number, number]) => [number, number] };
let mainSvg = drawSmoothedSchematic(pre as never, input.options as never);

type Box = { x0: number; y0: number; x1: number; y1: number };
type Frame = { x: number; y: number; w: number; h: number };
// Representative SF selections. `at` overrides the panel's top-left (content
// coords) — as if the user dragged the callout to a clear spot; omit it for the
// in-game default (a 2.5x callout just to the right of the box). A thin leader
// ties each panel to its outline; colors match (cyan, magenta, orange, green).
// `name` replaces the "DETAIL" header label (blank = "DETAIL").
const rawBoxes: { box: Box; at?: { x: number; y: number }; name?: string }[] = [
  { box: { x0: 1130, y0: 970, x1: 1360, y1: 1210 }, at: { x: 1780, y: 200 }, name: 'Downtown' },
  { box: { x0: 1080, y0: 1320, x1: 1300, y1: 1540 }, at: { x: 1780, y: 1560 }, name: 'Mission' },
];

interface Sel { box: Box; color: string; name: string; sub: string; gf: Frame; rect: Frame }
const sels: Sel[] = [];
rawBoxes.forEach(({ box, at, name }, i) => {
  const color = SEL_COLORS[i % SEL_COLORS.length];
  const core = new Set<string>();
  for (const [sid, px] of preO.stationPx) if (px[0] >= box.x0 && px[0] <= box.x1 && px[1] >= box.y0 && px[1] <= box.y1) core.add(sid);
  if (core.size < 2) { console.log(`box ${i}: <2 core stations, skipped`); return; }
  const bl = preO.unproject([box.x0, box.y1]);
  const tr = preO.unproject([box.x1, box.y0]);
  const sub = cropSubgraph(input as never, core, [bl[0], bl[1], tr[0], tr[1]]);
  const subPre = precomputeSmoothedSchematic(sub);
  if (typeof subPre === 'string') { console.log(`box ${i}: sub degenerate`); return; }
  const subSvg = drawSmoothedSchematic(subPre as never, { showLabels: false, showStations } as never);
  const gf = (subPre as { geoBboxFrame?: Frame }).geoBboxFrame ?? { x: 0, y: 0, w: W, h: H };
  const bw = box.x1 - box.x0;
  const rectW = bw * 2.5;
  const headerH = rectW * 0.06;
  const bodyH = rectW * (gf.h / gf.w);
  const pos = at ?? { x: box.x1 + bw * 0.4, y: box.y0 }; // default: in-game to-the-right callout
  const rect: Frame = { x: pos.x, y: pos.y, w: rectW, h: bodyH + headerH };
  sels.push({ box, color, name: name ?? '', sub: subSvg, gf, rect });
  console.log(`box ${i} (${color}): core ${core.size}, panel ${Math.round(rect.w)}x${Math.round(rect.h)} @ ${Math.round(rect.x)},${Math.round(rect.y)}`);
});

// Union cutout on the main map (lines/stations inside every box removed; geography kept).
const BIG = 270000;
let dPath = `M${-BIG} ${-BIG}H${BIG}V${BIG}H${-BIG}Z`;
for (const s of sels) dPath += `M${s.box.x0} ${s.box.y0}H${s.box.x1}V${s.box.y1}H${s.box.x0}Z`;
const cutDefs = `<defs class="imp-cutout"><clipPath id="imp-cutout-clip" clipPathUnits="userSpaceOnUse"><path d="${dPath}" clip-rule="evenodd"/></clipPath></defs>`;
mainSvg = mainSvg.replace(/(<svg[^>]*>)/, `$1${cutDefs}`);
for (const cls of ['edges', 'stops', 'stations']) mainSvg = mainSvg.replace(`<g class="${cls}">`, `<g class="${cls}" clip-path="url(#imp-cutout-clip)">`);
const mainInner = mainSvg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// Composite extent = map ∪ panels (+ margin).
let exX0 = 0, exY0 = 0, exX1 = W, exY1 = H;
for (const s of sels) { exX0 = Math.min(exX0, s.rect.x); exY0 = Math.min(exY0, s.rect.y); exX1 = Math.max(exX1, s.rect.x + s.rect.w); exY1 = Math.max(exY1, s.rect.y + s.rect.h); }
const M = 70; exX0 -= M; exY0 -= M; exX1 += M; exY1 += M;
const EW = exX1 - exX0, EH = exY1 - exY0;
const outlineStroke = EW * 0.0016, dash = EW * 0.006;

const outline = (s: Sel): string =>
  `<rect x="${s.box.x0}" y="${s.box.y0}" width="${s.box.x1 - s.box.x0}" height="${s.box.y1 - s.box.y0}" rx="3" fill="none" stroke="${s.color}" stroke-width="${outlineStroke}" stroke-dasharray="${dash} ${dash}"/>`;

// Thin leader from the box to its panel, so each callout ties to its outline.
const leader = (s: Sel): string => {
  const cx = (s.box.x0 + s.box.x1) / 2, cy = (s.box.y0 + s.box.y1) / 2;
  const px = s.rect.x < cx ? s.rect.x + s.rect.w : s.rect.x; // nearest vertical edge
  const py = s.rect.y + s.rect.h / 2;
  return `<line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="${s.color}" stroke-width="${outlineStroke * 0.7}" stroke-dasharray="${dash * 0.5} ${dash * 0.5}" opacity="0.5"/>`;
};

const panel = (s: Sel): string => {
  const r = s.rect, gf = s.gf;
  const headerH = r.w * 0.06;
  const fontPx = headerH * 0.58;
  const nested = s.sub.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" x="${r.x}" y="${r.y + headerH}" width="${r.w}" height="${r.h - headerH}" viewBox="${gf.x} ${gf.y} ${gf.w} ${gf.h}" preserveAspectRatio="xMidYMid meet">`);
  return [
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="#18181b" stroke="${s.color}" stroke-width="${r.w * 0.006}"/>`,
    nested,
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${headerH}" fill="${s.color}" opacity="0.32"/>`,
    `<text x="${r.x + headerH * 0.4}" y="${r.y + headerH * 0.7}" font-family="sans-serif" font-size="${fontPx}" font-weight="600" fill="#e5e5e5">${s.name.trim() ? s.name : ''}</text>`,
    `<text x="${r.x + r.w - headerH * 0.45}" y="${r.y + headerH * 0.7}" font-family="sans-serif" font-size="${fontPx}" fill="#e5e5e5" text-anchor="end">✕</text>`,
  ].join('\n');
};

const composite =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${exX0} ${exY0} ${EW} ${EH}" width="${EW}" height="${EH}">` +
  `<rect x="${exX0}" y="${exY0}" width="${EW}" height="${EH}" fill="#18181b"/>` +
  mainInner +
  sels.map(leader).join('\n') +
  sels.map(outline).join('\n') +
  sels.map(panel).join('\n') +
  `</svg>`;

writeFileSync('dev/_ingame.png', new Resvg(composite, { fitTo: { mode: 'width', value: 1600 }, background: '#18181b' }).render().asPng());
console.log(`wrote dev/_ingame.png (${sels.length} detail areas)`);
