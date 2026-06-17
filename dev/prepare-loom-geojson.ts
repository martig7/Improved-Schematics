/**
 * Convert a Subway Builder metro GeoJSON export (stations + route polylines)
 * into LOOM stdin format (station Points + corridor LineStrings with from/to/lines).
 *
 * Usage:
 *   pnpm exec tsx dev/prepare-loom-geojson.ts [input.geojson] [output.json]
 *
 * Default: SEA-metro.geojson → dev/sea-loom.json
 */
import { readFileSync, writeFileSync } from 'fs';

type Coord = [number, number];
type Pixel = [number, number];

interface MetroFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

interface Station {
  id: string;
  name: string;
  coord: Coord;
  routeIds: string[];
}

interface Route {
  id: string;
  label: string;
  color: string;
  coords: Coord[];
}

const inPath = process.argv[2] ?? 'SEA-metro.geojson';
const outPath = process.argv[3] ?? 'dev/sea-loom.json';

function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function polylineLength(pts: Coord[]): number {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += dist(pts[i - 1], pts[i]);
  return t;
}

/** Closest point on polyline + arclength from start. */
function projectOnPolyline(pts: Coord[], p: Coord): { point: Coord; arclen: number } {
  let bestD = Infinity;
  let best: Coord = pts[0];
  let bestArc = 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
    const q: Coord = [a[0] + t * vx, a[1] + t * vy];
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = q;
      bestArc = acc + Math.hypot(q[0] - a[0], q[1] - a[1]);
    }
    acc += Math.hypot(vx, vy);
  }
  return { point: best, arclen: bestArc };
}

/** Slice polyline between two arclengths (inclusive endpoints). */
function slicePolyline(pts: Coord[], a0: number, a1: number): Coord[] {
  if (a0 > a1) [a0, a1] = [a1, a0];
  const at = (target: number): Coord => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (acc + seg >= target - 1e-12) {
        const t = seg === 0 ? 0 : (target - acc) / seg;
        return [
          pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
          pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
        ];
      }
      acc += seg;
    }
    return pts[pts.length - 1];
  };
  const start = at(a0);
  const end = at(a1);
  const out: Coord[] = [start];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    const mid = acc + seg / 2;
    if (acc + seg > a0 + 1e-9 && acc < a1 - 1e-9) {
      if (dist(out[out.length - 1], pts[i - 1]) > 1e-9) out.push(pts[i - 1]);
      if (dist(out[out.length - 1], pts[i]) > 1e-9 && dist(pts[i], end) > 1e-9) out.push(pts[i]);
    }
    acc += seg;
  }
  if (dist(out[out.length - 1], end) > 1e-9) out.push(end);
  return out.length >= 2 ? out : [start, end];
}

function loomColor(hex: string): string {
  return hex.replace(/^#/, '').toLowerCase();
}

const raw = JSON.parse(readFileSync(inPath, 'utf-8')) as { features: MetroFeature[] };
const stations: Station[] = [];
const routes: Route[] = [];

for (const f of raw.features) {
  const layer = f.properties.layer as string | undefined;
  if (layer === 'stations' && f.geometry.type === 'Point') {
    const c = f.geometry.coordinates as Coord;
    stations.push({
      id: String(f.properties.id),
      name: String(f.properties.name ?? f.properties.id),
      coord: c,
      routeIds: Array.isArray(f.properties.routeIds) ? (f.properties.routeIds as string[]) : [],
    });
  } else if (layer === 'routes' && f.geometry.type === 'LineString') {
    routes.push({
      id: String(f.properties.id),
      label: String(f.properties.bullet ?? f.properties.id),
      color: String(f.properties.color ?? '#000000'),
      coords: f.geometry.coordinates as Coord[],
    });
  }
}

type LoomFeature = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};

const features: LoomFeature[] = [];
const stationFeatures: LoomFeature[] = [];
const edgeMap = new Map<string, LoomFeature>();

for (const s of stations) {
  stationFeatures.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: s.coord },
    properties: { id: s.id, station_id: s.id, station_label: s.name },
  });
}

const maxSnap = 0.002; // ~200 m — drop stations far from route geometry

for (const route of routes) {
  if (route.coords.length < 2) continue;
  const onRoute = stations
    .filter((s) => s.routeIds.includes(route.id))
    .map((s) => {
      const { point, arclen } = projectOnPolyline(route.coords, s.coord);
      const snapD = dist(s.coord, point);
      return { station: s, arclen, snapD };
    })
    .filter((x) => x.snapD <= maxSnap)
    .sort((a, b) => a.arclen - b.arclen);

  const ordered: typeof onRoute = [];
  for (const item of onRoute) {
    const last = ordered[ordered.length - 1];
    if (last && last.station.id === item.station.id) continue;
    if (last && Math.abs(last.arclen - item.arclen) < 1e-6) continue;
    ordered.push(item);
  }

  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i].station;
    const to = ordered[i + 1].station;
    const key = from.id < to.id ? from.id + '|' + to.id : to.id + '|' + from.id;
    const lineRef = { id: route.id, label: route.label, color: loomColor(route.color) };

    let edge = edgeMap.get(key);
    if (!edge) {
      const seg = slicePolyline(route.coords, ordered[i].arclen, ordered[i + 1].arclen);
      edge = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: seg },
        properties: { from: from.id, to: to.id, lines: [lineRef] },
      };
      edgeMap.set(key, edge);
    } else {
      const lines = edge.properties.lines as Array<{ id: string }>;
      if (!lines.some((l) => l.id === route.id)) lines.push(lineRef);
    }
  }
}

features.push(...stationFeatures, ...edgeMap.values());
const edgeCount = edgeMap.size;

writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }));
console.error(
  `Prepared ${features.length} features (${stations.length} stations, ${edgeCount} corridor edges, ${routes.length} routes)\n` +
    `  from ${inPath} → ${outPath}`,
);
