/**
 * Render the "improved schematics" logo through the schematic pipeline, offline.
 *
 * Each word is rendered ALONE with its pass-through node to the NORTH (which is the
 * orientation octi lays out as a clean horizontal capsule) and composed into the logo
 * canvas. The pipeline's own rainbow tracks are kept; the shared node is far off-canvas
 * so the tracks run off the edge. A "down" word is vertically mirrored so its tail
 * flips to run off the BOTTOM (the pill/dots are symmetric; the letters are stripped
 * before mirroring and redrawn upright).
 *
 * Usage: npx tsx dev/render-logo.ts   → writes dev/logo.svg + dev/logo.png
 */
import { writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';
import { DARK_THEME } from '../src/render/types';
import { buildLogoDump } from './logo-dump';

// ── Layout tunables (output-pixel space) ─────────────────────────────────────
const CANVAS_W = 2080;
const CANVAS_H = 1220;
const BG = '#2a2d34'; // dark slate
const NORTH_DELTA = 0.02; // per-word edge length (world deg); node is always north
const FONT = 'Helvetica, Arial, sans-serif';
// word, target capsule width (px), top-left placement (px), and which way tracks run.
const LAYOUT: { text: string; targetW: number; px: number; py: number; dir: 'up' | 'down' }[] = [
  { text: 'improved', targetW: 980, px: 150, py: 400, dir: 'up' },
  { text: 'schematics', targetW: 1220, px: 700, py: 680, dir: 'down' },
];
// ─────────────────────────────────────────────────────────────────────────────

/** Render one word alone (node north → clean horizontal capsule) → full SVG string. */
function renderWord(text: string): string {
  const dump = buildLogoDump([{ text, anchor: [0, 0] }], { northDelta: NORTH_DELTA });
  return generateSchematicSVG({
    routes: dump.routes as never,
    tracks: dump.tracks as never,
    stations: dump.stations as never,
    stationGroups: dump.stationGroups,
    options: {
      mode: 'smoothed',
      width: 1600,
      height: 1600,
      showStations: true,
      showLabels: false,
      warpAlpha: 0,
      geographicAffinity: 0.5,
      dark: true,
      theme: { ...DARK_THEME },
    },
  });
}

/** Inner markup of an SVG (strip the root <svg …> … </svg> wrapper). */
function innerOf(svg: string): string {
  const open = svg.indexOf('>', svg.indexOf('<svg')) + 1;
  return svg.slice(open, svg.lastIndexOf('</svg>'));
}

/** Remove the full-canvas background rect so crops don't paint over each other. */
const stripBg = (s: string): string => s.replace(/<rect [^>]*width="1600" height="1600"[^>]*\/>/g, '');
/** Remove the pipeline's bullet letters (redrawn upright for mirrored words). */
const stripText = (s: string): string => s.replace(/<text x="[^"]*" y="[^"]*"[^>]*>[A-Za-z]<\/text>/g, '');

interface Dot { cx: number; cy: number; r: number }
function bulletDots(svg: string): Dot[] {
  return [...svg.matchAll(/<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)" fill="[^"]*" stroke="#[0-9a-fA-F]{6}"[^>]*data-line="[^"]*"/g)].map(
    (m) => ({ cx: +m[1], cy: +m[2], r: +m[3] }),
  );
}
/** Half-thickness of the capsule pill (its dark-mode border stroke / 2). */
function pillHalf(svg: string): number {
  const m = svg.match(/fill="none" stroke="#e4e4e7" stroke-width="([\d.]+)" stroke-linecap="round"/);
  return m ? +m[1] / 2 : 4;
}
interface Letter { char: string; cx: number; cy: number; fs: number }
function bulletLetters(svg: string): Letter[] {
  return [...svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*?font-size="([\d.]+)"[^>]*>([A-Za-z])<\/text>/g)].map((m) => {
    const fs = +m[3];
    return { char: m[4], cx: +m[1], cy: +m[2] - 0.36 * fs, fs }; // recover the glyph center
  });
}

const layers: string[] = [];
const clips: string[] = [];

LAYOUT.forEach((L, i) => {
  const svg = renderWord(L.text);
  const dots = bulletDots(svg);
  const r = dots[0].r;
  const minX = Math.min(...dots.map((d) => d.cx));
  const maxX = Math.max(...dots.map((d) => d.cx));
  const cy = dots.map((d) => d.cy).sort((a, b) => a - b)[dots.length >> 1];
  const ph = pillHalf(svg);
  const half = r + 4; // placement box (a little padding around the pill)
  const pillL = minX - half;
  const pillT = cy - half;
  const bbW = maxX - minX + 2 * half;
  const scale = L.targetW / bbW;
  const boxH = 2 * half * scale;
  const rowY = L.py + scale * half; // the bullet row in canvas space (both dirs)
  const pillEdge = (ph - 0.2) * scale; // clip right at the pill's outer edge; the lane nub lies just beyond

  // render-point → canvas-point. "down" reflects vertically about the pill center.
  const toCanvas = (x: number, y: number): [number, number] =>
    L.dir === 'up'
      ? [L.px + scale * (x - pillL), L.py + scale * (y - pillT)]
      : [L.px + scale * (x - pillL), L.py + boxH - scale * (y - pillT)];

  const placeTf = `translate(${L.px},${L.py}) scale(${scale.toFixed(4)}) translate(${(-pillL).toFixed(2)},${(-pillT).toFixed(2)})`;
  const body = stripBg(innerOf(svg));
  const placed =
    L.dir === 'up'
      ? `<g transform="${placeTf}">${body}</g>`
      : `<g transform="translate(0,${(2 * (L.py + boxH / 2)).toFixed(1)}) scale(1,-1)"><g transform="${placeTf}">${stripText(body)}</g></g>`;

  // Upright letters for mirrored words (the mirror flips the pipeline's glyphs).
  let overlay = '';
  if (L.dir === 'down') {
    for (const g of bulletLetters(svg)) {
      const [X, Y] = toCanvas(g.cx, g.cy);
      const fs = g.fs * scale;
      overlay += `<text x="${X.toFixed(1)}" y="${(Y + 0.36 * fs).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="${fs.toFixed(1)}" font-weight="bold" fill="#ffffff">${g.char}</text>`;
    }
  }

  // Open the clip to the canvas edge on the TAIL side; hug the pill on the far side
  // (that's where the lane overshoot "nub" sits — cropped here).
  const clip =
    L.dir === 'up'
      ? { x: 0, y: 0, w: CANVAS_W, h: rowY + pillEdge } // tail off the top; nub below cut
      : { x: 0, y: rowY - pillEdge, w: CANVAS_W, h: CANVAS_H - (rowY - pillEdge) }; // tail off the bottom; nub above cut
  clips.push(`<clipPath id="clip${i}"><rect x="${clip.x}" y="${clip.y.toFixed(1)}" width="${clip.w}" height="${clip.h.toFixed(1)}"/></clipPath>`);
  layers.push(`<g clip-path="url(#clip${i})">${placed}${overlay}</g>`);
  console.log(`${L.text.padEnd(11)} pill w=${bbW.toFixed(1)} → ${L.targetW}px at (${L.px},${L.py}) tail ${L.dir}`);
});

const out =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" width="${CANVAS_W}" height="${CANVAS_H}">` +
  `<defs>${clips.join('')}</defs>` +
  `<rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${BG}"/>` +
  layers.join('') +
  `</svg>`;

writeFileSync('dev/logo.svg', out);
writeFileSync('dev/logo.png', new Resvg(out, { fitTo: { mode: 'width', value: CANVAS_W }, background: BG }).render().asPng());
console.log('wrote dev/logo.svg / dev/logo.png');
