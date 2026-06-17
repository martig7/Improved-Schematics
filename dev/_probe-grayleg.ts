// Ground truth: the actual track-path geometry of the gray routes' legs
// into Court (does the service really approach via the NE corridor?).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildGroupMaps, walkRouteVisits } from '../src/render/layout/graph';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, stations, stationGroups, tracks } = dump;
const groups = getOrBuildStationGroups(stations, stationGroups);
const { stNodeToGroup, trackToGroup } = buildGroupMaps(stations, groups);
const nameOf = new Map(groups.map((g) => [g.id, g.name]));
const trackMap = new Map(tracks.map((t: { id: string }) => [t.id, t]));

for (const r of routes) {
  if (!['87028bd5', '6d6a7b31'].some((p) => r.id.startsWith(p))) continue;
  console.log(`route ${r.bullet}:`);
  // full visit walk incl pass-throughs around Court
  const visits = walkRouteVisits(r, stNodeToGroup, trackToGroup);
  const names = visits.map((v) => `${nameOf.get(v.groupId) ?? '?'}${v.isStop ? '*' : ''}`);
  const ci = names.findIndex((n) => n.startsWith('Court'));
  console.log('  visits around Court: ' + names.slice(Math.max(0, ci - 6), ci + 7).join(' > '));
  // combos touching Court: their path length vs endpoint distance
  for (const combo of r.stCombos ?? []) {
    const a = stNodeToGroup.get(combo.startStNodeId);
    const b = stNodeToGroup.get(combo.endStNodeId);
    const an = nameOf.get(a ?? '');
    const bn = nameOf.get(b ?? '');
    if (an !== 'Court' && bn !== 'Court') continue;
    let len = 0;
    let pts = 0;
    const seen: string[] = [];
    for (const seg of combo.path ?? []) {
      const t = trackMap.get(seg.trackId) as { coords?: [number, number][] } | undefined;
      const tg = trackToGroup.get(seg.trackId);
      if (tg && nameOf.get(tg) && seen[seen.length - 1] !== nameOf.get(tg)) seen.push(nameOf.get(tg)!);
      const cs = t?.coords ?? [];
      pts += cs.length;
      for (let i = 1; i < cs.length; i++) {
        const dx = (cs[i][0] - cs[i - 1][0]) * 111320 * Math.cos((cs[i][1] * Math.PI) / 180);
        const dy = (cs[i][1] - cs[i - 1][1]) * 110540;
        len += Math.hypot(dx, dy);
      }
    }
    console.log(`  combo ${an} -> ${bn}: pathLen=${(len / 1000).toFixed(2)}km pts=${pts} via=[${seen.join(' > ')}]`);
  }
}
