import { test } from 'node:test';
import assert from 'node:assert';
import { detectChains, type ChainEdgeRef } from '../chains';
import type { Pixel } from '../layout/types';

const SP = 6;

function args(
  edges: ChainEdgeRef[],
  bases: Record<string, Pixel[]>,
  lanes: Record<string, number>,
) {
  return {
    edges,
    basePoly: (id: string) => bases[id],
    laneCount: (id: string) => lanes[id] ?? 0,
    spacing: SP,
  };
}

test('chains: a dominated run between two anchors is one chain', () => {
  // 3-lane corridor with two short interior edges; a perpendicular branch
  // at C gives the interior nodes genuine turn reach, so both interior
  // edges are far shorter than reach(from)+reach(to) and chain together.
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'm1', from: 'B', to: 'C' },
    { id: 'm2', from: 'C', to: 'D' },
    { id: 'b', from: 'D', to: 'E' },
    { id: 'br', from: 'C', to: 'X' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [60, 0]],
    m1: [[60, 0], [70, 0]],
    m2: [[70, 0], [78, 0]],
    b: [[78, 0], [138, 0]],
    br: [[70, 0], [70, 40]],
  };
  const chains = detectChains(args(edges, bases, { a: 3, m1: 3, m2: 3, b: 3, br: 1 }));
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].edgeIds, ['m1', 'm2']);
  assert.equal(chains[0].anchorA, 'a');
  assert.equal(chains[0].anchorB, 'b');
});

test('chains: an isolated long edge is not chained', () => {
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'l', from: 'B', to: 'C' },
    { id: 'b', from: 'C', to: 'D' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [80, 0]],
    l: [[80, 0], [200, 0]],
    b: [[200, 0], [280, 0]],
  };
  const chains = detectChains(args(edges, bases, { a: 2, l: 2, b: 2 }));
  assert.equal(chains.length, 0);
});

test('chains: the walk continues through a branch node along the collinear edge', () => {
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'm1', from: 'B', to: 'C' },
    { id: 'm2', from: 'C', to: 'D' },
    { id: 'diag', from: 'C', to: 'X' },
    { id: 'b', from: 'D', to: 'E' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [70, 0]],
    m1: [[70, 0], [79, 0]],
    m2: [[79, 0], [88, 0]],
    diag: [[79, 0], [110, 31]],
    b: [[88, 0], [160, 0]],
  };
  const chains = detectChains(args(edges, bases, { a: 4, m1: 4, m2: 4, diag: 2, b: 4 }));
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].edgeIds, ['m1', 'm2']);
});

test('chains: a chain ending at a terminus (no far anchor) still reports with one anchor', () => {
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'm1', from: 'B', to: 'C' },
    { id: 'br', from: 'B', to: 'X' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [80, 0]],
    m1: [[80, 0], [90, 0]],
    br: [[80, 0], [80, 40]],
  };
  const chains = detectChains(args(edges, bases, { a: 3, m1: 3, br: 1 }));
  assert.equal(chains.length, 1);
  assert.equal(chains[0].anchorA, 'a');
  assert.equal(chains[0].anchorB, null);
});
