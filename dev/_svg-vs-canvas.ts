/** Rasterize a city dump BOTH ways and overlay: SVG via resvg vs the Scene IR via
 *  drawScene on a headless canvas, at scale=1 (1:1 with the viewBox). Confirms
 *  drawScene's INTERPRETATION (stroke scale-modes, draw order, clip, label pass)
 *  matches the SVG — the piece scene-data parity can't see. Writes a side-by-side
 *  (svg | canvas | diff) PNG and prints the differing-pixel %.
 *  Cross-engine AA/font differences are expected and small; structural errors
 *  (wrong widths/order/positions) would show as large or blocky diff regions.
 *  Usage: npx tsx dev/_svg-vs-canvas.ts [dumpfile] */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { createCanvas, GlobalFonts, Path2D as NPath2D } from '@napi-rs/canvas';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import type { SceneOut } from '../src/render/renderOctilinear';
import { prepareScene, drawScene } from '../src/render/sceneCanvas';

// drawScene uses the global Path2D (browser); provide skia's in node.
(globalThis as { Path2D?: unknown }).Path2D = NPath2D;
for (const f of ['arial.ttf', 'arialbd.ttf']) {
  try { GlobalFonts.registerFromPath(`C:\\Windows\\Fonts\\${f}`, 'Helvetica'); } catch { /* ok */ }
}
try { GlobalFonts.registerFromPath('C:\\Windows\\Fonts\\arial.ttf', 'Arial'); } catch { /* ok */ }

const file = process.argv[2] ?? 'improvedschematics-input-chi.json';
const W = 2700, H = 2700;
const raw = JSON.parse(readFileSync(file, 'utf-8'));
const d = raw['debug-render-input'] ?? raw;
const input = {
  routes: d.routes, tracks: d.tracks, stations: d.stations,
  stationGroups: d.stationGroups, geography: d.geography,
  options: { mode: 'smoothed' as const, width: W, height: H, showStations: true, showLabels: true, dark: false },
};
console.log(`precompute ${file} …`);
const pre = precomputeSmoothedSchematic(input as never);
if (typeof pre === 'string') { console.log('degenerate'); process.exit(1); }
const out: SceneOut = { scene: null };
const svg = drawSmoothedSchematic(pre as never, input.options as never, out);

// --- SVG raster (resvg) ---
const rImg = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: true } }).render();
const svgPx = rImg.pixels; // RGBA, W*H

// --- Canvas raster (drawScene at scale=1) ---
const cnv = createCanvas(W, H);
const ctx = cnv.getContext('2d') as unknown as CanvasRenderingContext2D;
drawScene(ctx, prepareScene(out.scene!), { scale: 1, vx: 0, vy: 0 }, { dpr: 1, cssWidth: W, cssHeight: H });
const canvasPx = ctx.getImageData(0, 0, W, H).data; // RGBA

// --- diff (ignore the alpha channel; threshold tolerates AA/hinting) ---
const TH = 60;
const diff = new Uint8ClampedArray(W * H * 4);
let differing = 0, opaque = 0;
for (let i = 0; i < W * H; i++) {
  const o = i * 4;
  const sa = svgPx[o + 3], ca = canvasPx[o + 3];
  if (sa > 8 || ca > 8) opaque++;
  const dr = Math.abs(svgPx[o] - canvasPx[o]);
  const dg = Math.abs(svgPx[o + 1] - canvasPx[o + 1]);
  const db = Math.abs(svgPx[o + 2] - canvasPx[o + 2]);
  const bad = Math.max(dr, dg, db) > TH;
  if (bad) {
    differing++;
    diff[o] = 255; diff[o + 1] = 0; diff[o + 2] = 0; diff[o + 3] = 255;
  } else {
    // faint grey of the svg so the diff image keeps context
    const g = (svgPx[o] + svgPx[o + 1] + svgPx[o + 2]) / 3;
    const v = 200 + g * 0.2;
    diff[o] = v; diff[o + 1] = v; diff[o + 2] = v; diff[o + 3] = 255;
  }
}
const pct = (differing / opaque) * 100;
console.log(`differing pixels: ${differing} / ${opaque} opaque = ${pct.toFixed(2)}%  (threshold ${TH}/255)`);

// --- side-by-side composite (each panel S px wide) ---
const S = 760, GAP = 16, LBL = 26;
const comp = createCanvas(S * 3 + GAP * 2, S + LBL);
const cc = comp.getContext('2d');
cc.fillStyle = '#ffffff'; cc.fillRect(0, 0, comp.width, comp.height);
cc.fillStyle = '#111111'; cc.font = '16px Arial';
const panel = (px: Uint8ClampedArray | Uint8Array, x: number, label: string) => {
  const tmp = createCanvas(W, H);
  const tctx = tmp.getContext('2d');
  const id = tctx.createImageData(W, H);
  id.data.set(px);
  tctx.putImageData(id, 0, 0);
  cc.drawImage(tmp, x, LBL, S, S);
  cc.fillText(label, x + 4, 18);
};
panel(svgPx, 0, 'SVG (resvg)');
panel(canvasPx, S + GAP, 'Canvas (drawScene)');
panel(diff, (S + GAP) * 2, `Diff (red = >${TH}/255): ${pct.toFixed(2)}%`);
const tag = file.replace(/.*input-|.*dump-|\.json/g, '');
const outPng = `dev/_cmp-${tag}.png`;
writeFileSync(outPng, comp.toBuffer('image/png'));
console.log(`wrote ${outPng}`);
