// Probe: validate the stNodes-adjacency rule. For every route in a dump:
// does route.stNodes exist, and which stCombos connect NON-consecutive
// scheduled stops (candidate positioning legs)?
// Usage: npx tsx dev/_probe-stnodes.ts <dump.json>
import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync(process.argv[2] ?? 'improvedschematics-input-nyc.json', 'utf-8'));
const stN = new Map<string, string>();
for (const s of d.stations) for (const id of s.stNodeIds ?? []) stN.set(id, s.name);

for (const r of d.routes) {
  if (r.tempParentId) continue;
  const combos = r.stCombos ?? [];
  const nodes = (r.stNodes ?? []).map((n: { id: string }) => n.id);
  if (nodes.length === 0) {
    console.log(`${r.bullet}: NO stNodes (${combos.length} combos) — rule would not apply`);
    continue;
  }
  const allowed = new Set<string>();
  for (let i = 0; i + 1 < nodes.length; i++) {
    allowed.add(nodes[i] + '>' + nodes[i + 1]);
    allowed.add(nodes[i + 1] + '>' + nodes[i]);
  }
  const bad = combos.filter(
    (c: { startStNodeId: string; endStNodeId: string }) =>
      !allowed.has(c.startStNodeId + '>' + c.endStNodeId),
  );
  const names = bad.map(
    (c: { startStNodeId: string; endStNodeId: string; distance: number }) =>
      `${stN.get(c.startStNodeId)}->${stN.get(c.endStNodeId)} (${(c.distance / 1000).toFixed(1)}km)`,
  );
  console.log(
    `${r.bullet}: stNodes=${nodes.length} combos=${combos.length} nonConsecutive=${bad.length}` +
    (names.length ? `  [${names.join(', ')}]` : ''),
  );
}
