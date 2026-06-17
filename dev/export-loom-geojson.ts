/**
 * Export a Subway Builder save as LOOM GeoJSON (stdin format for topo/loom/octi).
 * Usage: pnpm exec tsx dev/export-loom-geojson.ts [save.json] > dev/nyc-loom.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import type { Route, Track } from '../src/types/game-state';

const APP =
  process.env.APPDATA +
  '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const savePath = process.argv[2] ?? APP + 'new_york_freeplay_590fec73.json';
const outPath = process.argv[3] ?? 'dev/nyc-loom.json';

const save = JSON.parse(readFileSync(savePath, 'utf-8'));
const data = save.data ?? save;
const routes: Route[] = data.routes ?? [];
const tracks: Track[] = data.tracks ?? [];
const stations = data.stations ?? [];
const groups = getOrBuildStationGroups(stations, data.stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);

function loomColor(hex: string): string {
  return hex.replace(/^#/, '').toLowerCase();
}

type Feature = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};

const features: Feature[] = [];

for (const n of graph.nodes.values()) {
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [n.lngLat[0], n.lngLat[1]] },
    properties: {
      id: n.id,
      station_id: n.id,
      station_label: n.label,
    },
  });
}

for (const e of graph.edges) {
  const coords =
    e.geo && e.geo.length >= 2
      ? e.geo.map(([lng, lat]) => [lng, lat])
      : [graph.nodes.get(e.from)!.lngLat, graph.nodes.get(e.to)!.lngLat];
  features.push({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: {
      from: e.from,
      to: e.to,
      lines: e.lines.map((l) => ({ id: l.id, label: l.label, color: loomColor(l.color) })),
    },
  });
}

const geojson = { type: 'FeatureCollection', features };
writeFileSync(outPath, JSON.stringify(geojson));
console.error(`Wrote ${features.length} features (${graph.nodes.size} stations, ${graph.edges.length} edges) → ${outPath}`);
