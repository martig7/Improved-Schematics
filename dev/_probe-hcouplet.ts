// Probe: which H stCombo legs physically pass near the (eastern) 27 St
// group — identifies the one-way couplet return path.
import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const stN = new Map<string, { name: string }>();
for (const s of d.stations) for (const id of s.stNodeIds ?? []) stN.set(id, s);
const trackById = new Map<string, { coords: [number, number][] }>(
  d.tracks.map((t: { id: string }) => [t.id, t]),
);

// eastern 27 St group: find the group named 27 St nearest to Hazen St /
// 24 Av (the e399/e400 corridor) — use the group whose center is most
// eastern among 27 St groups with lat in the Queens area; simpler: all of
// them, print distances for each.
const targets = (d.stationGroups as { id: string; name: string; center: [number, number] }[])
  .filter((g) => g.name === '27 St' || g.name === '35 St' || g.name === '31 Av');

const mPerLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const M_PER_LAT = 110540;

const H = d.routes.find((r: { bullet?: string }) => r.bullet === 'H');
for (const c of H.stCombos ?? []) {
  const pts: [number, number][] = [];
  for (const p of c.path ?? []) {
    const t = trackById.get(p.trackId);
    if (t) pts.push(...t.coords);
  }
  for (const g of targets) {
    const k = mPerLng(g.center[1]);
    let best = Infinity;
    for (const p of pts) {
      const dd = Math.hypot((p[0] - g.center[0]) * k, (p[1] - g.center[1]) * M_PER_LAT);
      if (dd < best) best = dd;
    }
    if (best < 120) {
      console.log(
        `H leg ${stN.get(c.startStNodeId)?.name} -> ${stN.get(c.endStNodeId)?.name} ` +
        `passes ${g.name} (${g.id.slice(0, 8)}) at ${best.toFixed(0)}m`,
      );
    }
  }
}
// also: does any E or F stCombo STOP at those groups (sanity)?
for (const bullet of ['E', 'F']) {
  const r = d.routes.find((q: { bullet?: string }) => q.bullet === bullet);
  const stopNames = new Set<string>();
  for (const c of r.stCombos ?? []) {
    stopNames.add(stN.get(c.startStNodeId)?.name ?? '?');
    stopNames.add(stN.get(c.endStNodeId)?.name ?? '?');
  }
  console.log(`${bullet} stops at 27 St: ${stopNames.has('27 St')}, 35 St: ${stopNames.has('35 St')}, 31 Av: ${stopNames.has('31 Av')}`);
}
