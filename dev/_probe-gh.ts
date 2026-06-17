// Probe: true stop sequences of the brown routes (G/H) from stCombos.
import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const stN = new Map<string, string>();
for (const s of d.stations) for (const id of s.stNodeIds ?? []) stN.set(id, s.name);
for (const r of d.routes) {
  if (r.bullet !== 'G' && r.bullet !== 'H') continue;
  const seq: string[] = [];
  for (const c of r.stCombos ?? []) {
    const n = stN.get(c.startStNodeId) ?? '?';
    if (!seq.length || seq[seq.length - 1] !== n) seq.push(n);
  }
  const last = r.stCombos?.[r.stCombos.length - 1];
  if (last) seq.push(stN.get(last.endStNodeId) ?? '?');
  console.log(r.bullet + ':', seq.join(' > '));
}
