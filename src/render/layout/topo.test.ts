import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, polylineLength, densify, creepBlocked, runMergeRounds, type TopoParams } from './topo';
import type { Pixel, TransitGraph, GraphEdge, LineRef } from './types';

test('dist computes euclidean distance', () => {
  assert.equal(dist([0, 0], [3, 4]), 5);
});

test('polylineLength sums segment lengths', () => {
  assert.equal(polylineLength([[0, 0], [0, 10], [10, 10]]), 20);
});

test('densify produces equispaced points including both endpoints', () => {
  const pts = densify([[0, 0], [0, 10]], 2.5);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [0, 10]);
  // 10 / 2.5 = 4 segments -> 5 points
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[1], [0, 2.5]);
});

test('densify never returns fewer than the two endpoints', () => {
  const pts = densify([[0, 0], [1, 0]], 100);
  assert.deepEqual(pts, [[0, 0], [1, 0]]);
});

test('creepBlocked rejects a candidate that interlaces an obtuse meeting', () => {
  // samples along a straight run; p1 far left, pl far right.
  const samples: Pixel[] = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const pk: Pixel = [20, 0];
  // candidate sitting almost on top of p_k: alpha*dist(pk,p1)=0.707*20=14.1 > 0
  // distance to candidate ~0, so 14.1 <= 0 is false AND 0.707*10 <= 0 false -> NOT blocked
  assert.equal(creepBlocked([20.1, 0], pk, samples), false);
  // a candidate far from p_k relative to its distance to the ends IS blocked:
  // dist(pk, far)=15 ; alpha*dist(pk,p1)=14.1 <= 15 -> blocked
  assert.equal(creepBlocked([20, 15], pk, samples), true);
});

import { NodeIndex } from './topo';

test('NodeIndex returns the nearest node within radius, or null beyond it', () => {
  const idx = new NodeIndex(5);
  idx.insert('a', [0, 0]);
  idx.insert('b', [3, 0]);
  idx.insert('c', [100, 100]);
  assert.equal(idx.nearest([1, 0], 5), 'a');
  assert.equal(idx.nearest([2.6, 0], 5), 'b');
  assert.equal(idx.nearest([50, 50], 5), null);
});

test('NodeIndex.move keeps lookups consistent after a node snaps', () => {
  const idx = new NodeIndex(5);
  idx.insert('a', [0, 0]);
  idx.move('a', [0, 0], [20, 0]);
  assert.equal(idx.nearest([19, 0], 5), 'a');
  assert.equal(idx.nearest([1, 0], 5), null);
});

import { HBuilder } from './topo';

test('HBuilder.addOrUnionEdge unions line ids on a repeated node pair', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([10, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(a, b, new Set(['L2']));
  const edges = h.edgeList();
  assert.equal(edges.length, 1);
  assert.deepEqual([...edges[0].lineIds].sort(), ['L1', 'L2']);
});

test('HBuilder.snap averages a node toward a sample', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  h.snap(a, [10, 0]);
  assert.deepEqual(h.nodePos(a), [5, 0]);
});

test('contractDegree2WithMatchingLines collapses a straight matching run', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([10, 0]);
  const c = h.addNode([20, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(b, c, new Set(['L1']));
  h.contractDegree2WithMatchingLines();
  const edges = h.edgeList();
  assert.equal(edges.length, 1);
  // merged polyline keeps the through point b
  assert.equal(edges[0].points.length, 3);
});

test('contractDegree2 does NOT collapse when line sets differ', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([10, 0]);
  const c = h.addNode([20, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(b, c, new Set(['L2']));
  h.contractDegree2WithMatchingLines();
  assert.equal(h.edgeList().length, 2);
});

function graphFrom(
  nodes: Record<string, [number, number]>,
  edges: Array<{ id: string; from: string; to: string; lines: string[] }>,
): TransitGraph {
  const nodeMap = new Map(
    Object.entries(nodes).map(([id, pos]) => [
      id,
      { id, label: id, pos: pos as [number, number], lngLat: [pos[0] / 1e5, pos[1] / 1e5] as [number, number] },
    ]),
  );
  const ref = (id: string): LineRef => ({ id, label: id, color: '#000' });
  const gEdges: GraphEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    lines: e.lines.map(ref),
    stops: new Map(),
  }));
  const adj = new Map<string, string[]>();
  for (const id of nodeMap.keys()) adj.set(id, []);
  for (const e of gEdges) {
    adj.get(e.from)!.push(e.id);
    adj.get(e.to)!.push(e.id);
  }
  return { nodes: nodeMap, edges: gEdges, adj, lineTraversals: new Map() };
}

const PARAMS: TopoParams = {
  dHat: 20,
  step: 5,
  convergenceEpsilon: 0.002,
  maxRounds: 8,
  stationCandidateRadius: 40,
};

test('two near-parallel edges within d̂ merge to a single corridor edge', () => {
  // Two horizontal edges 8px apart (< d̂=20), same span.
  const g = graphFrom(
    { a0: [0, 0], a1: [100, 0], b0: [0, 8], b1: [100, 8] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L2'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  const edges = h.edgeList();
  // The two runs collapse into one corridor carrying both lines.
  const carriers = edges.filter((e) => e.lineIds.has('L1') && e.lineIds.has('L2'));
  assert.ok(carriers.length >= 1, 'expected a shared corridor edge');
});

test('two parallel edges farther than d̂ stay separate', () => {
  const g = graphFrom(
    { a0: [0, 0], a1: [100, 0], b0: [0, 80], b1: [100, 80] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L2'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  const shared = h.edgeList().filter((e) => e.lineIds.has('L1') && e.lineIds.has('L2'));
  assert.equal(shared.length, 0, 'far edges must not merge');
});

test('a ~90° crossing does not merge (creep blocker prevents interlace)', () => {
  const g = graphFrom(
    { a0: [-100, 0], a1: [100, 0], b0: [0, -100], b1: [0, 100] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L2'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  const shared = h.edgeList().filter((e) => e.lineIds.has('L1') && e.lineIds.has('L2'));
  assert.equal(shared.length, 0, 'crossing edges must not interlace into a shared run');
});

test('intersectionSmoothing recentres a node toward its cropped neighbours', () => {
  const h = new HBuilder(50);
  const c = h.addNode([0, 0]);
  const e = h.addNode([100, 0]);
  const w = h.addNode([-100, 2]);
  h.addOrUnionEdge(c, e, new Set(['L1']));
  h.addOrUnionEdge(c, w, new Set(['L1']));
  h.intersectionSmoothing(40);
  // The node should move toward the average of the two cropped endpoints,
  // which sit symmetric in x but slightly off in y → small y shift, ~0 x.
  const p = h.nodePos(c);
  assert.ok(Math.abs(p[0]) < 1, 'x stays centred');
  assert.ok(p[1] > 0 && p[1] < 2, 'y nudged toward the offset neighbour');
});
