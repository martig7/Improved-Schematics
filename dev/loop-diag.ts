/**
 * Loop measurement. Renders a dump (smoothed mode) with OCTI_LOOPS=1 and prints
 * every place a route's PAINTED track crosses itself — fused-station hooks,
 * balloon loops, terminal rings — each anchored to its nearest station group
 * (e.g. Chicago route A loops at Chestnut St). artifact = a small self-crossing
 * (actionable); bigloop = a map-scale crossing (likely a genuine circular
 * route). Out-and-back retraces and parallel lanes do NOT register (coincident
 * lanes are not a crossing).
 *
 * Usage: npx tsx dev/loop-diag.ts [dump.json]
 *   OCTI_LOOP_MERGE / _ARTDIAM env-tune the detector (see loopMetrics.ts). Pair
 *   the `at=` coords with dev/_raster.ts to crop a flagged loop.
 */
import { readFileSync, existsSync } from 'fs';
process.env.OCTI_LOOPS = '1';
import { generateSchematicSVG } from '../src/render/schematic';
import { keepLargestWaterBodies } from '../src/water/bodies';
import type { WaterCollection } from '../src/render/types';

const dumpPath = process.argv[2] ?? 'improvedschematics-dump-sea-w-geo.json';
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;
console.log(
  `dump ${dumpPath}: routes=${routes?.length} tracks=${tracks?.length} stations=${stations?.length} groups=${stationGroups?.length ?? 'none'}`,
);

let water: WaterCollection | undefined;
if (existsSync('sea_water.geojson')) {
  try {
    water = keepLargestWaterBodies(JSON.parse(readFileSync('sea_water.geojson', 'utf-8')), { minFracOfLargest: 0.01 });
  } catch {
    water = undefined;
  }
}

const loopLines: string[] = [];
const orig = console.error;
console.error = (...a: unknown[]): void => {
  const s = a.map(String).join(' ');
  if (/^\[loops\]/.test(s)) loopLines.push(s);
  orig(...(a as []));
};

generateSchematicSVG({
  routes,
  tracks,
  stations,
  stationGroups,
  water,
  geography: dump.geography, // projection bounds — match the game's input
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
} as never);
console.error = orig;

console.log(`\n=== ${loopLines.length} loop diagnostic lines ===`);
