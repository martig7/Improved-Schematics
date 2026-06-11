import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untangleLineOrder } from './untangle';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });

function makeLayout(
  nodes: Array<[string, number, number]>,
  edges: Array<{ id: string; from: string; to: string; lines: string[]; order?: string[] }>,
  traversals: Record<string, TraversalStep[]>,
): Layout {
  const nodeMap = new Map(
    nodes.map(([id, x, y]) => [id, { id, cell: [x, y] as [number, number], label: '', lngLat: [0, 0] as [number, number] }]),
  );
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    path: [nodeMap.get(e.from)!.cell, nodeMap.get(e.to)!.cell],
    lines: e.lines.map(L),
    lineOrder: e.order ?? [...e.lines].sort(),
    stops: new Map(),
  }));
  return {
    cellSize: 1,
    nodes: nodeMap,
    edges: layoutEdges,
    lineTraversals: new Map(Object.entries(traversals)),
  };
}

test('untangle: contracted deg-2 run mirrors order across opposed orientations', () => {
  // ea: a->n, eb: b->n (both INTO the shared deg-2 node) — same line set, so
  // they contract into one opt edge; write-back must mirror the order on eb.
  const layout = makeLayout(
    [['a', 0, 0], ['n', 10, 0], ['b', 20, 0]],
    [
      { id: 'ea', from: 'a', to: 'n', lines: ['L1', 'L2'] },
      { id: 'eb', from: 'b', to: 'n', lines: ['L1', 'L2'] },
    ],
    {
      L1: [{ edgeId: 'ea', reversed: false }, { edgeId: 'eb', reversed: true }],
      L2: [{ edgeId: 'ea', reversed: false }, { edgeId: 'eb', reversed: true }],
    },
  );
  untangleLineOrder(layout);
  const ea = layout.edges.find((e) => e.id === 'ea')!;
  const eb = layout.edges.find((e) => e.id === 'eb')!;
  assert.deepEqual([...ea.lineOrder].reverse(), eb.lineOrder, 'order mirrors across the flip');
});

test('untangle: Y junction picks the rotation-consistent trunk order', () => {
  // trunk t: r->n {A,B}; p: n->(30,-10) {A}; q: n->(30,10) {B}.
  // Clockwise sweep at n demands trunk order [A,B]; start from the bad one.
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B'], order: ['B', 'A'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  untangleLineOrder(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  assert.deepEqual(t.lineOrder, ['A', 'B']);
});

test('untangle: keeps partner lines adjacent (no separation)', () => {
  // trunk {A,B,C}; branch p continues {A,B}; branch q continues {C}.
  // Starting from [A,C,B] (A/B separated), the optimum reunites A and B.
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B', 'C'], order: ['A', 'C', 'B'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A', 'B'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['C'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      C: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  untangleLineOrder(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  const ia = t.lineOrder.indexOf('A');
  const ib = t.lineOrder.indexOf('B');
  assert.equal(Math.abs(ia - ib), 1, `A and B adjacent (got ${t.lineOrder})`);
});

test('untangle: deterministic and preserves line membership', () => {
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B', 'C'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A', 'B'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['C'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      C: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  untangleLineOrder(layout);
  const first = layout.edges.map((e) => [...e.lineOrder]);
  untangleLineOrder(layout);
  const second = layout.edges.map((e) => [...e.lineOrder]);
  assert.deepEqual(first, second, 'idempotent');
  for (const e of layout.edges) {
    assert.deepEqual([...e.lineOrder].sort(), e.lines.map((l) => l.id).sort());
  }
});
