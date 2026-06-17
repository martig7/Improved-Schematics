/**
 * Dev harness: generate a city's water layer from its real ocean_depth_index
 * (read + gunzip from disk) and write GeoJSON, without the game running.
 *
 * Usage: pnpm exec tsx dev/water-test.ts [CITY]   (default NYC)
 */

import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { generateWaterFromIndex } from '../src/water/generate';
import type { OceanIndex } from '../src/water/types';

const city = process.argv[2] ?? 'NYC';
const gz = join(process.env.APPDATA!, 'metro-maker4', 'cities', 'data', city, 'ocean_depth_index.json.gz');
const index = JSON.parse(gunzipSync(readFileSync(gz)).toString()) as OceanIndex;

const wc = generateWaterFromIndex(index);
writeFileSync('dev/water-out.geojson', JSON.stringify(wc));

const ringCount = wc.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
let pts = 0;
for (const f of wc.features) for (const r of f.geometry.coordinates) pts += r.length;
console.log(`${city}: ${wc.features.length} features, ${ringCount} rings, ${pts} points`);
console.log(`index grid ${index.grid.join('x')}, bbox [${index.bbox.join(', ')}]`);
