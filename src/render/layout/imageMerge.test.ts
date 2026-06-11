import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separateFusedStations } from './imageMerge';
import type { Image, Pixel, SupportGraph } from './types';

/** Straight 3-node corridor A -(e1)- N -(e2)- B with lines L1+L2 on both
 *  edges; two station groups fused at N. */
function fusedFixture(g2True: Pixel): { h: SupportGraph; img: Image } {
  const nodes = new Map([
    ['A', { id: 'A', pos: [0, 0] as Pixel }],
    ['N', { id: 'N', pos: [100, 0] as Pixel }],
    ['B', { id: 'B', pos: [200, 0] as Pixel }],
  ]);
  const edges = new Map([
    ['e1', { id: 'e1', from: 'A', to: 'N', points: [[0, 0], [100, 0]] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
    ['e2', { id: 'e2', from: 'N', to: 'B', points: [[100, 0], [200, 0]] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
  ]);
  const h: SupportGraph = {
    nodes,
    edges,
    adj: new Map([
      ['A', ['e1']],
      ['N', ['e1', 'e2']],
      ['B', ['e2']],
    ]),
    lineRefs: new Map(),
    lineTraversals: new Map([
      ['L1', [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }]],
      ['L2', [{ edgeId: 'e2', reversed: true }, { edgeId: 'e1', reversed: true }]],
    ]),
    stations: new Map([
      ['g1', { id: 'g1', label: 'Near St', lngLat: [0, 0], nodeId: 'N', truePos: [97, 2] as Pixel, stopLines: new Set(['L1']) }],
      ['g2', { id: 'g2', label: 'Far Av', lngLat: [0, 0], nodeId: 'N', truePos: g2True, stopLines: new Set(['L2']) }],
    ]),
    stopAt: new Set(['L1|N', 'L2|N']),
  };
  const img: Image = {
    placement: new Map([
      ['A', [0, 0] as Pixel],
      ['N', [100, 0] as Pixel],
      ['B', [200, 0] as Pixel],
    ]),
    paths: new Map([
      ['e1', [[0, 0], [100, 0]] as Pixel[]],
      ['e2', [[100, 0], [200, 0]] as Pixel[]],
    ]),
    cellSize: 16,
  };
  return { h, img };
}

test('separateFusedStations splits far-apart groups onto a new on-line node', () => {
  const { h, img } = fusedFixture([140, 10]);
  separateFusedStations(h, img, 16);

  const g1 = h.stations.get('g1')!;
  const g2 = h.stations.get('g2')!;
  assert.equal(g1.nodeId, 'N', 'closest group keeps the drawn node');
  assert.notEqual(g2.nodeId, 'N', 'far group moves to its own node');

  const ms = h.nodes.get(g2.nodeId)!;
  assert.ok(Math.abs(ms.pos[0] - 140) < 1e-6 && Math.abs(ms.pos[1]) < 1e-6,
    `new node at the true-position projection (got ${ms.pos})`);

  // e2 split into two edges through the new node, geometry intact
  assert.equal(h.edges.has('e2'), false);
  const adjMs = h.adj.get(g2.nodeId)!;
  assert.equal(adjMs.length, 2);
  const [ea, eb] = adjMs.map((id) => h.edges.get(id)!);
  assert.equal(ea.to, g2.nodeId);
  assert.equal(eb.from, g2.nodeId);
  assert.deepEqual(img.paths.get(ea.id), [[100, 0], [140, 0]]);
  assert.deepEqual(img.paths.get(eb.id), [[140, 0], [200, 0]]);

  // traversals rejoined in order, forward and reversed
  assert.deepEqual(h.lineTraversals.get('L1'), [
    { edgeId: 'e1', reversed: false },
    { edgeId: ea.id, reversed: false },
    { edgeId: eb.id, reversed: false },
  ]);
  assert.deepEqual(h.lineTraversals.get('L2'), [
    { edgeId: eb.id, reversed: true },
    { edgeId: ea.id, reversed: true },
    { edgeId: 'e1', reversed: true },
  ]);

  // stop flags moved with the group
  assert.ok(h.stopAt.has('L2|' + g2.nodeId));
  assert.ok(!h.stopAt.has('L2|N'));
  assert.ok(h.stopAt.has('L1|N'));
});

test('separateFusedStations splits even close pairs (one marker per station)', () => {
  // user rule: distinct station groups ALWAYS render separate markers —
  // capsule-ness comes from the group itself, not from fusion geometry
  const { h, img } = fusedFixture([108, 4]); // ~11px from g1's truePos
  separateFusedStations(h, img, 16);
  const g1 = h.stations.get('g1')!;
  const g2 = h.stations.get('g2')!;
  assert.equal(g1.nodeId, 'N', 'closest group keeps the drawn node');
  assert.notEqual(g2.nodeId, 'N', 'close pair still gets its own node');
  const p = h.nodes.get(g2.nodeId)!.pos;
  assert.ok(Math.hypot(p[0] - 100, p[1]) >= 8 - 1e-9, `dots visually apart (got ${p})`);
  assert.ok(h.stopAt.has('L1|N') && h.stopAt.has('L2|' + g2.nodeId));
});

test('separateFusedStations clamps a near-node projection to a visible arc', () => {
  // true offset mostly perpendicular: projection lands ~3px from N, inside
  // MIN_SPLIT_ARC — the split point must be pushed along the edge instead
  const { h, img } = fusedFixture([103, 30]);
  separateFusedStations(h, img, 16);
  const g2 = h.stations.get('g2')!;
  assert.notEqual(g2.nodeId, 'N');
  const ms = h.nodes.get(g2.nodeId)!;
  assert.ok(ms.pos[0] >= 108 - 1e-6, `split point pushed >= 8px from N (got ${ms.pos})`);
});

test('separateFusedStations trims terminating lines back to the split node', () => {
  // L2 terminates at the fused node N arriving from B: its traversal
  // turns around at N. After g2 splits onto e2 (toward B), L2 must end at
  // the new node — not overshoot through the keeper.
  const { h, img } = fusedFixture([140, 10]);
  h.lineTraversals.set('L2', [
    { edgeId: 'e2', reversed: true },  // B -> N
    { edgeId: 'e2', reversed: false }, // N -> B (turnaround)
  ]);
  separateFusedStations(h, img, 16);
  const g2 = h.stations.get('g2')!;
  assert.notEqual(g2.nodeId, 'N');
  const keeperHalf = h.adj.get('N')!.find((id) => id.startsWith('e2'));
  const steps = h.lineTraversals.get('L2')!;
  assert.ok(
    !steps.some((s) => s.edgeId === keeperHalf),
    `terminating line no longer reaches the keeper (got ${JSON.stringify(steps)})`,
  );
});
