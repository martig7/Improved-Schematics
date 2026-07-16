import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorridors, classifyFlows, orderByBlocks, placeResiduals } from '../bundleOrder';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from '../types';

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

test('blocks: Y join — trunk order matches branch geometry, no crossings', () => {
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
  orderByBlocks(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  assert.deepEqual([...t.lineOrder].sort(), ['A', 'B']);
});

test('blocks: family emergence — partners ride adjacent with zero color logic', () => {
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['P1', 'X', 'P2'], order: ['P1', 'X', 'P2'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['P1', 'P2'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['X'] },
    ],
    {
      P1: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      P2: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      X: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  const i1 = t.lineOrder.indexOf('P1');
  const i2 = t.lineOrder.indexOf('P2');
  assert.equal(Math.abs(i1 - i2), 1, `P1/P2 adjacent structurally (got ${t.lineOrder})`);
});

test('blocks: join lookahead — joined pairs stay intact blocks on the trunk', () => {
  const layout = makeLayout(
    [['a0', 0, -10], ['b0', 0, 10], ['j', 10, 0], ['s', 30, 0], ['n1', 40, -10], ['n2', 40, 10]],
    [
      { id: 'ea', from: 'a0', to: 'j', lines: ['A1', 'A2'] },
      { id: 'eb', from: 'b0', to: 'j', lines: ['B1', 'B2'] },
      { id: 'tr', from: 'j', to: 's', lines: ['A1', 'A2', 'B1', 'B2'] },
      { id: 'n', from: 's', to: 'n1', lines: ['A1', 'B1'] },
      { id: 'm', from: 's', to: 'n2', lines: ['A2', 'B2'] },
    ],
    {
      A1: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'n', reversed: false }],
      A2: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'm', reversed: false }],
      B1: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'n', reversed: false }],
      B2: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'm', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const tr = layout.edges.find((e) => e.id === 'tr')!;
  assert.equal(tr.lineOrder.length, 4);
  const pos = new Map(tr.lineOrder.map((l, i) => [l, i]));
  assert.equal(Math.abs(pos.get('A1')! - pos.get('A2')!), 1, 'A-block intact on the trunk');
  assert.equal(Math.abs(pos.get('B1')! - pos.get('B2')!), 1, 'B-block intact on the trunk');
});

test('blocks: frame invariance — a reversed trunk edge draws the mirror-identical order', () => {
  // Same physical Y twice; the second defines the trunk edge REVERSED
  // (from n to r, traversals riding it reversed). The drawn lateral order
  // along the physical corridor must be identical, i.e. the stored edge
  // order mirrors with the edge frame. Exercises the from.endA === nd
  // junction handoffs that aligned fixtures never reach.
  const mk = (revTrunk: boolean) => makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      revTrunk
        ? { id: 't', from: 'n', to: 'r', lines: ['A', 'B'] }
        : { id: 't', from: 'r', to: 'n', lines: ['A', 'B'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: revTrunk }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: revTrunk }, { edgeId: 'q', reversed: false }],
    },
  );
  const fwd = mk(false);
  orderByBlocks(fwd);
  const rev = mk(true);
  orderByBlocks(rev);
  const tFwd = fwd.edges.find((e) => e.id === 't')!;
  const tRev = rev.edges.find((e) => e.id === 't')!;
  assert.deepEqual([...tFwd.lineOrder].reverse(), tRev.lineOrder,
    `drawn order must be frame-invariant (fwd=${tFwd.lineOrder} rev=${tRev.lineOrder})`);
});

test('blocks: endB-side join — same geometry, same drawn sides', () => {
  // The lookahead fixture with the trunk defined s->j (join lands at the
  // trunk corridor's endB; traversals ride it reversed). Blocks must stay
  // intact and the drawn order must be the exact mirror of the endA-join
  // fixture's trunk order.
  const mk = (revTrunk: boolean) => makeLayout(
    [['a0', 0, -10], ['b0', 0, 10], ['j', 10, 0], ['s', 30, 0], ['n1', 40, -10], ['n2', 40, 10]],
    [
      { id: 'ea', from: 'a0', to: 'j', lines: ['A1', 'A2'] },
      { id: 'eb', from: 'b0', to: 'j', lines: ['B1', 'B2'] },
      revTrunk
        ? { id: 'tr', from: 's', to: 'j', lines: ['A1', 'A2', 'B1', 'B2'] }
        : { id: 'tr', from: 'j', to: 's', lines: ['A1', 'A2', 'B1', 'B2'] },
      { id: 'n', from: 's', to: 'n1', lines: ['A1', 'B1'] },
      { id: 'm', from: 's', to: 'n2', lines: ['A2', 'B2'] },
    ],
    {
      A1: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: revTrunk }, { edgeId: 'n', reversed: false }],
      A2: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: revTrunk }, { edgeId: 'm', reversed: false }],
      B1: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: revTrunk }, { edgeId: 'n', reversed: false }],
      B2: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: revTrunk }, { edgeId: 'm', reversed: false }],
    },
  );
  const fwd = mk(false);
  orderByBlocks(fwd);
  const rev = mk(true);
  orderByBlocks(rev);
  const trFwd = fwd.edges.find((e) => e.id === 'tr')!;
  const trRev = rev.edges.find((e) => e.id === 'tr')!;
  for (const tr of [trFwd, trRev]) {
    const pos = new Map(tr.lineOrder.map((l, i) => [l, i]));
    assert.equal(Math.abs(pos.get('A1')! - pos.get('A2')!), 1, `A-block intact (${tr.lineOrder})`);
    assert.equal(Math.abs(pos.get('B1')! - pos.get('B2')!), 1, `B-block intact (${tr.lineOrder})`);
  }
  assert.deepEqual([...trFwd.lineOrder].reverse(), trRev.lineOrder,
    `endB join draws the same physical sides (fwd=${trFwd.lineOrder} rev=${trRev.lineOrder})`);
});

test('blocks: look-back junctions add zero phantom counts', () => {
  // Lookahead fixture under OCTI_DEBUG: exactly ONE planned
  // crossing (the s-split is structurally non-contiguous) and ZERO cycle
  // residuals. The trunk's look-back at its own settled feeders must not
  // inflate either counter.
  const layout = makeLayout(
    [['a0', 0, -10], ['b0', 0, 10], ['j', 10, 0], ['s', 30, 0], ['n1', 40, -10], ['n2', 40, 10]],
    [
      { id: 'ea', from: 'a0', to: 'j', lines: ['A1', 'A2'] },
      { id: 'eb', from: 'b0', to: 'j', lines: ['B1', 'B2'] },
      { id: 'tr', from: 'j', to: 's', lines: ['A1', 'A2', 'B1', 'B2'] },
      { id: 'n', from: 's', to: 'n1', lines: ['A1', 'B1'] },
      { id: 'm', from: 's', to: 'n2', lines: ['A2', 'B2'] },
    ],
    {
      A1: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'n', reversed: false }],
      A2: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'm', reversed: false }],
      B1: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'n', reversed: false }],
      B2: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'm', reversed: false }],
    },
  );
  const prev = process.env.OCTI_DEBUG;
  process.env.OCTI_DEBUG = '1';
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    orderByBlocks(layout);
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.OCTI_DEBUG;
    else process.env.OCTI_DEBUG = prev;
  }
  const line = logs.find((l) => l.startsWith('[blocks]'));
  assert.ok(line, 'OCTI_DEBUG summary line emitted');
  assert.match(line!, /planned-crossings=1 /, `exactly one real planned crossing: ${line}`);
  assert.match(line!, /cycle-residuals=0 /, `no phantom residuals: ${line}`);
});

test('blocks: triangle cycle — forced inversion lands at a junction, not mid-corridor', () => {
  // three corridors forming a triangle r-s-t, each carrying {A,B}, with
  // branch stubs pinning opposite orders at r and t. SOME junction must eat
  // one A/B flip; every edge's own lineOrder must still be internally
  // consistent with its corridor (no mid-corridor flip is representable).
  const layout = makeLayout(
    [['r', 0, 0], ['s', 20, 0], ['t', 10, 17], ['ra', -10, -5], ['rb', -10, 5], ['ta', 10, 30]],
    [
      { id: 'rs', from: 'r', to: 's', lines: ['A', 'B'] },
      { id: 'st', from: 's', to: 't', lines: ['A', 'B'] },
      { id: 'tr', from: 't', to: 'r', lines: ['A', 'B'] },
      { id: 'pa', from: 'ra', to: 'r', lines: ['A'] },
      { id: 'pb', from: 'rb', to: 'r', lines: ['B'] },
      { id: 'pt', from: 't', to: 'ta', lines: ['A'] },
    ],
    {
      A: [{ edgeId: 'pa', reversed: false }, { edgeId: 'rs', reversed: false }, { edgeId: 'st', reversed: false }, { edgeId: 'pt', reversed: false }],
      B: [{ edgeId: 'pb', reversed: false }, { edgeId: 'rs', reversed: false }, { edgeId: 'st', reversed: false }, { edgeId: 'tr', reversed: false }],
    },
  );
  orderByBlocks(layout);
  for (const id of ['rs', 'st', 'tr']) {
    const e = layout.edges.find((x) => x.id === id)!;
    assert.deepEqual([...e.lineOrder].sort(), [...new Set(e.lines.map((l) => l.id))].sort(),
      `membership preserved on ${id}`);
  }
});

test('blocks: write-back parity — idempotent and membership-preserving', () => {
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
  orderByBlocks(layout);
  const first = layout.edges.map((e) => [...e.lineOrder]);
  orderByBlocks(layout);
  const second = layout.edges.map((e) => [...e.lineOrder]);
  assert.deepEqual(first, second, 'idempotent');
  for (const e of layout.edges) {
    assert.deepEqual([...e.lineOrder].sort(), e.lines.map((l) => l.id).sort());
  }
});

test('blocks: mirrored parts — opposed edge orientations mirror the order', () => {
  // ea: a->n, eb: b->n (both INTO n), same set: one corridor; written orders
  // must mirror across the flip
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
  orderByBlocks(layout);
  const ea = layout.edges.find((e) => e.id === 'ea')!;
  const eb = layout.edges.find((e) => e.id === 'eb')!;
  assert.deepEqual([...ea.lineOrder].reverse(), eb.lineOrder, 'order mirrors across the flip');
});

test('blocks: round-trip traversals never duplicate lines in a block (CPW regression)', () => {
  // Every game route is a ROUND TRIP. Under last-write-wins flow
  // classification a line looks like it enters the shared corridor at
  // BOTH ends, so a downstream join re-adds it and inflates the bundle
  // to more slots than there are lines, weaving at every seam.
  // Shape: one feeder {B,D} joins at `top`; a second stub {A,C} feeds too;
  // shared trunk top->bot carries {A,B,C,D}; split at `bot` into {A,B} and
  // {C,D}. ALL traversals ride out AND back.
  const rt = (steps: TraversalStep[]): TraversalStep[] => [
    ...steps,
    ...[...steps].reverse().map((s) => ({ edgeId: s.edgeId, reversed: !s.reversed })),
  ];
  const layout = makeLayout(
    [['bx', 30, -30], ['no', 10, -30], ['top', 20, -10], ['bot', 20, 50], ['se', 30, 60], ['sw', 10, 60]],
    [
      { id: 'bxe', from: 'bx', to: 'top', lines: ['B', 'D'] },
      { id: 'nse', from: 'no', to: 'top', lines: ['A', 'C'] },
      { id: 'main', from: 'top', to: 'bot', lines: ['A', 'B', 'C', 'D'] },
      { id: 'seb', from: 'bot', to: 'se', lines: ['A', 'B'] },
      { id: 'swb', from: 'bot', to: 'sw', lines: ['C', 'D'] },
    ],
    {
      A: rt([{ edgeId: 'nse', reversed: false }, { edgeId: 'main', reversed: false }, { edgeId: 'seb', reversed: false }]),
      B: rt([{ edgeId: 'bxe', reversed: false }, { edgeId: 'main', reversed: false }, { edgeId: 'seb', reversed: false }]),
      C: rt([{ edgeId: 'nse', reversed: false }, { edgeId: 'main', reversed: false }, { edgeId: 'swb', reversed: false }]),
      D: rt([{ edgeId: 'bxe', reversed: false }, { edgeId: 'main', reversed: false }, { edgeId: 'swb', reversed: false }]),
    },
  );
  orderByBlocks(layout);
  for (const e of layout.edges) {
    const uniq = new Set(e.lineOrder);
    assert.equal(uniq.size, e.lineOrder.length, `no duplicate slots on ${e.id}: ${e.lineOrder}`);
    assert.deepEqual([...e.lineOrder].sort(), e.lines.map((l) => l.id).sort(),
      `membership exact on ${e.id}: ${e.lineOrder}`);
  }
  // and the feeder blocks stay intact on the trunk
  const main = layout.edges.find((e) => e.id === 'main')!;
  const pos = new Map(main.lineOrder.map((l, i) => [l, i]));
  assert.equal(Math.abs(pos.get('B')! - pos.get('D')!), 1, `bronx pair adjacent (${main.lineOrder})`);
  assert.equal(Math.abs(pos.get('A')! - pos.get('C')!), 1, `north pair adjacent (${main.lineOrder})`);
});

test('blocks: bidirectional corridor seeds by arrival, not a turnaround key', () => {
  // Corridor t {P,Q,R} runs a<->b. P and Q travel a->b and exit b (P via cx,
  // Q via cy). R travels the OTHER way: it enters t at b FROM cx and exits at
  // a via cz. R's first "exit" from b is t itself (a turnaround), so a naive
  // seed keys it by the angle back into t and sorts it to an end, splitting it
  // from P (which also rides cx). Keyed by its ARRIVAL corridor (cx), R groups
  // with P instead.
  const layout = makeLayout(
    [['a', 0, 0], ['b', 10, 0], ['xe', 20, -5], ['ye', 20, 5], ['ze', -10, 0]],
    [
      { id: 't', from: 'a', to: 'b', lines: ['P', 'Q', 'R'] },
      { id: 'cx', from: 'b', to: 'xe', lines: ['P', 'R'] },
      { id: 'cy', from: 'b', to: 'ye', lines: ['Q'] },
      { id: 'cz', from: 'a', to: 'ze', lines: ['R'] },
    ],
    {
      P: [{ edgeId: 't', reversed: false }, { edgeId: 'cx', reversed: false }],
      Q: [{ edgeId: 't', reversed: false }, { edgeId: 'cy', reversed: false }],
      R: [{ edgeId: 'cx', reversed: true }, { edgeId: 't', reversed: true }, { edgeId: 'cz', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  const pos = new Map(t.lineOrder.map((l, i) => [l, i]));
  assert.equal(Math.abs(pos.get('P')! - pos.get('R')!), 1,
    `P and R (both ride cx) adjacent, R not stranded (got ${t.lineOrder})`);
});

test('placeResiduals: an interleaved seed bubbles apart by exit angle', () => {
  // trunk t {a,b,x,y,z}: a,b exit to p (up), x,y exit to q (down), z ends at n2.
  const layout = makeLayout(
    [['n1', 0, 0], ['n2', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'n1', to: 'n2', lines: ['a', 'b', 'x', 'y', 'z'] },
      { id: 'p', from: 'n2', to: 'pe', lines: ['a', 'b'] },
      { id: 'q', from: 'n2', to: 'qe', lines: ['x', 'y'] },
    ],
    {
      a: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      b: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      x: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
      y: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
      z: [{ edgeId: 't', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  const flows = classifyFlows(layout, cs);
  const tCorr = cs.byEdge.get('t')!;
  // x (down-exit) seated inside the up-exit pair a,b: the adjacent (x,b) pair
  // disagrees with the exit angles and swaps; the free line z keeps its slot.
  const flats = new Map<number, string[]>([[tCorr.id, ['a', 'x', 'b', 'y', 'z']]]);
  const moves = placeResiduals(flats, cs, flows);
  assert.equal(moves, 1);
  assert.deepEqual(flats.get(tCorr.id), ['a', 'b', 'x', 'y', 'z']);
  // idempotent: a second run makes no further moves
  assert.equal(placeResiduals(flats, cs, flows), 0);
});

test('placeResiduals: the swap applies across the whole co-travel stretch', () => {
  // two-corridor stretch: {x,y} ride t1 (with w) then t2, then split at n3.
  // The interleave (x inside w..y? here: y before x) disagrees only at n3;
  // both corridors must swap together so the n2 boundary stays consistent.
  const layout = makeLayout(
    [['n1', 0, 0], ['n2', 20, 0], ['n3', 40, 0], ['we', 30, -10], ['xe', 50, -10], ['ye', 50, 10]],
    [
      { id: 't1', from: 'n1', to: 'n2', lines: ['w', 'x', 'y'] },
      { id: 'w1', from: 'n2', to: 'we', lines: ['w'] },
      { id: 't2', from: 'n2', to: 'n3', lines: ['x', 'y'] },
      { id: 'ex', from: 'n3', to: 'xe', lines: ['x'] },
      { id: 'ey', from: 'n3', to: 'ye', lines: ['y'] },
    ],
    {
      w: [{ edgeId: 't1', reversed: false }, { edgeId: 'w1', reversed: false }],
      x: [{ edgeId: 't1', reversed: false }, { edgeId: 't2', reversed: false }, { edgeId: 'ex', reversed: false }],
      y: [{ edgeId: 't1', reversed: false }, { edgeId: 't2', reversed: false }, { edgeId: 'ey', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  const flows = classifyFlows(layout, cs);
  const t1 = cs.byEdge.get('t1')!;
  const t2 = cs.byEdge.get('t2')!;
  // y before x contradicts the n3 exit angles (x exits up, y exits down)
  const flats = new Map<number, string[]>([
    [t1.id, ['w', 'y', 'x']],
    [t2.id, ['y', 'x']],
  ]);
  const moves = placeResiduals(flats, cs, flows);
  assert.equal(moves, 1);
  assert.deepEqual(flats.get(t1.id), ['w', 'x', 'y']);
  assert.deepEqual(flats.get(t2.id), ['x', 'y']);
});

test('placeResiduals: genuinely conflicting end demands stay untouched', () => {
  // corridor t {u,v}: at n1 u exits up / v down; at n2 u exits down / v up.
  // Whatever the order, one end pays; strict improvement never fires.
  const layout = makeLayout(
    [['n1', 0, 0], ['n2', 20, 0], ['ua', -10, -10], ['va', -10, 10], ['ub', 30, 10], ['vb', 30, -10]],
    [
      { id: 't', from: 'n1', to: 'n2', lines: ['u', 'v'] },
      { id: 'eua', from: 'ua', to: 'n1', lines: ['u'] },
      { id: 'eva', from: 'va', to: 'n1', lines: ['v'] },
      { id: 'eub', from: 'n2', to: 'ub', lines: ['u'] },
      { id: 'evb', from: 'n2', to: 'vb', lines: ['v'] },
    ],
    {
      u: [{ edgeId: 'eua', reversed: false }, { edgeId: 't', reversed: false }, { edgeId: 'eub', reversed: false }],
      v: [{ edgeId: 'eva', reversed: false }, { edgeId: 't', reversed: false }, { edgeId: 'evb', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  const flows = classifyFlows(layout, cs);
  const tCorr = cs.byEdge.get('t')!;
  const flats = new Map<number, string[]>([[tCorr.id, ['u', 'v']]]);
  const moves = placeResiduals(flats, cs, flows);
  assert.equal(moves, 0);
  assert.deepEqual(flats.get(tCorr.id), ['u', 'v']);
});
