import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignEndpointOrders } from './assignEndpointOrders';
import type { Layout, LayoutEdge, LineRef, TraversalStep, EdgeStop } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });

function makeLayout(
  nodes: Array<[string, number, number]>,
  edges: Array<{
    id: string; from: string; to: string; lines: string[]; order: string[];
    path?: [number, number][]; stopAtFrom?: string[]; stopAtTo?: string[];
  }>,
): Layout {
  const nodeMap = new Map(
    nodes.map(([id, x, y]) => [id, { id, cell: [x, y] as [number, number], label: '', lngLat: [0, 0] as [number, number] }]),
  );
  const layoutEdges: LayoutEdge[] = edges.map((e) => {
    const stops = new Map<string, EdgeStop>();
    for (const l of new Set([...(e.stopAtFrom ?? []), ...(e.stopAtTo ?? [])])) {
      stops.set(l, { atFrom: (e.stopAtFrom ?? []).includes(l), atTo: (e.stopAtTo ?? []).includes(l) });
    }
    return {
      id: e.id, from: e.from, to: e.to,
      path: e.path ?? [nodeMap.get(e.from)!.cell, nodeMap.get(e.to)!.cell],
      lines: e.lines.map(L), lineOrder: e.order, stops,
    };
  });
  return { cellSize: 1, nodes: nodeMap, edges: layoutEdges, lineTraversals: new Map<string, TraversalStep[]>() };
}

// Y junction: trunk t (r->n) {A,B}; branch p (n->pe) {A} NE; branch q (n->qe) {B} SE.
// Trunk seed order is [B,A]; the planar fan order at n is [A,B] (A's NE dest is the
// -lateral side). Geometry parameterized by trunk path + whether n is a station.
function yLayout(opts: { stopAtN?: boolean; trunkPath?: [number, number][] }): Layout {
  return makeLayout(
    [['r', 0, 0], ['n', 60, 0], ['pe', 70, -10], ['qe', 70, 10]],
    [
      {
        id: 't', from: 'r', to: 'n', lines: ['A', 'B'], order: ['B', 'A'],
        path: opts.trunkPath ?? [[0, 0], [60, 0]],
        stopAtTo: opts.stopAtN ? ['A'] : undefined,
      },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'], order: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'], order: ['B'] },
    ],
  );
}

test('assignEndpointOrders: station fan with an absorbing bend relocates the braid onto the trunk', () => {
  // n is a station and the trunk has an interior vertex >=30px from n, so the
  // within-bundle reorder is adopted at n and shows up as a trunk edge crossing.
  const layout = yLayout({ stopAtN: true, trunkPath: [[0, 0], [30, 0], [60, 0]] });
  assignEndpointOrders(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  assert.notDeepEqual(t.orderFrom, t.orderTo, 'a within-bundle swap was relocated onto the trunk');
  assert.deepEqual([...(t.orderTo ?? [])].sort(), ['A', 'B'], 'station end is a valid permutation');
  assert.deepEqual(t.lineOrder, t.orderFrom, 'lineOrder tracks orderFrom for offsets.ts');
});

test('assignEndpointOrders: non-station fan junction is left untouched (minimal intervention)', () => {
  // Same fan geometry but NO stop at n: n is not a marker, so untangle's stable
  // order is kept verbatim — no manufactured crossings on the trunk.
  const layout = yLayout({ stopAtN: false, trunkPath: [[0, 0], [30, 0], [60, 0]] });
  assignEndpointOrders(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  assert.deepEqual(t.orderFrom, ['B', 'A']);
  assert.deepEqual(t.orderTo, ['B', 'A'], 'non-station node keeps lineOrder at both ends');
});

test('assignEndpointOrders: station fan WITHOUT an absorbing bend is gated off (no regression)', () => {
  // n is a station but the trunk is a straight 2-point edge: there is nowhere to
  // put the swap clear of the marker, so the gate declines and keeps lineOrder.
  const layout = yLayout({ stopAtN: true, trunkPath: [[0, 0], [60, 0]] });
  assignEndpointOrders(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  assert.deepEqual(t.orderFrom, t.orderTo, 'gate prevented a stub knot at the marker');
  assert.deepEqual(t.orderFrom, ['B', 'A'], 'kept untangle order');
});

test('assignEndpointOrders: plain deg-2 pass-through station stays identity', () => {
  // a->m->b single line set {A,B}, m is a station; no fan, so planar == lineOrder
  // and orderFrom===orderTo (no crossing manufactured).
  const layout = makeLayout(
    [['a', 0, 0], ['m', 30, 0], ['b', 60, 0]],
    [
      { id: 'e1', from: 'a', to: 'm', lines: ['A', 'B'], order: ['A', 'B'], path: [[0, 0], [15, 0], [30, 0]], stopAtTo: ['A'] },
      { id: 'e2', from: 'm', to: 'b', lines: ['A', 'B'], order: ['A', 'B'], path: [[30, 0], [45, 0], [60, 0]], stopAtFrom: ['A'] },
    ],
  );
  assignEndpointOrders(layout);
  const e1 = layout.edges.find((e) => e.id === 'e1')!;
  assert.deepEqual(e1.orderFrom, e1.orderTo, 'no internal crossing on a clean pass-through');
});
