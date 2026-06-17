import { readFileSync } from 'fs';
type Coord = [number, number];
const raw = JSON.parse(readFileSync('SEA-metro.geojson', 'utf-8'));
const routes = new Map<string, { bullet: string; coords: Coord[] }>();
const stations: { id: string; name: string; coords: Coord; routeIds: string[] }[] = [];
for (const f of raw.features) {
  if (f.properties.layer === 'routes') routes.set(String(f.properties.id), { bullet: String(f.properties.bullet), coords: f.geometry.coordinates });
  if (f.properties.layer === 'stations') stations.push({ id: String(f.properties.id), name: String(f.properties.name), coords: f.geometry.coordinates, routeIds: f.properties.routeIds ?? [] });
}
// E = red, L = olive
const E = [...routes.entries()].find(([, r]) => r.bullet === 'E')!;
const L = [...routes.entries()].find(([, r]) => r.bullet === 'L')!;
for (const [id, r] of [E, L]) {
  console.log('=== route', r.bullet, id, 'pts', r.coords.length);
  // detect self double-back: sample every Nth pt, find pairs (i,j) far apart in arclen but close in space
  const pts = r.coords;
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  const close: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < pts.length; i += 5) {
    for (let j = i + 5; j < pts.length; j += 5) {
      if (arc[j] - arc[i] < 0.01) continue; // require >1km-ish separation along line
      const d = Math.hypot(pts[i][0]-pts[j][0], pts[i][1]-pts[j][1]);
      if (d < 0.004) close.push({ i, j, d });
    }
  }
  // cluster: report extremes
  console.log(' self-close pairs (arclen-separated):', close.length);
  if (close.length) {
    // group by rough location
    const seen = new Set<string>();
    for (const c of close) {
      const key = pts[c.i].map(v=>v.toFixed(2)).join(',');
      if (seen.has(key)) continue; seen.add(key);
      console.log(`  i=${c.i} j=${c.j} d=${(c.d*85).toFixed(2)}km-ish at`, pts[c.i].map(v=>v.toFixed(4)).join(','), '<->', pts[c.j].map(v=>v.toFixed(4)).join(','));
    }
  }
  console.log(' endpoints:', pts[0].map(v=>v.toFixed(4)).join(','), '->', pts[pts.length-1].map(v=>v.toFixed(4)).join(','));
}
// stations NW of core on E or L: lon < -122.30, lat > 47.62
console.log('=== NW stations on E/L');
for (const s of stations) {
  const onE = s.routeIds.includes(E[0]), onL = s.routeIds.includes(L[0]);
  if ((onE || onL) && s.coords[0] < -122.30 && s.coords[1] > 47.60)
    console.log(' ', s.name, s.coords.map(v=>v.toFixed(4)).join(','), onE?'E':'', onL?'L':'');
}
