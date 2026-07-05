/**
 * Contiguity check for OLD-format dumps (raw routes/tracks/stations) by running
 * the full smoothed pipeline and analyzing the per-line stroke paths emitted by
 * paintRibbons (each carries data-line-id). Used to regression-test the
 * node-connector fix across cities. Compare old vs fixed:
 *   OCTI_CONN_MAXGAP=44 tsx dev/contig-old.ts <dump>   # pre-fix behaviour
 *   tsx dev/contig-old.ts <dump>                        # fixed behaviour
 */
import { readFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
import type { GeographyData } from '../src/geography/types';
import { analyzeLine } from './contig';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-difficult-nyc.json';
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;

const svg = generateSchematicSVG({
  routes: dump.routes,
  tracks: dump.tracks,
  stations: dump.stations,
  stationGroups: dump.stationGroups,
  geography: dump.geography as GeographyData | undefined,
  options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false, dark: true },
});

// stroke paths only (casings have no data-line-id)
const re = /<path d="([^"]*)"[^>]*data-line-id="([^"]*)"/g;
let m: RegExpExecArray | null;
const VIS = 2;
let broken = 0, total = 0;
const rows: string[] = [];
while ((m = re.exec(svg))) {
  total++;
  const lr = analyzeLine(m[2], m[2].slice(0, 6), '#000', [m[1]]);
  const big = lr.gaps.filter((g) => g.dist >= VIS);
  if (big.length > 0) { broken++; rows.push(`  ${m[2].slice(0, 8)}  gaps=${big.length} max=${big[0].dist.toFixed(1)}px`); }
}
console.log(`${dumpPath}: ${total} lines, ${broken} with visible gaps (cap=${process.env.OCTI_CONN_MAXGAP ?? 'default(bundleSpan)'})`);
for (const r of rows) console.log(r);
