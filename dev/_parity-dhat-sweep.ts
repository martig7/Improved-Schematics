// Throwaway: dHat sweep on the canonical live dump (improvedschematics-input.json).
// For each OCTI_DHAT in {16 (baseline), 12, 8, 6, 4} spawns dev/render-from-dump.ts
// with OCTI_DEBUG=1, records support-graph size / octi runtime / violations /
// wall time, and rasterizes a CENTER crop (blue+pink conjoined corridor,
// found via dev/_parity-dhat-findcenter.ts: support edges he407..he452 run
// x[956..1147] y[1188..1461]) and the SW Tacoma crop per config.
//
// Usage: npx tsx dev/_parity-dhat-sweep.ts
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const DHATS = [16, 12, 8, 6, 4];
const CAP_MS = 8 * 60 * 1000;
const CENTER_VB = '820 1000 880 660'; // blue/pink conjoined stretch + context
const SW_VB = '300 1900 900 800'; // Tacoma clump

interface Row {
  dHat: number;
  supportNodes?: number;
  supportEdges?: number;
  octiMethodMs?: number;
  locSearchMs?: number;
  vios?: number;
  score?: number;
  wallSec: number;
  ok: boolean;
  note?: string;
}
const rows: Row[] = [];

function crop(svgPath: string, vb: string, outPng: string, width: number) {
  let svg = readFileSync(svgPath, 'utf-8');
  svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  writeFileSync(
    outPng,
    new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'white' }).render().asPng(),
  );
}

for (const dHat of DHATS) {
  const prefix = `dev/_parity-dhat${dHat}`;
  console.log(`\n=== dHat=${dHat} ===`);
  const t0 = Date.now();
  const res = spawnSync(
    'npx',
    ['tsx', 'dev/render-from-dump.ts', 'improvedschematics-input.json', prefix],
    {
      shell: true,
      env: { ...process.env, OCTI_DHAT: String(dHat), OCTI_DEBUG: '1' },
      timeout: CAP_MS,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf-8',
    },
  );
  const wallSec = (Date.now() - t0) / 1000;
  const err = res.stderr ?? '';
  writeFileSync(`${prefix}.log`, (res.stdout ?? '') + '\n--- stderr ---\n' + err);

  const row: Row = { dHat, wallSec, ok: false };
  const sup = err.match(/\[topo\] support: (\d+) nodes \((\d+) anchor splits\), (\d+) edges/);
  if (sup) {
    row.supportNodes = Number(sup[1]);
    row.supportEdges = Number(sup[3]);
  }
  let methodMs = 0;
  for (const m of err.matchAll(/\[octi\] [^\n]*\((\d+)ms\)\s*$/gm)) methodMs += Number(m[1]);
  row.octiMethodMs = methodMs;
  const ls = [...err.matchAll(/(\d+)ms total\)/g)];
  if (ls.length) row.locSearchMs = Number(ls[ls.length - 1][1]);
  const fin = err.match(/\[octi\] final score=([\d.]+) vios=(\d+)/);
  if (fin) {
    row.score = Number(fin[1]);
    row.vios = Number(fin[2]);
  }
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    row.note = `TIMEOUT at ${CAP_MS / 1000}s`;
  } else if (res.status !== 0) {
    row.note = `exit=${res.status} stderr tail: ${err.slice(-400).replace(/\s+/g, ' ')}`;
  }

  if (existsSync(`${prefix}.svg`) && !row.note) {
    row.ok = true;
    crop(`${prefix}.svg`, CENTER_VB, `${prefix}-center.png`, 1100);
    crop(`${prefix}.svg`, SW_VB, `${prefix}-sw.png`, 1000);
    console.log(`  wrote ${prefix}.png / -center.png / -sw.png`);
  }
  rows.push(row);
  console.log(
    `  support=${row.supportNodes}/${row.supportEdges} octiMethods=${row.octiMethodMs}ms ` +
      `locSearch=${row.locSearchMs}ms vios=${row.vios} score=${row.score} wall=${wallSec.toFixed(0)}s ` +
      (row.note ?? 'OK'),
  );
  if (row.note?.startsWith('TIMEOUT')) {
    console.log('  config exploded; skipping remaining smaller dHats');
    break;
  }
}

console.log('\n=== SUMMARY ===');
console.log('dHat | nodes | edges | octiMethodsMs | locSearchMs | vios | score | wallSec | status');
for (const r of rows) {
  console.log(
    `${r.dHat} | ${r.supportNodes ?? '?'} | ${r.supportEdges ?? '?'} | ${r.octiMethodMs ?? '?'} | ` +
      `${r.locSearchMs ?? '?'} | ${r.vios ?? '?'} | ${r.score ?? '?'} | ${r.wallSec.toFixed(0)} | ${r.note ?? 'OK'}`,
  );
}
