import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCrossings, inversions, totalEdgeCrossings } from './crossings';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });
function mk(
  edges: Array<{ id: string; from: string; to: string; lines: string[]; orderFrom?: string[]; orderTo?: string[] }>,
  nonPlanar: string[] = [],
): Layout {
  const layoutEdges = edges.map((e) => ({
    id: e.id, from: e.from, to: e.to, path: [[0, 0], [1, 0]] as [number, number][],
    lines: e.lines.map(L), lineOrder: e.orderFrom ?? e.lines, orderFrom: e.orderFrom, orderTo: e.orderTo, stops: new Map(),
  })) as LayoutEdge[];
  return {
    cellSize: 1, nodes: new Map(), edges: layoutEdges,
    lineTraversals: new Map<string, TraversalStep[]>(), nonPlanarNodes: new Set(nonPlanar),
  };
}

test('inversions: counts adjacent swaps to reorder', () => {
  assert.equal(inversions(['A', 'B', 'C'], ['A', 'B', 'C']), 0);
  assert.equal(inversions(['A', 'B'], ['B', 'A']), 1);
  assert.equal(inversions(['A', 'B', 'C'], ['C', 'B', 'A']), 3);
});

test('countCrossings: on-edge crossings = endpoint-order inversions', () => {
  const layout = mk([{ id: 'e', from: 'a', to: 'b', lines: ['A', 'B'], orderFrom: ['A', 'B'], orderTo: ['B', 'A'] }]);
  const r = countCrossings(layout);
  assert.equal(r.onEdges, 1);
  assert.equal(r.atNodes, 0);
  assert.equal(totalEdgeCrossings(layout), 1);
});

test('countCrossings: residual non-planar nodes counted at nodes', () => {
  const layout = mk([{ id: 'e', from: 'a', to: 'b', lines: ['A'], orderFrom: ['A'], orderTo: ['A'] }], ['a']);
  const r = countCrossings(layout);
  assert.equal(r.atNodes, 1);
  assert.equal(r.nonPlanar, 1);
});
