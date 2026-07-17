// Robustness bake: run the SLOW layout precompute once per settings
// variant and save the pre-draw preconditions (the serialized precompute,
// geometry stripped) plus the variant options to JSON. The companion
// dev/robustness-check.ts then re-runs ONLY the draw stage over every
// baked variant, so draw-stage work is checked against many layout
// geometries in seconds instead of re-running the pipeline per variant.
//
//   npx tsx dev/robustness-bake.ts testdata/improvedschematics-map-NYC-jul-16-2.json dev/_robustness
//
// Variants stress the axes that reroute layout upstream of draw: warp
// growth, warp alpha, and the station-split toggle.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { precomputeSmoothedSchematic } from '../src/render/schematic';
import { serializePre } from '../src/render/persist';

const VARIANTS: Array<{ name: string; override: Record<string, unknown> }> = [
  { name: 'base', override: {} },
  { name: 'nosplit', override: { stationSplit: false } },
  { name: 'growth2', override: { boxGrowth: 2.0 } },
  { name: 'growth45', override: { boxGrowth: 4.5 } },
  { name: 'warp05', override: { warpAlpha: 0.5 } },
  { name: 'warp09', override: { warpAlpha: 0.9 } },
];

const [dumpPath, outDir] = process.argv.slice(2);
if (!dumpPath || !outDir) {
  console.error('usage: robustness-bake.ts <map-dump.json> <out-dir>');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw.inputDump;
const stationDesign = raw.settings?.stationDesign;
mkdirSync(outDir, { recursive: true });

for (const v of VARIANTS) {
  const options = { ...dump.options, stationDesign, ...v.override };
  const t0 = Date.now();
  const pre = precomputeSmoothedSchematic({
    routes: dump.routes, tracks: dump.tracks, stations: dump.stations,
    stationGroups: dump.stationGroups, geography: dump.geography,
    options,
  });
  if (typeof pre === 'string') {
    console.error(`[bake] ${v.name}: degenerate precompute, skipped`);
    continue;
  }
  // strip the memoized draw geometry so a check always re-draws with the
  // CURRENT draw code (that is the whole point of the bake)
  (pre as { geometry?: unknown }).geometry = undefined;
  const file = join(outDir, v.name + '.json');
  writeFileSync(file, JSON.stringify({ name: v.name, options, pre: serializePre(pre) }));
  console.log(`[bake] ${v.name}: ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${file}`);
}
