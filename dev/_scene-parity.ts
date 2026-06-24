/** Real-data Phase 3 verification: for each city dump, render smoothed with the
 *  Scene-IR sink, then assert the DIRECT-emitted scene (what the canvas paints)
 *  matches sceneFromSvg(svg) (the proven parser oracle) EXACTLY, per layer — path
 *  d-strings verbatim, coords within .2px, colors/text/worldScale exact. Also
 *  checks additivity (sink does not change the svg). Exits nonzero on any diff.
 *  Usage: npx tsx dev/_scene-parity.ts */
import { readFileSync } from 'fs';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import type { SceneOut } from '../src/render/renderOctilinear';
import { sceneFromSvg } from '../src/render/sceneFromSvg';
import type { Prim, Scene, Layer } from '../src/render/sceneIR';

const DUMPS = [
  'improvedschematics-input-nyc.json',
  'improvedschematics-input-lon-full-warp.json',
  'improvedschematics-input-chi.json',
  'improvedschematics-input-sf-difficult.json',
  'improvedschematics-dump-sea-w-geo.json',
];
const W = 2700, H = 2700;
const near = (a: number, b: number, tol = 0.2) => Math.abs(a - b) <= tol;

function primDiff(a: Prim, b: Prim): string | null {
  if (a.kind !== b.kind) return `kind ${a.kind}!=${b.kind}`;
  if (a.worldScale !== b.worldScale) return `worldScale ${a.worldScale}!=${b.worldScale}`;
  if ((a.opacity ?? 1) !== (b.opacity ?? 1)) return `opacity ${a.opacity}!=${b.opacity}`;
  if (a.kind === 'path' && b.kind === 'path') {
    if (a.d !== b.d) return `d mismatch`;
    if (a.fill !== b.fill) return `fill ${a.fill}!=${b.fill}`;
    if (a.stroke !== b.stroke) return `stroke ${a.stroke}!=${b.stroke}`;
    if (!near(a.strokeWidth, b.strokeWidth, 0.05)) return `strokeWidth ${a.strokeWidth}!=${b.strokeWidth}`;
    if ((a.fillRule ?? null) !== (b.fillRule ?? null)) return `fillRule ${a.fillRule}!=${b.fillRule}`;
  } else if (a.kind === 'circle' && b.kind === 'circle') {
    if (!(near(a.cx, b.cx) && near(a.cy, b.cy) && near(a.r, b.r))) return `circle geom`;
    if (a.fill !== b.fill || a.stroke !== b.stroke) return `circle color`;
    if (!near(a.strokeWidth, b.strokeWidth, 0.05)) return `circle sw`;
  } else if (a.kind === 'rect' && b.kind === 'rect') {
    if (!(near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h))) return `rect geom`;
    if (a.fill !== b.fill || a.stroke !== b.stroke) return `rect color`;
  } else if (a.kind === 'line' && b.kind === 'line') {
    if (!(near(a.x1, b.x1) && near(a.y1, b.y1) && near(a.x2, b.x2) && near(a.y2, b.y2))) return `line geom`;
  } else if (a.kind === 'text' && b.kind === 'text') {
    if (a.text !== b.text) return `text "${a.text}"!="${b.text}"`;
    if (a.align !== b.align) return `align ${a.align}!=${b.align}`;
    if (!(near(a.ax, b.ax) && near(a.ay, b.ay))) return `text anchor`;
    if (!(near(a.x, b.x) && near(a.y, b.y))) return `text offset`;
    if (!near(a.fontSize, b.fontSize, 0.05)) return `fontSize`;
    if (a.fill !== b.fill) return `text fill`;
  }
  return null;
}

function compare(direct: Scene, parsed: Scene): { layer: Layer; dc: number; pc: number; diffs: string[] }[] {
  const layers = new Set<Layer>([...direct.prims, ...parsed.prims].map((p) => p.layer));
  const rows: { layer: Layer; dc: number; pc: number; diffs: string[] }[] = [];
  for (const layer of layers) {
    const da = direct.prims.filter((p) => p.layer === layer);
    const db = parsed.prims.filter((p) => p.layer === layer);
    const diffs: string[] = [];
    if (da.length !== db.length) diffs.push(`COUNT direct ${da.length} vs parsed ${db.length}`);
    const n = Math.min(da.length, db.length);
    for (let i = 0; i < n; i++) {
      const d = primDiff(da[i], db[i]);
      if (d) { diffs.push(`#${i}: ${d}`); if (diffs.length > 6) break; }
    }
    rows.push({ layer, dc: da.length, pc: db.length, diffs });
  }
  return rows;
}

let anyFail = false;
for (const file of DUMPS) {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(file, 'utf-8')); }
  catch { console.log(`\n${file}: (missing — skipped)`); continue; }
  const d = (raw['debug-render-input'] as Record<string, unknown>) ?? raw;
  const input = {
    routes: d.routes, tracks: d.tracks, stations: d.stations,
    stationGroups: d.stationGroups, geography: d.geography,
    options: { mode: 'smoothed' as const, width: W, height: H, showStations: true, showLabels: true, dark: false },
  };
  const t0 = Date.now();
  const pre = precomputeSmoothedSchematic(input as never);
  if (typeof pre === 'string') { console.log(`\n${file}: degenerate (string) — skipped`); continue; }
  const out: SceneOut = { scene: null };
  const svg = drawSmoothedSchematic(pre as never, input.options as never, out);
  const svgNoSink = drawSmoothedSchematic(pre as never, input.options as never);
  const ms = Date.now() - t0;
  const additive = svg === svgNoSink;
  const parsed = sceneFromSvg(svg);
  const rows = compare(out.scene!, parsed);
  const fail = !additive || rows.some((r) => r.diffs.length > 0);
  anyFail = anyFail || fail;
  console.log(`\n${file}  (${ms}ms, ${(svg.length / 1e6).toFixed(1)}MB svg, additive=${additive})  ${fail ? 'FAIL' : 'OK'}`);
  for (const r of rows) {
    const mark = r.diffs.length ? 'X' : 'ok';
    console.log(`  [${mark}] ${r.layer.padEnd(11)} direct=${String(r.dc).padStart(5)} parsed=${String(r.pc).padStart(5)}` + (r.diffs.length ? `  ${r.diffs.slice(0, 4).join('; ')}` : ''));
  }
}
console.log(`\n=== ${anyFail ? 'PARITY FAILURES PRESENT' : 'ALL CITIES EXACT (direct scene == parsed svg)'} ===`);
process.exit(anyFail ? 1 : 0);
