// Throwaway: joint grid-divisor x line-width sweep for Tacoma spacing
// (spec 2026-06-10-loom-parity-corridor-separation-design.md section 2).
// Spawns dev/render-from-dump.ts per config; writes full map + center + SW
// crops per config as dev/_sw-<divisor>-<lw>*.png.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const DIVISORS = ['2.5', '1.6', '1.2', '1.0'];
const WIDTHS = ['5', '3.5', '2.5'];

for (const d of DIVISORS) {
  for (const w of WIDTHS) {
    const tag = `_sw-${d.replace('.', '')}-${w.replace('.', '')}`;
    const t0 = Date.now();
    try {
      execFileSync('npx', ['tsx', 'dev/render-from-dump.ts', 'improvedschematics-input.json', `dev/${tag}`], {
        env: { ...process.env, OCTI_DIVISOR: d, IS_LINE_WIDTH: w, OCTI_DEBUG: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: true,
        timeout: 8 * 60_000,
      });
    } catch (err) {
      console.log(`${tag}: FAILED/TIMEOUT (${String(err).slice(0, 120)})`);
      continue;
    }
    const svg = readFileSync(`dev/${tag}.svg`, 'utf-8');
    for (const [suffix, box] of [
      ['-center', '880 1130 360 400'],
      ['-swclump', '300 1900 900 800'],
    ] as const) {
      const cropped = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
      writeFileSync(
        `dev/${tag}${suffix}.png`,
        new Resvg(cropped, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng(),
      );
    }
    console.log(`${tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
console.log('done');
