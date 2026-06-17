// Probe: H's stNodes tail + stComboTimings coverage — is the trailing
// Jersey re-traverse scheduled, and what does the schedule say around the
// two 50km legs?
import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const stN = new Map<string, string>();
for (const s of d.stations) for (const id of s.stNodeIds ?? []) stN.set(id, s.name);

const H = d.routes.find((r: { bullet?: string }) => r.bullet === 'H');
console.log('route keys:', Object.keys(H).join(', '));
const nodes = (H.stNodes ?? []).map((n: { id: string }) => n.id);
console.log('stNodes:', nodes.length, 'stCombos:', (H.stCombos ?? []).length,
  'stComboTimings:', (H.stComboTimings ?? []).length);

console.log('--- last 12 stNodes ---');
for (const id of nodes.slice(-12)) console.log('  ', stN.get(id));

console.log('--- stComboTimings tail (last 12) ---');
for (const t of (H.stComboTimings ?? []).slice(-12)) {
  console.log(
    `  idx=${t.stNodeIndex} ${stN.get(t.stNodeId)} arr=${(t.arrivalTime / 60).toFixed(1)}m dep=${(t.departureTime / 60).toFixed(1)}m`,
  );
}
console.log('--- timings around index of Library Av (search by name) ---');
const tms = H.stComboTimings ?? [];
for (let i = 0; i < tms.length; i++) {
  const nm = stN.get(tms[i].stNodeId);
  if (nm === 'Library Av' || nm === 'Browns Ln') {
    for (const t of tms.slice(Math.max(0, i - 1), i + 2)) {
      console.log(
        `  idx=${t.stNodeIndex} ${stN.get(t.stNodeId)} arr=${(t.arrivalTime / 60).toFixed(1)}m dep=${(t.departureTime / 60).toFixed(1)}m`,
      );
    }
    console.log('  ---');
  }
}
