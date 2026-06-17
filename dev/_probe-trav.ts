/** Quick probe: why do support traversals have discontinuities? */
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import { buildSupportGraph, type TopoParams } from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds } from '../src/render/projection';

const APP = process.env.APPDATA + '\\metro-maker4\\migration-backups\\2025-11-21_23-54-40-398Z\\';
const data = JSON.parse(readFileSync(APP + 'new_york_freeplay_590fec73.json', 'utf-8')).data;
const groups = getOrBuildStationGroups(data.stations, data.stationGroups);
const graph = buildTransitGraph(data.stations, data.routes, groups, data.tracks);
const b = computeBounds([...graph.nodes.values()].map((n) => ({ points: [n.lngLat] })))!;
const proj = createProjection(padBounds(b, 0.1), 2700, 2700, 0.06);
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat);

const params: TopoParams = {
  dHat: 16,
  step: 4,
  convergenceEpsilon: 0.002,
  maxRounds: 8,
  stationCandidateRadius: 32,
  preserveStations: true,
};
const h = buildSupportGraph(graph, groups, params);

const worst = '61e967cf-efc0-4034-a2ca-1f7717c59b44';
const steps = h.lineTraversals.get(worst)!;
console.log('line', worst, 'steps', steps.length);
for (let i = 0; i < steps.length; i++) {
  const s = steps[i];
  const e = h.edges.get(s.edgeId)!;
  const from = s.reversed ? e.to : e.from;
  const to = s.reversed ? e.from : e.to;
  let gap = '';
  if (i > 0) {
    const p = steps[i - 1];
    const pe = h.edges.get(p.edgeId)!;
    const pend = p.reversed ? pe.from : pe.to;
    if (pend !== from) gap = ` *** GAP expected ${pend} got ${from}`;
  }
  console.log(i, s.edgeId.slice(0, 8), from.slice(0, 6), '->', to.slice(0, 6), gap);
}
