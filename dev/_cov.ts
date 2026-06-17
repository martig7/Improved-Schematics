import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { topo } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';

const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const data = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8')).data;
const groups = getOrBuildStationGroups(data.stations, data.stationGroups);
const graph = buildTransitGraph(data.stations, data.routes, groups);
const b = computeBounds([...graph.nodes.values()].map((n) => ({ points: [n.lngLat] })))!;
const proj = createProjection(padBounds(b, 0.1), 2000, 2000, 0.06);
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);
const h = topo(graph, groups, { lineWidth: 4 });

const covered = new Set<string>();
let discont = 0;
for (const [lid, steps] of h.lineTraversals) {
  for (const s of steps) covered.add(s.edgeId);
  // continuity check
  for (let i = 1; i < steps.length; i++) {
    const e0 = h.edges.get(steps[i - 1].edgeId)!;
    const e1 = h.edges.get(steps[i].edgeId)!;
    const end0 = steps[i - 1].reversed ? e0.from : e0.to;
    const start1 = steps[i].reversed ? e1.to : e1.from;
    if (end0 !== start1) discont++;
  }
}
console.log('support edges total', h.edges.size, 'covered by some traversal', covered.size, 'UNcovered', h.edges.size - covered.size);
console.log('discontinuities across all line traversals:', discont);
// which lines dropped
for (const [lid] of graph.lineTraversals) if (!h.lineTraversals.has(lid)) console.log('DROPPED line', lid, 'origSteps', graph.lineTraversals.get(lid)!.length);
