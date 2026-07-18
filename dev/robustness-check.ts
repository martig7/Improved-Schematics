// Robustness check: re-run ONLY the draw stage over every variant baked
// by dev/robustness-bake.ts and print a one-line census summary per
// variant (clips, artifact loops, zigzag steps, fan-zone intrusions).
// Draw is deterministic, so a clean table certifies the current draw
// code against every baked layout geometry in one command.
//
//   npx tsx dev/robustness-check.ts dev/_robustness
//   VERBOSE=1 npx tsx dev/robustness-check.ts dev/_robustness   # full census lines
//
// Draw-affecting env flags (OCTI_CHAIN etc.) pass through unchanged, so
// A/B runs are just two invocations with different flags.
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { drawSmoothedSchematic } from '../src/render/schematic';
import { deserializePre } from '../src/render/persist';

process.env.OCTI_CLIPS = '1';
process.env.OCTI_LOOPS = '1';
process.env.OCTI_ZIGS = '1';
process.env.OCTI_FANZONE = '1';
process.env.OCTI_SPIKES = '1';
process.env.OCTI_STAIRS = '1';
process.env.OCTI_CONTIG = '1';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: robustness-check.ts <baked-dir>');
  process.exit(1);
}
const verbose = process.env.VERBOSE === '1';

interface Summary {
  name: string;
  visibleClips: string;
  loops: string;
  zigs: string;
  tapers: string;
  spikes: string;
  stairs: string;
  contig: string;
  ms: number;
}
const rows: Summary[] = [];

for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const { name, options, pre } = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
  const revived = deserializePre(pre);
  if (typeof revived === 'string') {
    console.error(`[check] ${name}: degenerate pre, skipped`);
    continue;
  }
  (revived as { geometry?: unknown }).geometry = undefined;
  const captured: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => { captured.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { captured.push(a.join(' ')); };
  const t0 = Date.now();
  try {
    drawSmoothedSchematic(revived, options);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  const ms = Date.now() - t0;
  if (verbose) for (const line of captured) console.log(`  [${name}] ${line}`);
  const pick = (re: RegExp): string => {
    for (const line of captured) {
      const m = line.match(re);
      if (m) return m[1];
    }
    return '?';
  };
  rows.push({
    name,
    visibleClips: pick(/(\d+) visible/),
    loops: pick(/(\d+) artifact loops/),
    zigs: pick(/(\d+) perpendicular steps/),
    tapers: pick(/(\d+) taper intrusions/),
    spikes: pick(/(\d+) sub-octilinear angles/),
    stairs: pick(/(\d+) staircases/),
    contig: pick(/(\d+) non-contiguities/),
    ms,
  });
}

console.log('variant     clips  loops  zigs  tapers  spikes  stairs  contig  draw-ms');
for (const r of rows) {
  console.log(
    r.name.padEnd(11) +
    r.visibleClips.padStart(5) +
    r.loops.padStart(7) +
    r.zigs.padStart(6) +
    r.tapers.padStart(8) +
    r.spikes.padStart(8) +
    r.stairs.padStart(8) +
    r.contig.padStart(8) +
    String(r.ms).padStart(9),
  );
}
