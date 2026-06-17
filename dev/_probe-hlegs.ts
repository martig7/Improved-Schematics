// Probe: per-leg distances + reverse-direction coverage for all NYC routes —
// identifies asymmetric "closing" legs (loop-closure deadheads).
import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const stN = new Map<string, string>();
for (const s of d.stations) for (const id of s.stNodeIds ?? []) stN.set(id, s.name);
const stToGroup = new Map<string, string>();
for (const g of d.stationGroups) {
  for (const sid of g.stationIds ?? []) stToGroup.set(sid, g.id);
}
const stIdOf = new Map<string, string>();
for (const s of d.stations) for (const id of s.stNodeIds ?? []) stIdOf.set(id, s.id);

for (const r of d.routes) {
  if (r.tempParentId || !r.stCombos?.length) continue;
  // leg key by GROUP pair (direction-sensitive)
  const fwd = new Set<string>();
  for (const c of r.stCombos) {
    const ga = stToGroup.get(stIdOf.get(c.startStNodeId) ?? '') ?? c.startStNodeId;
    const gb = stToGroup.get(stIdOf.get(c.endStNodeId) ?? '') ?? c.endStNodeId;
    fwd.add(ga + '>' + gb);
  }
  let asym = 0;
  const dists = r.stCombos.map((c: { distance: number }) => c.distance);
  const median = [...dists].sort((a, b) => a - b)[Math.floor(dists.length / 2)];
  for (const c of r.stCombos) {
    const ga = stToGroup.get(stIdOf.get(c.startStNodeId) ?? '') ?? c.startStNodeId;
    const gb = stToGroup.get(stIdOf.get(c.endStNodeId) ?? '') ?? c.endStNodeId;
    const hasRev = fwd.has(gb + '>' + ga);
    if (!hasRev || c.distance > median * 6) {
      asym++;
      console.log(
        `${r.bullet}: ${stN.get(c.startStNodeId)} -> ${stN.get(c.endStNodeId)} ` +
        `dist=${(c.distance / 1000).toFixed(1)}km (median ${(median / 1000).toFixed(1)}km) rev=${hasRev}`,
      );
    }
  }
  if (!asym) console.log(`${r.bullet}: all legs symmetric, max ${(Math.max(...dists) / 1000).toFixed(1)}km`);
}
