/** Run LOOM topo on stdin JSON and print edge/station counts + statistics block. */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const inPath = process.argv[2] ?? 'dev/sea-loom.json';
const input = readFileSync(inPath, 'utf-8');
const out = execSync('docker run -i --rm loom topo --write-stats', {
  input,
  maxBuffer: 100 * 1024 * 1024,
  encoding: 'utf-8',
});
const j = JSON.parse(out) as { features: Array<{ geometry: { type: string } }>; statistics?: Record<string, unknown> };
const stations = j.features.filter((f) => f.geometry.type === 'Point').length;
const edges = j.features.filter((f) => f.geometry.type === 'LineString').length;
console.log('LOOM topo output:', { inPath, stations, edges });
if (j.statistics) console.log('statistics:', j.statistics);
