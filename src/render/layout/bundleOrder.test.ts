import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorridors, classifyFlows } from './bundleOrder';
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

test('corridors: deg-2 identical-set runs contract into one corridor', () => {
  // r -e1- m -e2- n : same {A,B} through deg-2 m -> ONE corridor r..n
  const layout = makeLayout(
    [['r', 0, 0], ['m', 10, 0], ['n', 20, 0]],
    [
      { id: 'e1', from: 'r', to: 'm', lines: ['A', 'B'] },
      { id: 'e2', from: 'm', to: 'n', lines: ['A', 'B'] },
    ],
    {
      A: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
      B: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  assert.equal(cs.corridors.length, 1);
  const c = cs.corridors[0];
  assert.deepEqual([c.endA, c.endB], ['r', 'n']);
  assert.deepEqual(c.parts.map((p) => p.edge.id), ['e1', 'e2']);
});

test('corridors: a line-set change breaks the run', () => {
  const layout = makeLayout(
    [['r', 0, 0], ['m', 10, 0], ['n', 20, 0]],
    [
      { id: 'e1', from: 'r', to: 'm', lines: ['A', 'B'] },
      { id: 'e2', from: 'm', to: 'n', lines: ['A'] },
    ],
    {
      A: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
      B: [{ edgeId: 'e1', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  assert.equal(cs.corridors.length, 2);
});

test('flows: per-junction line transitions from traversals', () => {
  // Y: trunk t {A,B} from r to n; branches p {A}, q {B} out of n
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  const flows = classifyFlows(layout, cs);
  const atN = flows.get('n')!;
  const tCorr = cs.byEdge.get('t')!;
  const pCorr = cs.byEdge.get('p')!;
  const qCorr = cs.byEdge.get('q')!;
  assert.equal(atN.get('A')!.from, tCorr.id);
  assert.equal(atN.get('A')!.to, pCorr.id);
  assert.equal(atN.get('B')!.from, tCorr.id);
  assert.equal(atN.get('B')!.to, qCorr.id);
  // terminals: at r, A arrives from nothing and leaves on t
  const atR = flows.get('r')!;
  assert.equal(atR.get('A')!.from, null);
  assert.equal(atR.get('A')!.to, tCorr.id);
});
