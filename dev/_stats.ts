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

let maxLines = 2;
for (const e of graph.edges) maxLines = Math.max(maxLines, e.lines.length);
console.log('INPUT graph: nodes', graph.nodes.size, 'edges', graph.edges.length, 'lines', graph.lineTraversals.size, 'maxLinesPerCorridor', maxLines);
console.log('derived dHat =', 2.5 * 4 * maxLines, 'px');

const lens: number[] = [];
for (const e of graph.edges) { const a=graph.nodes.get(e.from)!.pos, c=graph.nodes.get(e.to)!.pos; lens.push(Math.hypot(a[0]-c[0],a[1]-c[1])); }
lens.sort((x,y)=>x-y);
console.log('input edge length: min', lens[0].toFixed(1), 'median', lens[lens.length>>1].toFixed(1), 'max', lens.at(-1)!.toFixed(1));

const h = topo(graph, groups, { lineWidth: 4 });
console.log('SUPPORT graph: nodes', h.nodes.size, 'edges', h.edges.size, 'stations', h.stations.size);
let withTrav = 0, totalSteps = 0;
for (const [lid] of graph.lineTraversals) { const t = h.lineTraversals.get(lid); if (t && t.length) { withTrav++; totalSteps += t.length; } }
console.log('lines with reconstructed traversal:', withTrav, '/', graph.lineTraversals.size, 'avg steps', (totalSteps/Math.max(1,withTrav)).toFixed(1));
const degs = [...h.adj.values()].map(a=>a.length);
console.log('support node degree: min', Math.min(...degs), 'max', Math.max(...degs), 'isolated(deg0)', degs.filter(d=>d===0).length);
