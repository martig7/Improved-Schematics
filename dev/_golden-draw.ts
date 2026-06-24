/** Golden-master for the renderRibbons compute/paint split: capture a hash of the
 *  drawn svg + Scene IR for each city x toggle-state, so a refactor can be proven
 *  byte-identical. Caches each city's `pre` to dev/_golden/<city>.pre.json so re-runs
 *  (after the refactor) skip the slow octi precompute and only re-draw.
 *
 *  Baseline:   npx tsx dev/_golden-draw.ts            (precomputes + caches pre, prints hashes)
 *  After edit: npx tsx dev/_golden-draw.ts            (reuses cached pre, prints hashes -> diff)
 *  Fast subset: GOLDEN_CITIES=chi,nyc,sea npx tsx dev/_golden-draw.ts
 *  Force re-precompute: GOLDEN_FRESH=1 npx tsx dev/_golden-draw.ts */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import { serializePre, deserializePre } from '../src/render/persist';
import type { SceneOut } from '../src/render/renderOctilinear';

const CITIES: Record<string, string> = {
  chi: 'improvedschematics-input-chi.json',
  nyc: 'improvedschematics-input-nyc.json',
  sea: 'improvedschematics-dump-sea-w-geo.json',
  sf: 'improvedschematics-input-sf-difficult.json',
  lon: 'improvedschematics-input-lon-full-warp.json',
};
// toggle states to capture per city. Fast cities get all combos; sf/lon just the heaviest.
const ALL_STATES = [
  { showLabels: false, showStations: true },
  { showLabels: true, showStations: true },
  { showLabels: false, showStations: false },
];
const HEAVY_ONLY = [{ showLabels: true, showStations: true }];
const FAST = new Set(['chi', 'nyc', 'sea']);

const W = 2700, H = 2700;
const DIR = 'dev/_golden';
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const want = (process.env.GOLDEN_CITIES ?? 'chi,nyc,sea,sf,lon').split(',').map((s) => s.trim());
const fresh = process.env.GOLDEN_FRESH === '1';
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

for (const city of want) {
  const file = CITIES[city];
  if (!file || !existsSync(file)) { console.log(`${city}: (dump missing, skip)`); continue; }
  const cacheFile = `${DIR}/${city}.pre.json`;

  // Obtain `pre` as a deserialized (round-tripped) object, identical across runs.
  let preStr: string;
  if (!fresh && existsSync(cacheFile)) {
    preStr = readFileSync(cacheFile, 'utf-8');
  } else {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const d = raw['debug-render-input'] ?? raw;
    const input = { routes: d.routes, tracks: d.tracks, stations: d.stations, stationGroups: d.stationGroups, geography: d.geography,
      options: { mode: 'smoothed' as const, width: W, height: H, showStations: true, showLabels: true, dark: false } };
    const t0 = performance.now();
    const pre = precomputeSmoothedSchematic(input as never);
    preStr = serializePre(pre);
    writeFileSync(cacheFile, preStr);
    console.error(`  (${city}: precomputed in ${((performance.now() - t0) / 1000).toFixed(1)}s, cached)`);
  }
  const pre = deserializePre(preStr);
  if (typeof pre === 'string') { console.log(`${city}: degenerate`); continue; }

  const states = FAST.has(city) ? ALL_STATES : HEAVY_ONLY;
  for (const st of states) {
    const out: SceneOut = { scene: null };
    const svg = drawSmoothedSchematic(pre as never, { mode: 'smoothed', width: W, height: H, dark: false, ...st } as never, out);
    const tag = `L${st.showLabels ? 1 : 0}S${st.showStations ? 1 : 0}`;
    console.log(`${city} ${tag} | svg=${sha(svg)} len=${svg.length} | scene=${sha(JSON.stringify(out.scene))}`);
  }
}
