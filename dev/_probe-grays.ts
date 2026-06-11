// Ground truth: stop sequences of the gray routes (2, 4) from game data.
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildGroupMaps, walkRouteVisits, stopOnlyVisits } from '../src/render/layout/graph';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, stations, stationGroups } = dump;
const groups = getOrBuildStationGroups(stations, stationGroups);
const { stNodeToGroup, trackToGroup } = buildGroupMaps(stations, groups);
const nameOf = new Map(groups.map((g) => [g.id, g.name]));

for (const r of routes) {
  if (!['87028bd5', '6d6a7b31', '0458fd40', '262b05f7'].some((p) => r.id.startsWith(p))) continue;
  const visits = walkRouteVisits(r, stNodeToGroup, trackToGroup);
  const stops = stopOnlyVisits(visits);
  console.log(`route ${r.id.slice(0, 8)} (${r.bullet ?? '?'} ${r.color}): ${stops.length} stops`);
  console.log('  ' + stops.map((v) => nameOf.get(v.groupId) ?? v.groupId.slice(0, 6)).join(' > '));
  // pass-throughs near Court for context
  const idx = visits.findIndex((v) => nameOf.get(v.groupId) === 'Court');
  if (idx >= 0) {
    const w = visits.slice(Math.max(0, idx - 4), idx + 5);
    console.log('  around Court (incl pass-throughs): ' +
      w.map((v) => `${nameOf.get(v.groupId) ?? v.groupId.slice(0, 6)}${v.isStop ? '*' : ''}`).join(' > '));
  }
}
