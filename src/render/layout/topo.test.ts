import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, polylineLength, densify, creepBlocked, runMergeRounds, buildSupportGraph, topo, cutPolylineFolds, type TopoParams } from './topo';
import type { Pixel, TransitGraph, GraphEdge, LineRef, StationGroup } from './types';

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

test('contractShortEdges merges a junction micro-mesh and folds the spur legs', () => {
  // Seattle NW hairpin shape in miniature: a balloon spur whose up-pass and
  // down-pass corridors land on two near-coincident base nodes joined by a
  // tiny mesh edge that degree-2 contraction cannot remove because junction
  // edges (E) keep the nodes above degree 2.
  const h = new HBuilder(5);
  const baseUp = h.addNode([0, 0]);
  const baseDn = h.addNode([3, 4]);
  const apex = h.addNode([0, 100]);
  const west = h.addNode([-100, 0]);
  const east = h.addNode([100, 0]);
  h.addOrUnionEdge(baseUp, baseDn, new Set(['L'])); // 5px mesh connector
  h.addOrUnionEdge(baseUp, apex, new Set(['L'])); // spur up-pass
  h.addOrUnionEdge(baseDn, apex, new Set(['L'])); // spur down-pass
  h.addOrUnionEdge(west, baseUp, new Set(['L', 'E']));
  h.addOrUnionEdge(baseDn, east, new Set(['L', 'E']));
  h.contractShortEdges(20);
  // baseUp/baseDn merge; the two spur legs become parallel edges and fold
  // into ONE base->apex edge still carrying L.
  const edges = h.edgeList();
  const spur = edges.filter((e) => e.a === apex || e.b === apex);
  assert.equal(spur.length, 1);
  assert.deepEqual([...spur[0].lineIds], ['L']);
  assert.equal(edges.length, 3); // west-base, base-apex, base-east
});

test('contractShortEdges folds parallel edges with line-set union', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([6, 0]);
  const c = h.addNode([100, 0]);
  h.addOrUnionEdge(a, c, new Set(['L1']));
  h.addOrUnionEdge(b, c, new Set(['L2']));
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.contractShortEdges(10);
  const edges = h.edgeList();
  assert.equal(edges.length, 1);
  assert.deepEqual([...edges[0].lineIds].sort(), ['L1', 'L2']);
});

test('contractShortEdges leaves edges at/above the threshold alone', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([20, 0]);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.contractShortEdges(20);
  assert.equal(h.edgeList().length, 1);
});

test('contractShortEdges keeps protected endpoints anchored', () => {
  // w-a-b-c chain so the short a-b edge is interior (terminal stubs are
  // exempt from contraction; see the degree-1 guard).
  const h = new HBuilder(5);
  const w = h.addNode([-100, 0]);
  const a = h.addNode([0, 0]);
  const b = h.addNode([5, 0]);
  const c = h.addNode([100, 0]);
  h.markProtected(b);
  h.addOrUnionEdge(w, a, new Set(['L1']));
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.addOrUnionEdge(b, c, new Set(['L1']));
  h.contractShortEdges(10);
  // a merges into protected b; b's position is untouched.
  assert.deepEqual(h.nodePos(b), [5, 0]);
  const edges = h.edgeList();
  assert.equal(edges.length, 2);
  assert.equal(edges.some((e) => e.a === b || e.b === b), true);
});

test('contractShortEdges leaves terminal stubs alone', () => {
  // A 6px dead-end stub off a junction: contracting it would delete a real
  // terminus station's corridor (the 320 Pl bug).
  const h = new HBuilder(5);
  const j = h.addNode([0, 0]);
  const tip = h.addNode([6, 0]);
  const w = h.addNode([-100, 0]);
  const e = h.addNode([0, 100]);
  h.addOrUnionEdge(j, tip, new Set(['L1']));
  h.addOrUnionEdge(w, j, new Set(['L1']));
  h.addOrUnionEdge(j, e, new Set(['L2']));
  h.contractShortEdges(16);
  assert.equal(h.edgeList().length, 3);
  assert.deepEqual(h.nodePos(tip), [6, 0]);
});

test('cutPolylineFolds leaves straight and gently-curved polylines alone', () => {
  const straight: Pixel[] = [[0, 0], [50, 0], [100, 0], [150, 0]];
  assert.deepEqual(cutPolylineFolds(straight, 16), straight);
  // genuine V-corner: legs touch near the vertex but diverge immediately
  const v: Pixel[] = [[0, 0], [50, 5], [100, 0], [50, -5], [0, -40]];
  assert.equal(cutPolylineFolds(v, 16).length, v.length);
});

test('cutPolylineFolds excises an out-and-back retrace', () => {
  // edge goes 100px out and comes straight back to 10px from its start
  const pts: Pixel[] = [[0, 0], [50, 2], [100, 4], [50, 6], [10, 8], [12, 30]];
  const cut = cutPolylineFolds(pts, 16);
  let len = 0;
  for (let i = 1; i < cut.length; i++) len += Math.hypot(cut[i][0] - cut[i - 1][0], cut[i][1] - cut[i - 1][1]);
  assert.ok(len < 60, `expected fold removed, length ${len}`);
  // endpoints survive
  assert.deepEqual(cut[0], [0, 0]);
  assert.deepEqual(cut[cut.length - 1], [12, 30]);
});

test('cutPolylineFolds cuts a balloon loop at its neck', () => {
  // lasso: straight approach, 40px-diameter loop, exit at the neck
  const pts: Pixel[] = [
    [0, 0], [40, 0], [80, 0],            // approach
    [100, 20], [120, 0], [100, -20],     // loop around
    [82, -2],                            // back to within eps of [80,0]
    [40, -4], [0, -6],                   // retrace out
  ];
  const cut = cutPolylineFolds(pts, 16);
  let len = 0;
  for (let i = 1; i < cut.length; i++) len += Math.hypot(cut[i][0] - cut[i - 1][0], cut[i][1] - cut[i - 1][1]);
  const span = Math.hypot(cut[cut.length - 1][0] - cut[0][0], cut[cut.length - 1][1] - cut[0][1]);
  assert.ok(len < span * 30, 'loop interior removed');
  assert.ok(cut.length < pts.length);
  assert.deepEqual(cut[cut.length - 1], [0, -6]);
});

test('contractShortEdges skips an edge between two protected nodes', () => {
  const h = new HBuilder(5);
  const a = h.addNode([0, 0]);
  const b = h.addNode([5, 0]);
  h.markProtected(a);
  h.markProtected(b);
  h.addOrUnionEdge(a, b, new Set(['L1']));
  h.contractShortEdges(10);
  assert.equal(h.edgeList().length, 1);
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

test('buildSupportGraph reconstructs a continuous line traversal over merged edges', () => {
  const g = graphFrom(
    { a: [0, 0], b: [100, 0], c: [200, 0] },
    [
      { id: 'e0', from: 'a', to: 'b', lines: ['L1'] },
      { id: 'e1', from: 'b', to: 'c', lines: ['L1'] },
    ],
  );
  g.lineTraversals.set('L1', [
    { edgeId: 'e0', reversed: false },
    { edgeId: 'e1', reversed: false },
  ]);
  const groups: StationGroup[] = [
    { id: 'a', name: 'A', center: [0, 0], stationIds: [] },
    { id: 'b', name: 'B', center: [100 / 1e5, 0], stationIds: [] },
    { id: 'c', name: 'C', center: [200 / 1e5, 0], stationIds: [] },
  ];
  const h = buildSupportGraph(g, groups, PARAMS);
  const steps = h.lineTraversals.get('L1')!;
  assert.ok(steps.length > 0);
  for (let i = 1; i < steps.length; i++) {
    const e0 = h.edges.get(steps[i - 1].edgeId)!;
    const e1 = h.edges.get(steps[i].edgeId)!;
    const end0 = steps[i - 1].reversed ? e0.from : e0.to;
    const start1 = steps[i].reversed ? e1.to : e1.from;
    assert.equal(end0, start1, `step ${i} should connect to step ${i - 1}`);
  }
});

test('buildSupportGraph reconstructs a single line traversal over merged edges', () => {
  const g = graphFrom(
    { a: [0, 0], b: [100, 0], c: [200, 0] },
    [
      { id: 'e0', from: 'a', to: 'b', lines: ['L1'] },
      { id: 'e1', from: 'b', to: 'c', lines: ['L1'] },
    ],
  );
  g.lineTraversals.set('L1', [
    { edgeId: 'e0', reversed: false },
    { edgeId: 'e1', reversed: false },
  ]);
  const groups: StationGroup[] = [
    { id: 'a', name: 'A', center: [0, 0], stationIds: [] },
    { id: 'b', name: 'B', center: [100 / 1e5, 0], stationIds: [] },
    { id: 'c', name: 'C', center: [200 / 1e5, 0], stationIds: [] },
  ];
  const h = buildSupportGraph(g, groups, PARAMS);
  assert.ok(h.lineTraversals.has('L1'));
  // L1 covers the whole corridor; its traversal touches every support edge.
  const used = new Set(h.lineTraversals.get('L1')!.map((s) => s.edgeId));
  assert.equal(used.size, h.edges.size);
});

test('insertStations places one station when all incident edges share a node', () => {
  // Star: 4 lines meeting at b. One support node should serve all of them.
  const g = graphFrom(
    { b: [0, 0], n: [0, 100], s: [0, -100], e: [100, 0], w: [-100, 0] },
    [
      { id: 'e0', from: 'b', to: 'n', lines: ['L1'] },
      { id: 'e1', from: 'b', to: 's', lines: ['L2'] },
      { id: 'e2', from: 'b', to: 'e', lines: ['L3'] },
      { id: 'e3', from: 'b', to: 'w', lines: ['L4'] },
    ],
  );
  const groups: StationGroup[] = [{ id: 'b', name: 'B', center: [0, 0], stationIds: [] }];
  const h = buildSupportGraph(g, groups, PARAMS);
  assert.equal(h.stations.size, 1);
});

test('topo derives d̂ from line width and corridor capacity', () => {
  const g = graphFrom(
    { a0: [0, 0], a1: [100, 0], b0: [0, 8], b1: [100, 8] },
    [
      { id: 'e0', from: 'a0', to: 'a1', lines: ['L1', 'L2'] },
      { id: 'e1', from: 'b0', to: 'b1', lines: ['L3'] },
    ],
  );
  const groups: StationGroup[] = [
    { id: 'a0', name: 'A0', center: [0, 0], stationIds: [] },
    { id: 'a1', name: 'A1', center: [100 / 1e5, 0], stationIds: [] },
    { id: 'b0', name: 'B0', center: [0, 8 / 1e5], stationIds: [] },
    { id: 'b1', name: 'B1', center: [100 / 1e5, 8 / 1e5], stationIds: [] },
  ];
  // lineWidth 4, maxLinesPerCorridor = 2 → d̂ = 2.5*4*2 = 20
  const h = topo(g, groups, { lineWidth: 4 });
  assert.ok(h.nodes.size > 0);
  assert.ok(h.edges.size > 0);
});

test('merge rounds keep bowed parallel corridors separate (no chord-refeed weld)', () => {
  // Two routes between the same junction pair, bowing 120px apart mid-span —
  // far beyond dHat=20. Round 1 keeps them apart; the old endpoint-chord
  // refeed welded them in round 2.
  const g = graphFrom(
    {
      J1: [0, 0],
      A1: [100, 60],
      A2: [200, 60],
      B1: [100, -60],
      B2: [200, -60],
      J2: [300, 0],
    },
    [
      { id: 'a1', from: 'J1', to: 'A1', lines: ['LA'] },
      { id: 'a2', from: 'A1', to: 'A2', lines: ['LA'] },
      { id: 'a3', from: 'A2', to: 'J2', lines: ['LA'] },
      { id: 'b1', from: 'J1', to: 'B1', lines: ['LB'] },
      { id: 'b2', from: 'B1', to: 'B2', lines: ['LB'] },
      { id: 'b3', from: 'B2', to: 'J2', lines: ['LB'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  let weldedLen = 0;
  for (const e of h.edgeList()) {
    if (e.lineIds.has('LA') && e.lineIds.has('LB')) weldedLen += polylineLength(e.points);
  }
  // Junction-adjacent welds are fine (the routes genuinely meet at J1/J2);
  // the 200px bowed interior must stay two corridors.
  assert.ok(weldedLen < 80, `bowed parallels welded: ${weldedLen}px shared`);
});

test('merge rounds still weld genuinely close parallels', () => {
  // Same shape but the corridors run 8px apart — inside dHat=20. These MUST
  // merge into one corridor carrying both lines.
  const g = graphFrom(
    {
      J1: [0, 0],
      A1: [100, 4],
      A2: [200, 4],
      B1: [100, -4],
      B2: [200, -4],
      J2: [300, 0],
    },
    [
      { id: 'a1', from: 'J1', to: 'A1', lines: ['LA'] },
      { id: 'a2', from: 'A1', to: 'A2', lines: ['LA'] },
      { id: 'a3', from: 'A2', to: 'J2', lines: ['LA'] },
      { id: 'b1', from: 'J1', to: 'B1', lines: ['LB'] },
      { id: 'b2', from: 'B1', to: 'B2', lines: ['LB'] },
      { id: 'b3', from: 'B2', to: 'J2', lines: ['LB'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  let weldedLen = 0;
  let total = 0;
  for (const e of h.edgeList()) {
    const len = polylineLength(e.points);
    total += len;
    if (e.lineIds.has('LA') && e.lineIds.has('LB')) weldedLen += len;
  }
  assert.ok(weldedLen > total * 0.5, `close parallels failed to weld: ${weldedLen}/${total}px`);
});
