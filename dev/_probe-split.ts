// Probe: do two routes ride the same tracks between stations, or parallel
// separate tracks (and how far apart)? Dumps each route's stop-to-stop legs
// (station names + track ids) filtered by a name regex, then compares the
// two routes' track usage and geometric separation on those legs.
// Usage: npx tsx dev/_probe-split.ts <dump.json> <bulletA> <bulletB> <nameRegex>
import { readFileSync } from 'fs';

const [file, bulletA, bulletB, nameRe] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf-8'));
const re = new RegExp(nameRe ?? '.', 'i');

interface St { id: string; name: string; stNodeIds: string[] }
const stNodeToStation = new Map<string, St>();
for (const s of d.stations as St[]) for (const id of s.stNodeIds) stNodeToStation.set(id, s);
const trackById = new Map<string, { id: string; coords: [number, number][] }>(
  (d.tracks as { id: string; coords: [number, number][] }[]).map((t) => [t.id, t]),
);

const mPerLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const M_PER_LAT = 110540;

interface Leg { from: string; to: string; tracks: string[] }
const legsOf = (bullet: string): Leg[] => {
  const r = (d.routes as never[]).find(
    (q) => (q as { bullet?: string; tempParentId?: string }).bullet === bullet &&
           !(q as { tempParentId?: string }).tempParentId,
  ) as { stCombos?: { startStNodeId: string; endStNodeId: string; path: { trackId: string }[] }[] } | undefined;
  if (!r?.stCombos) { console.log(`route ${bullet}: not found`); return []; }
  return r.stCombos.map((c) => ({
    from: stNodeToStation.get(c.startStNodeId)?.name ?? c.startStNodeId,
    to: stNodeToStation.get(c.endStNodeId)?.name ?? c.endStNodeId,
    tracks: c.path.map((p) => p.trackId),
  }));
};

const polyOf = (tracks: string[]): [number, number][] => {
  const pts: [number, number][] = [];
  for (const id of tracks) {
    const t = trackById.get(id);
    if (t) pts.push(...t.coords);
  }
  return pts;
};

const sepMeters = (a: [number, number][], b: [number, number][]): { mean: number; max: number } => {
  if (a.length === 0 || b.length === 0) return { mean: NaN, max: NaN };
  let sum = 0;
  let max = 0;
  const k = mPerLng(a[0][1]);
  for (const p of a) {
    let best = Infinity;
    for (const q of b) {
      const dx = (p[0] - q[0]) * k;
      const dy = (p[1] - q[1]) * M_PER_LAT;
      const dd = Math.hypot(dx, dy);
      if (dd < best) best = dd;
    }
    sum += best;
    if (best > max) max = best;
  }
  return { mean: sum / a.length, max };
};

const A = legsOf(bulletA);
const B = legsOf(bulletB);
for (const [name, legs] of [[bulletA, A], [bulletB, B]] as const) {
  console.log(`--- route ${name}: legs matching /${nameRe}/`);
  for (const l of legs) {
    if (!re.test(l.from) && !re.test(l.to)) continue;
    console.log(`  ${l.from} -> ${l.to}  tracks=[${l.tracks.join(',').slice(0, 90)}]`);
  }
}

// pairwise leg comparison where both endpoints' names match the regex
console.log(`--- comparison (legs whose BOTH endpoints match):`);
for (const la of A) {
  if (!(re.test(la.from) && re.test(la.to))) continue;
  for (const lb of B) {
    if (!(re.test(lb.from) && re.test(lb.to))) continue;
    const setA = new Set(la.tracks);
    const shared = lb.tracks.filter((t) => setA.has(t));
    const sep = sepMeters(polyOf(la.tracks), polyOf(lb.tracks));
    console.log(
      `  [${bulletA}] ${la.from}->${la.to}  vs  [${bulletB}] ${lb.from}->${lb.to}: ` +
      `shared=${shared.length}/${la.tracks.length},${lb.tracks.length}  ` +
      `sep mean=${sep.mean.toFixed(0)}m max=${sep.max.toFixed(0)}m`,
    );
  }
}
