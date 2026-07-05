/**
 * FULL-PIPELINE recompute from a saved-map bundle's `inputDump` (the exact live
 * routes/tracks/stations/groups the game rendered). Unlike render-dump.ts
 * (which draws the FROZEN pre.layout), this rebuilds layout from scratch, so
 * layout-stage env knobs (OCTI_HOOK_RATIO, OCTI_GROUP_SPLIT, OCTI_*) fire.
 *
 *   tsx dev/render-full.ts <map.json> <outPrefix> [--cropxy x,y] [--span px] [--width px]
 *
 * stationSplit is taken from the bundle's saved settings.applied unless
 * OCTI_GROUP_SPLIT overrides (1 on / 0 off).
 */
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';
import { generateSchematicSVG } from '../src/render/schematic';

const args = process.argv.slice(2);
const val = (n: string, d?: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const path = positional[0] ?? 'improvedschematics-map-SEA-split-station-grp.json';
const outPrefix = positional[1] ?? 'dev/_full';
const span = Number(val('--span', '560'));
const width = Number(val('--width', '1300'));

const raw = JSON.parse(readFileSync(path, 'utf-8'));
const dump = raw.inputDump;
if (!dump) { console.error('bundle has no inputDump'); process.exit(1); }
const applied = (raw.settings?.applied ?? {}) as { stationSplit?: boolean; lineWidth?: number; stationRadius?: number };
const { routes, tracks, stations, stationGroups } = dump;
console.log(`inputDump: routes=${routes?.length} tracks=${tracks?.length} stations=${stations?.length} groups=${stationGroups?.length} stationSplit=${applied.stationSplit}`);

const dumped = dump.options ?? {};
let svg = generateSchematicSVG({
  routes, tracks, stations, stationGroups,
  geography: dump.geography,
  options: {
    mode: 'smoothed',
    width: 2700,
    height: 2700,
    showStations: true,
    showLabels: true,
    dark: true,
    stationSplit: applied.stationSplit === true,
    ...(dumped.padding !== undefined ? { padding: dumped.padding } : {}),
    ...(dumped.warpAlpha !== undefined ? { warpAlpha: dumped.warpAlpha } : {}),
    ...(dumped.geographicAffinity !== undefined ? { geographicAffinity: dumped.geographicAffinity } : {}),
    ...(dumped.boxExpand !== undefined ? { boxExpand: dumped.boxExpand } : {}),
    ...(dumped.boxGrowth !== undefined ? { boxGrowth: dumped.boxGrowth } : {}),
    ...(dumped.boxFrac !== undefined ? { boxFrac: dumped.boxFrac } : {}),
  },
});

const cropXY = val('--cropxy');
if (cropXY) {
  const [cx, cy] = cropXY.split(',').map(Number);
  const vb = `${(cx - span / 2).toFixed(1)} ${(cy - span / 2).toFixed(1)} ${span} ${span}`;
  svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`).replace(/width="\d+"/, `width="${span}"`).replace(/height="\d+"/, `height="${span}"`);
}
writeFileSync(outPrefix + '.svg', svg);
writeFileSync(outPrefix + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#18181b' }).render().asPng());
console.log(`wrote ${outPrefix}.svg / .png`);
