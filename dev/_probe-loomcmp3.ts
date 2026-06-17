import { readFileSync } from 'fs';
const raw = JSON.parse(readFileSync('SEA-metro.geojson', 'utf-8'));
for (const f of raw.features) {
  if (f.properties.layer === 'routes') {
    const c: [number,number][] = f.geometry.coordinates;
    console.log(f.properties.id, f.properties.bullet, f.properties.color, 'pts', c.length,
      'lonRange', Math.min(...c.map(p=>p[0])).toFixed(3), Math.max(...c.map(p=>p[0])).toFixed(3),
      'latRange', Math.min(...c.map(p=>p[1])).toFixed(3), Math.max(...c.map(p=>p[1])).toFixed(3));
  }
}
