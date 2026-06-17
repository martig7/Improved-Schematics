/**
 * Cross-V8 convergence gate. Spawns dev/ulpRun.ts in a FRESH process per mode
 * (the Math patch is process-global + import-cached, so each mode needs its own
 * process), then asserts every perturbation mode reproduces the baseline's
 * DISCRETE fingerprint. Reports the first divergent layer (cell < lane < skel)
 * per mode — the earliest layer is the true root; later ones are downstream.
 *
 * Usage: npx tsx dev/_ulpcheck.ts [dump.json]
 */
import { execSync } from 'child_process';

const dump = process.argv[2] ?? 'improvedschematics-input-dump-current-seattle.json';
const run = (mode: string) => {
  // 'sortrev' exercises sort-tie stability (a V8 build that orders equal keys
  // differently); the ULP modes can't catch missing tie-breaks on Node's stable sort.
  const env = mode === 'sortrev'
    ? { ...process.env, SORT_PERTURB: '1', ULP_MODE: '' }
    : { ...process.env, ULP_MODE: mode, SORT_PERTURB: '' };
  const out = execSync(`npx tsx dev/ulpRun.ts "${dump}"`, {
    env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!;
  return JSON.parse(line) as { mode: string; hash: string; cell: string; lane: string; skel: string };
};

const base = run('');
const base2 = run(''); // control
const ctrl = base.hash === base2.hash;
console.log(`control (two unpatched runs equal): ${ctrl ? 'PASS' : 'FAIL'}  base=${base.hash}`);

let allPass = ctrl;
for (const mode of ['plus', 'minus', 'parity', 'seeded', 'sortrev']) {
  const r = run(mode);
  const ok = r.hash === base.hash;
  const layers = ['cell', 'lane', 'skel'] as const;
  const firstDiff = layers.find((L) => r[L] !== base[L]) ?? 'none';
  allPass = allPass && ok;
  console.log(`${mode.padEnd(7)} ${ok ? 'PASS' : 'FAIL'}  firstDiff=${firstDiff}  ${r.hash}`);
}
console.log(`\n=== ${allPass ? 'CONVERGED ✓' : 'DIVERGENT ✗'} ===`);
process.exit(allPass ? 0 : 1);
