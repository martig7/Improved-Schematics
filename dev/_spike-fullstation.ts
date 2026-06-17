// Throwaway spike driver: sweep octi full-station placement (combineDeg2
// DISABLED) over cellSize = medianEdgeLength * {0.8, 1.0, 1.3} on the live
// game dump, plus a baseline run with current defaults (combineDeg2 ON).
// Each config runs in its own child process with OCTI_DEBUG=1 and a hard
// 6.5-minute wall-clock cap. Violations / NO_CANDS are parsed from stderr.
//
// Usage: npx tsx dev/_spike-fullstation.ts
import { spawn } from 'child_process';

interface Config { label: string; factor: string; combine: 'combine' | 'nocombine' }
const configs: Config[] = [
  { label: 'c080', factor: '0.8', combine: 'nocombine' },
  { label: 'c100', factor: '1.0', combine: 'nocombine' },
  { label: 'c130', factor: '1.3', combine: 'nocombine' },
  { label: 'base', factor: 'default', combine: 'combine' },
];
const CAP_MS = 390_000; // ~6.5 min

function runOne(cfg: Config): Promise<{
  cfg: Config; timedOut: boolean; exitCode: number | null;
  stats: Record<string, unknown> | null;
  finalVios: number | null; noCands: number; fellBack: boolean;
  orderings: string[]; wallSec: number;
}> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(
      'npx',
      ['tsx', 'dev/_spike-fs-worker.ts', cfg.label, cfg.factor, cfg.combine],
      { env: { ...process.env, OCTI_DEBUG: '1' }, shell: true },
    );
    let out = '';
    let err = '';
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // on Windows, kill the whole tree
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true });
    }, CAP_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    child.on('close', (code) => {
      clearTimeout(killer);
      const statsLine = out.split('\n').find((l) => l.startsWith('STATS '));
      const stats = statsLine ? JSON.parse(statsLine.slice(6)) : null;
      const finals = [...err.matchAll(/final score=([\d.]+|Infinity) vios=(\d+)/g)];
      const finalVios = finals.length ? Number(finals[finals.length - 1][2]) : null;
      const noCands = (err.match(/NO_CANDS/g) ?? []).length;
      // octi's grid-snap fallback only triggers after MAX_STALL_RETRIES tryDraw
      // failures; detect it by the absence of any successful "final score" line.
      const fellBack = finals.length === 0;
      const orderings = [...err.matchAll(/\[octi\] (NUM_LINES|LENGTH|ADJ_ND_DEGREE|ADJ_ND_LDEGREE|GROWTH_DEG|GROWTH_LDEG): (\w+) score=([\d.einfA-Z+]+) vios=(\d+) \((\d+)ms\)/g)]
        .map((m) => `${m[1]}:${m[2]} score=${m[3]} vios=${m[4]} ${m[5]}ms`);
      resolve({
        cfg, timedOut, exitCode: code, stats, finalVios, noCands, fellBack,
        orderings, wallSec: (Date.now() - t0) / 1000,
      });
    });
  });
}

(async () => {
  const results = [];
  for (const cfg of configs) {
    console.log(`\n=== running ${cfg.label} (factor=${cfg.factor}, ${cfg.combine}) ===`);
    const r = await runOne(cfg);
    results.push(r);
    console.log(`--- ${cfg.label}: timedOut=${r.timedOut} exit=${r.exitCode} wall=${r.wallSec.toFixed(0)}s ` +
      `vios=${r.finalVios} NO_CANDS=${r.noCands} fellBack=${r.fellBack}`);
    if (r.stats) console.log('    stats:', JSON.stringify(r.stats));
    for (const o of r.orderings) console.log('    ordering ', o);
  }
  console.log('\n===== SUMMARY =====');
  for (const r of results) {
    console.log(JSON.stringify({
      label: r.cfg.label, factor: r.cfg.factor, combine: r.cfg.combine,
      timedOut: r.timedOut, wallSec: +r.wallSec.toFixed(0),
      finalVios: r.finalVios, noCands: r.noCands, fellBack: r.fellBack,
      stats: r.stats,
    }));
  }
})();
