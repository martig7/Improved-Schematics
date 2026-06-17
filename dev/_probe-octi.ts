import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';
import type { Coordinate } from '../src/types/core';

// metro geojson -> game shapes (borrowed minimal subset of render-sea-compare)
const raw = JSON.parse(readFileSync('SEA-metro.geojson', 'utf-8'));
const stations: any[] = [];
const routes: any[] = [];
const routePolys = new Map<string, any>();
for (const f of raw.features) {
  const layer = f.properties.layer;
  if (layer === 'stations' && f.geometry.type === 'Point') {
    const id = String(f.properties.id);
    stations.push({ id, name: String(f.properties.name ?? id), position: f.geometry.coordinates, stNodeIds: ['sn-' + id], trackGroupId: id });
  } else if (layer === 'routes' && f.geometry.type === 'LineString') {
    const id = String(f.properties.id);
    routePolys.set(id, { id, color: String(f.properties.color ?? '#888'), coords: f.geometry.coordinates });
  }
}
// match stations to route polylines by proximity to build stCombos (as the compare script does)
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
for (const rp of routePolys.values()) {
  const stops: any[] = [];
  for (const st of stations) {
    let best = Infinity;
    for (const c of rp.coords) best = Math.min(best, dist(st.position, c));
    if (best < 0.002) stops.push(st);
  }
  const proj = (p: number[]) => {
    let bestArc = 0, bestD = Infinity, acc = 0;
    for (let i = 1; i < rp.coords.length; i++) {
      const a = rp.coords[i - 1], b = rp.coords[i];
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const c2 = vx * vx + vy * vy;
      const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
      const q = [a[0] + t * vx, a[1] + t * vy];
      const d = dist(p, q);
      if (d < bestD) { bestD = d; bestArc = acc + Math.hypot(q[0] - a[0], q[1] - a[1]); }
      acc += Math.hypot(vx, vy);
    }
    return bestArc;
  };
  stops.sort((x, y) => proj(x.position) - proj(y.position));
  const combos = [];
  for (let i = 1; i < stops.length; i++) {
    combos.push({ startStNodeId: 'sn-' + stops[i - 1].id, endStNodeId: 'sn-' + stops[i].id, path: [] });
  }
  routes.push({ id: rp.id, color: rp.color, stCombos: combos });
}

const groups = getOrBuildStationGroups(stations as never, undefined);
const graph = buildTransitGraph(stations as never, routes as never, groups, [] as never);
const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
const b = computeBounds(framePts)!;
const proj = createProjection(padBounds(b, 0.1), 2000, 2000, 0.06);
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);
const dHat = 20;
const params: TopoParams = { dHat, step: 5, convergenceEpsilon: 0.002, maxRounds: 8, stationCandidateRadius: 40, preserveStations: false };
const support = buildSupportGraph(graph, groups, params);
const degs = new Map<number, number>();
let maxDeg = 0;
for (const [nid, eids] of support.adj) {
  const d = eids.length;
  degs.set(d, (degs.get(d) ?? 0) + 1);
  if (d > maxDeg) maxDeg = d;
}
console.log('support nodes:', support.nodes.size, 'edges:', support.edges.size);
console.log('degree histogram:', [...degs.entries()].sort((a, b) => a[0] - b[0]));
console.log('max degree:', maxDeg);
