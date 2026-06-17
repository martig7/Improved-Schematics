// Synthetic out-and-back probe: a stub edge E (J->T) traversed fwd then rev.
// Verifies (1) imageMerge pass 4/5 output, (2) renderRibbons draw behavior.
import type { SupportGraph, SupportNode, SupportEdge, Image, Pixel } from '../src/render/layout/types';
import { mergeCoincidentPaths } from '../src/render/layout/imageMerge';
import { renderRibbons } from '../src/render/renderOctilinear';
import type { Layout, LayoutNode, LayoutEdge, Cell, EdgeStop } from '../src/render/layout/types';
import { orderLines } from '../src/render/layout/lineOrder';

const N = (id: string, x: number, y: number): SupportNode => ({ id, pos: [x, y] });
const nodes = new Map<string, SupportNode>([
  ['A', N('A', 0, 200)],
  ['J', N('J', 100, 200)],
  ['T', N('T', 100, 100)],
  ['B', N('B', 200, 200)],
]);
const E = (id: string, from: string, to: string, lines: string[]): SupportEdge => ({
  id, from, to,
  points: [nodes.get(from)!.pos.slice() as Pixel, nodes.get(to)!.pos.slice() as Pixel],
  lineIds: new Set(lines),
});
const edges = new Map<string, SupportEdge>([
  ['e1', E('e1', 'A', 'J', ['red', 'yel'])],
  ['eS', E('eS', 'J', 'T', ['red', 'yel'])],   // the stub
  ['e2', E('e2', 'J', 'B', ['red', 'yel'])],
]);
const adj = new Map<string, string[]>([
  ['A', ['e1']], ['J', ['e1', 'eS', 'e2']], ['T', ['eS']], ['B', ['e2']],
]);
const h: SupportGraph = {
  nodes, edges, adj,
  lineRefs: new Map([
    ['red', { id: 'red', label: 'R', color: '#ff0000' }],
    ['yel', { id: 'yel', label: 'Y', color: '#cccc00' }],
  ]),
  lineTraversals: new Map([
    // out-and-back over the stub, then continue
    ['red', [
      { edgeId: 'e1', reversed: false },
      { edgeId: 'eS', reversed: false },
      { edgeId: 'eS', reversed: true },
      { edgeId: 'e2', reversed: false },
    ]],
    ['yel', [
      { edgeId: 'e1', reversed: false },
      { edgeId: 'eS', reversed: false },
      { edgeId: 'eS', reversed: true },
      { edgeId: 'e2', reversed: false },
    ]],
  ]),
  stations: new Map([
    ['gA', { id: 'gA', label: 'A', lngLat: [0, 0], nodeId: 'A' }],
    ['gJ', { id: 'gJ', label: 'J', lngLat: [0, 0], nodeId: 'J' }],
    ['gT', { id: 'gT', label: 'T', lngLat: [0, 0], nodeId: 'T' }],
    ['gB', { id: 'gB', label: 'B', lngLat: [0, 0], nodeId: 'B' }],
  ]),
  stopAt: new Set([
    'red|A', 'red|J', 'red|T', 'red|B',
    'yel|A', 'yel|J', 'yel|T', 'yel|B',
  ]),
};

// fake octi image: identity placement, straight paths (with a midpoint on the
// stub so it has >1 segment, exercising run construction)
const img: Image = {
  placement: new Map([['A', [0, 200]], ['J', [100, 200]], ['T', [100, 100]], ['B', [200, 200]]]),
  paths: new Map<string, Pixel[]>([
    ['e1', [[0, 200], [100, 200]]],
    ['eS', [[100, 200], [100, 150], [100, 100]]],
    ['e2', [[100, 200], [200, 200]]],
  ]),
  cellSize: 50,
};

const m = mergeCoincidentPaths(h, img);
console.log('--- merged graph ---');
console.log('nodes:', [...m.h.nodes.keys()].join(' '));
for (const [id, e] of m.h.edges) console.log('edge', id, e.from, '->', e.to, 'lines:', [...e.lineIds].join(','), 'pts:', JSON.stringify(e.points));
console.log('--- merged traversals ---');
for (const [lid, steps] of m.h.lineTraversals) {
  console.log(lid, steps.map((s) => s.edgeId + (s.reversed ? 'R' : 'F')).join(' '));
}
console.log('--- stations ---');
for (const [gid, st] of m.h.stations) console.log(gid, '->', st.nodeId);
console.log('--- stopAt ---', [...m.h.stopAt].join(' '));

// ---- now feed through supportToLayout-equivalent + renderRibbons ----------
const lNodes = new Map<string, LayoutNode>();
const nodePx = new Map<string, Pixel>();
for (const [id, n] of m.h.nodes) {
  lNodes.set(id, { id, cell: [n.pos[0], n.pos[1]] as Cell, label: id, lngLat: [0, 0] });
  nodePx.set(id, n.pos);
}
const lEdges: LayoutEdge[] = [];
for (const e of m.h.edges.values()) {
  const lines = [...e.lineIds].map((id) => m.h.lineRefs.get(id)!);
  const stops = new Map<string, EdgeStop>();
  for (const id of e.lineIds) {
    const atFrom = m.h.stopAt.has(id + '|' + e.from);
    const atTo = m.h.stopAt.has(id + '|' + e.to);
    if (atFrom || atTo) stops.set(id, { atFrom, atTo });
  }
  lEdges.push({
    id: e.id, from: e.from, to: e.to,
    path: e.points.map((p) => [p[0], p[1]] as Cell),
    lines, lineOrder: lines.map((l) => l.id).sort(), stops,
  });
}
const layout: Layout = { cellSize: 1, nodes: lNodes, edges: lEdges, lineTraversals: m.h.lineTraversals };
orderLines(layout);

const svg = renderRibbons({
  layout, nodePx,
  edgePolyline: (e) => e.path.map((c) => [c[0], c[1]] as Pixel),
  width: 300, height: 300, dark: false, showLabels: false,
});
console.log('--- svg ---');
console.log(svg);
// count stroke paths and their d-command shape
const strokes = [...svg.matchAll(/<path d="([^"]+)"[^>]*data-line-id="([^"]+)"/g)];
for (const s of strokes) {
  const moves = (s[1].match(/M/g) ?? []).length;
  console.log(`line ${s[2]}: subpaths=${moves} d=${s[1]}`);
}
const dots = [...svg.matchAll(/data-station-id="([^"]+)"/g)].map((x) => x[1]);
console.log('stop markers at nodes:', dots.join(' '));
