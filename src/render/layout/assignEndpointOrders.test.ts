import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignEndpointOrders } from './assignEndpointOrders';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });

function makeLayout(
  nodes: Array<[string, number, number]>,
  edges: Array<{ id: string; from: string; to: string; lines: string[]; order: string[]; path?: [number, number][] }>,
  traversals: Record<string, TraversalStep[]>,
): Layout {
  const nodeMap = new Map(
    nodes.map(([id, x, y]) => [id, { id, cell: [x, y] as [number, number], label: '', lngLat: [0, 0] as [number, number] }]),
  );
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    id: e.id, from: e.from, to: e.to,
    path: e.path ?? [nodeMap.get(e.from)!.cell, nodeMap.get(e.to)!.cell],
    lines: e.lines.map(L), lineOrder: e.order, stops: new Map(),
  }));
  return { cellSize: 1, nodes: nodeMap, edges: layoutEdges, lineTraversals: new Map(Object.entries(traversals)) };
}

test('assignEndpointOrders: Y junction sets endpoint orders, marks planar', () => {
  // trunk t: r->n {A,B}; p: n->pe {A} (NE); q: n->qe {B} (SE).
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B'], order: ['B', 'A'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'], order: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'], order: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  assignEndpointOrders(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  // The endpoint order at n (t.to) is planar; A,B must be a valid permutation.
  assert.deepEqual([...(t.orderTo ?? [])].sort(), ['A', 'B']);
  assert.ok(!layout.nonPlanarNodes || layout.nonPlanarNodes.size === 0);
  // lineOrder stays equal to orderFrom (offsets.ts authority unchanged).
  assert.deepEqual(t.lineOrder, t.orderFrom ?? t.lineOrder);
});

test('assignEndpointOrders: leaves orderFrom===orderTo on a plain deg-2 pass-through', () => {
  // a->m->b, single line set {A,B}; nothing to reorder, no internal crossings.
  const layout = makeLayout(
    [['a', 0, 0], ['m', 10, 0], ['b', 20, 0]],
    [
      { id: 'e1', from: 'a', to: 'm', lines: ['A', 'B'], order: ['A', 'B'] },
      { id: 'e2', from: 'm', to: 'b', lines: ['A', 'B'], order: ['A', 'B'] },
    ],
    {
      A: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
      B: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
    },
  );
  assignEndpointOrders(layout);
  const e1 = layout.edges.find((e) => e.id === 'e1')!;
  assert.deepEqual(e1.orderFrom, e1.orderTo, 'no internal crossing on a clean pass-through');
});
