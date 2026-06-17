/**
 * Marker-box root-cause diagnosis. Renders a dump (default: the in-game
 * improvedschematics dump) in smoothed mode with OCTI_PLACE_DEBUG=1 and prints,
 * per boxed station, WHY its rigid-row solve failed:
 *   NO-CROSSING — lanes never admit a row-line crossing (divergent/coincident;
 *                 NOT fixable by sliding or spacing)
 *   PINCHED     — octi seated the lanes closer than minGap (fixable UPSTREAM:
 *                 octi placement / OCTI_SNAP)
 *   MASKED      — every crossing state vetoed by an already-placed station
 *                 (§6 mask; ordering-dependent)
 *
 * Usage: npx tsx dev/box-diag.ts [dump.json]
 *   dump default: %APPDATA%/metro-maker4/mod-data/improvedschematics.json
 *   IS_LINE_WIDTH=<n> inflates the line width (and thus minGap) — useful to
 *   force/stress boxes on a network that has none at the shipped width.
 */
import { readFileSync, existsSync } from 'fs';
process.env.OCTI_PLACE_DEBUG = '1';
process.env.OCTI_DEBUG = '1'; // enable the gated octi score log + egregious-overlap diagnostic
import { generateSchematicSVG } from '../src/render/schematic';
import { keepLargestWaterBodies } from '../src/water/bodies';
import type { WaterCollection } from '../src/render/types';

const dumpPath =
  process.argv[2] ?? process.env.APPDATA + '\\metro-maker4\\mod-data\\improvedschematics.json';
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;
console.log(
  `dump ${dumpPath}: routes=${routes?.length} tracks=${tracks?.length} stations=${stations?.length} groups=${stationGroups?.length ?? 'none'}`,
);

let water: WaterCollection | undefined;
if (existsSync('sea_water.geojson')) {
  water = keepLargestWaterBodies(JSON.parse(readFileSync('sea_water.geojson', 'utf-8')), { minFracOfLargest: 0.01 });
}

const boxes: string[] = [];
let mega = 0;
let slideBoxed = 0;
const orig = console.error;
console.error = (...a: unknown[]) => {
  const s = a.map(String).join(' ');
  if (/\[rowPlace\] BOX/.test(s)) {
    boxes.push(s);
    return;
  }
  let m: RegExpMatchArray | null;
  if ((m = s.match(/mega-box fallbacks:\s*(\d+)/))) mega = +m[1];
  if ((m = s.match(/slide-boxed[^:]*:\s*(\d+)/))) slideBoxed = +m[1];
  orig(...(a as []));
};

const svg = generateSchematicSVG({
  routes,
  tracks,
  stations,
  stationGroups,
  water,
  geography: dump.geography, // sets projection bounds — must match the game's input
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
});
console.error = orig;

const megaRects = (svg.match(/<g class="imp-stop"[^>]*>[\s\S]*?<\/g>/g) ?? []).filter((g) => /<rect /.test(g)).length;
console.log(`\n=== ${boxes.length} boxed bundles | mega fallbacks=${mega} | slide-boxed=${slideBoxed} | <rect> markers in SVG=${megaRects} ===`);
const byClass: Record<string, number> = {};
for (const b of boxes) {
  const cls = (b.match(/→ (\S+)/) ?? [])[1] ?? '?';
  byClass[cls] = (byClass[cls] ?? 0) + 1;
  console.log(b);
}
console.log('\nclass tally: ' + (Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'));
