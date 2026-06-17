/**
 * Render NYC through the reference LOOM C++ pipeline (Docker) for comparison.
 * Requires: docker build -t loom loom-master/loom-master
 *
 * Usage: pnpm exec tsx dev/render-loom-nyc.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Resvg } from '@resvg/resvg-js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOOM_DIR = join(ROOT, 'loom-master', 'loom-master');
const GEOJSON = join(ROOT, 'dev', 'nyc-loom.json');
const SVG_OUT = join(ROOT, 'dev', 'out-loom-nyc.svg');
const PNG_OUT = join(ROOT, 'dev', 'out-loom-nyc.png');

// Export GeoJSON if missing or stale
execSync(`pnpm exec tsx dev/export-loom-geojson.ts`, { cwd: ROOT, stdio: 'inherit' });

console.log('Building LOOM Docker image (first run may take several minutes)…');
try {
  execSync(`docker build -t loom "${LOOM_DIR}"`, { stdio: 'inherit' });
} catch {
  console.error('Docker build failed — is Docker running?');
  process.exit(1);
}

const input = readFileSync(GEOJSON, 'utf-8');
console.log('Running: topo | loom | octi | transitmap -l');

const svg = execSync(
  `docker run -i loom sh -c "topo | loom | octi | transitmap -l"`,
  { input, maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8' },
);

writeFileSync(SVG_OUT, svg);
console.log(`SVG → ${SVG_OUT} (${(svg.length / 1024).toFixed(0)} KB)`);

if (existsSync(PNG_OUT)) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1400 } }).render().asPng();
  writeFileSync(PNG_OUT, png);
  console.log(`PNG → ${PNG_OUT}`);
}
