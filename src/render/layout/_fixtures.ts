// Shared test fixtures: build small TransitGraphs directly (bypassing the API
// mapping) for layout/render unit tests.

import type { TransitGraph, GraphEdge, LineRef, Pixel, Layout, LayoutNode, LayoutEdge } from './types';

/** A polyline graph: nodes at the given pixel positions, one line through all. */
export function lineGraph(positions: Pixel[], lineId = 'L1', color = '#ff0000'): TransitGraph {
  const line: LineRef = { id: lineId, label: lineId, color };
  const nodes = new Map();
  positions.forEach((pos, i) => {
    nodes.set('n' + i, { id: 'n' + i, label: 'N' + i, pos, lngLat: [pos[0] / 1e5, pos[1] / 1e5] });
  });
  const edges: GraphEdge[] = [];
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (let i = 0; i < positions.length - 1; i++) {
    const e: GraphEdge = {
      id: 'e' + i,
      from: 'n' + i,
      to: 'n' + (i + 1),
      lines: [line],
      stops: new Map([[lineId, { atFrom: true, atTo: true }]]),
    };
    edges.push(e);
    adj.get(e.from)!.push(e.id);
    adj.get(e.to)!.push(e.id);
  }
  const lineTraversals = new Map([[lineId, edges.map((e) => ({ edgeId: e.id, reversed: false }))]]);
  return { nodes, edges, adj, lineTraversals };
}

/** Two lines sharing the middle node, forming a "+": for ordering tests. */
export function twoLineGraph(): TransitGraph {
  const g = lineGraph(
    [
      [0, 0],
      [100, 0],
      [200, 0],
    ],
    'L1',
    '#ff0000',
  );
  // add a second line L2 running along the same two edges
  const l2: LineRef = { id: 'L2', label: 'L2', color: '#0000ff' };
  for (const e of g.edges) {
    e.lines.push(l2);
    e.stops.set('L2', { atFrom: true, atTo: true });
  }
  g.lineTraversals.set('L2', g.edges.map((e) => ({ edgeId: e.id, reversed: false })));
  return g;
}

/** A minimal placed layout: three nodes in a row joined by two edges, both
 *  carrying lines L1 and L2. Enough to exercise line ordering without running
 *  a full layout engine. */
export function twoLineLayout(): Layout {
  const L1: LineRef = { id: 'L1', label: 'L1', color: '#ff0000' };
  const L2: LineRef = { id: 'L2', label: 'L2', color: '#0000ff' };
  const mkEdge = (id: string, from: string, to: string): LayoutEdge => ({
    id, from, to, path: [], lines: [L1, L2], lineOrder: [], stops: new Map(),
  });
  const mkNode = (id: string, col: number): LayoutNode => ({
    id, cell: [col, 0], label: id.toUpperCase(), lngLat: [0, 0],
  });
  return {
    cellSize: 1,
    nodes: new Map([['n0', mkNode('n0', 0)], ['n1', mkNode('n1', 1)], ['n2', mkNode('n2', 2)]]),
    edges: [mkEdge('e0', 'n0', 'n1'), mkEdge('e1', 'n1', 'n2')],
    lineTraversals: new Map(),
  };
}
