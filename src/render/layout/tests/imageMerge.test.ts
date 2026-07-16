import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separateFusedStations, collapseFoldStubs } from '../imageMerge';
import type { Image, Pixel, SupportGraph } from '../types';

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
  // distinct station groups always render separate markers. Capsule-ness
  // comes from the group itself, not from fusion geometry.
  const { h, img } = fusedFixture([108, 4]); // close pair of true positions
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
  // A mostly-perpendicular true offset projects very close to N, inside
  // MIN_SPLIT_ARC. The split point must be pushed along the edge instead.
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
  // the new node and not overshoot through the keeper.
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

/** Ring A -(e1)- N -(e2)- B -(e3)- A with two station groups fused at N.
 *  L1 runs straight through N (keeper's line); L2 is a CLOSED circular course
 *  whose seam sits at N, built in either orientation. */
function ringFixture(l2Steps: { edgeId: string; reversed: boolean }[]): { h: SupportGraph; img: Image } {
  const nodes = new Map([
    ['A', { id: 'A', pos: [0, 0] as Pixel }],
    ['N', { id: 'N', pos: [100, 0] as Pixel }],
    ['B', { id: 'B', pos: [200, 0] as Pixel }],
  ]);
  const edges = new Map([
    ['e1', { id: 'e1', from: 'A', to: 'N', points: [[0, 0], [100, 0]] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
    ['e2', { id: 'e2', from: 'N', to: 'B', points: [[100, 0], [200, 0]] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
    ['e3', { id: 'e3', from: 'B', to: 'A', points: [[200, 0], [100, 80], [0, 0]] as Pixel[], lineIds: new Set(['L2']) }],
  ]);
  const h: SupportGraph = {
    nodes,
    edges,
    adj: new Map([
      ['A', ['e1', 'e3']],
      ['N', ['e1', 'e2']],
      ['B', ['e2', 'e3']],
    ]),
    lineRefs: new Map(),
    lineTraversals: new Map([
      ['L1', [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }]],
      ['L2', l2Steps],
    ]),
    stations: new Map([
      ['g1', { id: 'g1', label: 'Near St', lngLat: [0, 0], nodeId: 'N', truePos: [97, 2] as Pixel, stopLines: new Set(['L1']) }],
      ['g2', { id: 'g2', label: 'Loop Stop', lngLat: [0, 0], nodeId: 'N', truePos: [140, 10] as Pixel, stopLines: new Set(['L2']) }],
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
      ['e3', [[200, 0], [100, 80], [0, 0]] as Pixel[]],
    ]),
    cellSize: 16,
  };
  return { h, img };
}

/** Course endpoints of a traversal: [start node, end node]. */
function courseEnds(h: SupportGraph, lineId: string): [string, string] {
  const steps = h.lineTraversals.get(lineId)!;
  const eF = h.edges.get(steps[0].edgeId)!;
  const eL = h.edges.get(steps[steps.length - 1].edgeId)!;
  return [
    steps[0].reversed ? eF.to : eF.from,
    steps[steps.length - 1].reversed ? eL.from : eL.to,
  ];
}

test('separateFusedStations keeps a circular course closed (seam at the tail)', () => {
  // L2 circles N -> A -> B -> N; the final leg re-enters N over the edge the
  // split cuts. The boundary trim must not pop the loop-closing step.
  const { h, img } = ringFixture([
    { edgeId: 'e1', reversed: true },  // N -> A
    { edgeId: 'e3', reversed: true },  // A -> B
    { edgeId: 'e2', reversed: true },  // B -> N (loop-closing leg)
  ]);
  separateFusedStations(h, img, 16);
  const g2 = h.stations.get('g2')!;
  assert.notEqual(g2.nodeId, 'N', 'loop stop split onto its own node');
  const [start, end] = courseEnds(h, 'L2');
  assert.equal(start, end, `circular course stays closed (got ${start} -> ${end})`);
  const steps = h.lineTraversals.get('L2')!;
  assert.ok(
    steps.some((s) => {
      const e = h.edges.get(s.edgeId)!;
      return e.from === g2.nodeId || e.to === g2.nodeId;
    }),
    'course still reaches the split stop node',
  );
});

test('separateFusedStations keeps a circular course closed (seam at the head)', () => {
  // Same ring, opposite direction: the FIRST leg departs N over the split
  // edge. The head-side trim must not shift the departing step away.
  const { h, img } = ringFixture([
    { edgeId: 'e2', reversed: false }, // N -> B
    { edgeId: 'e3', reversed: false }, // B -> A
    { edgeId: 'e1', reversed: false }, // A -> N
  ]);
  separateFusedStations(h, img, 16);
  const g2 = h.stations.get('g2')!;
  assert.notEqual(g2.nodeId, 'N');
  const [start, end] = courseEnds(h, 'L2');
  assert.equal(start, end, `circular course stays closed (got ${start} -> ${end})`);
});

test('separateFusedStations still trims a round-trip course originating at the fused node', () => {
  // L2 is a round trip N -> B -> N (same-edge seam, not a ring). Its origin
  // stop splits onto the corridor; the boundary keeper-half steps are real
  // turnaround tails and must still be trimmed so the drawn course turns
  // around at the new marker instead of overshooting to the keeper.
  const { h, img } = ringFixture([
    { edgeId: 'e2', reversed: false }, // N -> B
    { edgeId: 'e2', reversed: true },  // B -> N
  ]);
  separateFusedStations(h, img, 16);
  const g2 = h.stations.get('g2')!;
  assert.notEqual(g2.nodeId, 'N');
  const keeperHalf = h.adj.get('N')!.find((id) => id.startsWith('e2'));
  const steps = h.lineTraversals.get('L2')!;
  assert.ok(
    !steps.some((s) => s.edgeId === keeperHalf),
    `round-trip course no longer reaches the keeper (got ${JSON.stringify(steps)})`,
  );
  const [start, end] = courseEnds(h, 'L2');
  assert.equal(start, g2.nodeId, 'course starts at the split stop');
  assert.equal(end, g2.nodeId, 'course ends at the split stop');
});

/** Corridor A -(eA)- J -(eB)- B with a fold stub J -(eS)- S: every line rides
 *  out and back over the stub, S hosts the stop of `stopLine` (station group
 *  g1 seated on S). The graph-course truth is passed per test as the
 *  realTurnGroups set: empty = every course passes straight through. */
function foldStubFixture(opts: { stopLine?: string; stubArc?: number } = {}) {
  const stopLine = opts.stopLine ?? 'L1';
  const sPos: Pixel = [100 + (opts.stubArc ?? 30), -(opts.stubArc ?? 30)];
  const h: SupportGraph = {
    nodes: new Map([
      ['mA', { id: 'mA', pos: [0, 0] as Pixel }],
      ['mJ', { id: 'mJ', pos: [100, 0] as Pixel }],
      ['mB', { id: 'mB', pos: [200, 0] as Pixel }],
      ['mS', { id: 'mS', pos: sPos }],
    ]),
    edges: new Map([
      ['eA', { id: 'eA', from: 'mA', to: 'mJ', points: [[0, 0], [100, 0]] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
      ['eB', { id: 'eB', from: 'mJ', to: 'mB', points: [[100, 0], [200, 0]] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
      ['eS', { id: 'eS', from: 'mJ', to: 'mS', points: [[100, 0], sPos] as Pixel[], lineIds: new Set(['L1', 'L2']) }],
    ]),
    adj: new Map([
      ['mA', ['eA']],
      ['mJ', ['eA', 'eB', 'eS']],
      ['mB', ['eB']],
      ['mS', ['eS']],
    ]),
    lineRefs: new Map(),
    lineTraversals: new Map([
      ['L1', [
        { edgeId: 'eA', reversed: false },
        { edgeId: 'eS', reversed: false },
        { edgeId: 'eS', reversed: true },
        { edgeId: 'eB', reversed: false },
      ]],
      ['L2', [
        { edgeId: 'eB', reversed: true },
        { edgeId: 'eS', reversed: false },
        { edgeId: 'eS', reversed: true },
        { edgeId: 'eA', reversed: true },
      ]],
    ]),
    stations: new Map([
      ['g1', { id: 'g1', label: 'Fold St', lngLat: [0, 0], nodeId: 'mS', stopNodes: new Map([[stopLine, 'mS']]) }],
    ]),
    stopAt: new Set([stopLine + '|mS']),
  };
  const img: Image = {
    placement: new Map([
      ['mA', [0, 0] as Pixel],
      ['mJ', [100, 0] as Pixel],
      ['mB', [200, 0] as Pixel],
      ['mS', sPos],
    ]),
    paths: new Map([
      ['eA', [[0, 0], [100, 0]] as Pixel[]],
      ['eB', [[100, 0], [200, 0]] as Pixel[]],
      ['eS', [[100, 0], sPos] as Pixel[]],
    ]),
    cellSize: 32,
  };
  return { h, img };
}

test('collapseFoldStubs collapses a manufactured stop-fold onto the fold base', () => {
  const { h, img } = foldStubFixture();
  const n = collapseFoldStubs(h, img, new Set());
  assert.equal(n, 1, 'one stub collapsed');
  assert.ok(!h.edges.has('eS') && !h.nodes.has('mS'), 'stub edge and tip gone');
  assert.equal(h.stations.get('g1')!.nodeId, 'mJ', 'station relocated to the fold base');
  assert.equal(h.stations.get('g1')!.stopNodes!.get('L1'), 'mJ', 'stop node remapped');
  assert.ok(h.stopAt.has('L1|mJ') && !h.stopAt.has('L1|mS'), 'stop flag remapped');
  assert.deepEqual(h.lineTraversals.get('L1'), [
    { edgeId: 'eA', reversed: false },
    { edgeId: 'eB', reversed: false },
  ], 'retrace removed from the traversal');
  assert.ok(!img.paths.has('eS') && !img.placement.has('mS'), 'image cleaned');
});

test('collapseFoldStubs keeps a REAL out-and-back (graph course turns around at the station)', () => {
  const { h, img } = foldStubFixture();
  const n = collapseFoldStubs(h, img, new Set(['L1|g1']));
  assert.equal(n, 0, 'real branch tip kept');
  assert.ok(h.edges.has('eS') && h.nodes.has('mS'));
});

test('collapseFoldStubs collapses a support-level fold the graph course passes through', () => {
  // The drawn traversal retraces the stub for every line, but the graph
  // course truth says no line turns around at the seated station: the fold
  // was manufactured upstream (weld/contraction) and must still collapse.
  const { h, img } = foldStubFixture();
  const n = collapseFoldStubs(h, img, new Set(['L1|gOther', 'L2|gOther']));
  assert.equal(n, 1, 'upstream-manufactured fold collapsed');
  assert.equal(h.stations.get('g1')!.nodeId, 'mJ');
});

test('collapseFoldStubs keeps a stub when a line terminates on it', () => {
  const { h, img } = foldStubFixture();
  // L2 now ENDS at the tip instead of retracing: a real terminus stub
  h.lineTraversals.set('L2', [
    { edgeId: 'eB', reversed: true },
    { edgeId: 'eS', reversed: false },
  ]);
  const n = collapseFoldStubs(h, img, new Set());
  assert.equal(n, 0, 'terminus stub kept');
});

test('collapseFoldStubs keeps a stop-less stub for the hook splice', () => {
  const { h, img } = foldStubFixture();
  h.stopAt.clear();
  const n = collapseFoldStubs(h, img, new Set());
  assert.equal(n, 0);
});

test('collapseFoldStubs keeps a stub whose stop has no seated station', () => {
  // A stop flag with no station entry offers no group to consult the graph
  // truth with; the stub stays rather than collapse on a guess.
  const { h, img } = foldStubFixture();
  h.stations.clear();
  const n = collapseFoldStubs(h, img, new Set());
  assert.equal(n, 0, 'stationless stub kept');
});

test('collapseFoldStubs keeps a stub longer than the placement-artifact cap', () => {
  const { h, img } = foldStubFixture({ stubArc: 80 }); // > 2 cells of 32
  const n = collapseFoldStubs(h, img, new Set());
  assert.equal(n, 0, 'long stub is real geometry');
});

test('collapseFoldStubs is deterministic on repeat', () => {
  const run = () => {
    const { h, img } = foldStubFixture();
    collapseFoldStubs(h, img, new Set());
    return JSON.stringify([[...h.edges.keys()].sort(), [...h.stopAt].sort(), h.lineTraversals.get('L1')]);
  };
  assert.equal(run(), run());
});

test('collapseFoldStubs keeps a terminus station whose lines turn around beyond it', () => {
  // The station sits at the stub node, but its lines START there and turn
  // around at the OTHER end (tip = fold base): a real terminal, not a fold.
  const { h, img } = foldStubFixture();
  h.lineTraversals.set('L1', [
    { edgeId: 'eS', reversed: true },
    { edgeId: 'eS', reversed: false },
  ]);
  h.lineTraversals.set('L2', [
    { edgeId: 'eS', reversed: true },
    { edgeId: 'eS', reversed: false },
  ]);
  const n = collapseFoldStubs(h, img, new Set());
  assert.equal(n, 0, 'terminal station kept');
  assert.ok(h.nodes.has('mS') && h.edges.has('eS'));
});
