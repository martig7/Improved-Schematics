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

test('untangle: partner lines stay adjacent as a block', () => {
  // P1+P2 ride the identical edge set (partners); X crosses the trunk and
  // must never be ordered between them.
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['P1', 'X', 'P2'], order: ['P1', 'X', 'P2'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['P1', 'P2'], order: ['P1', 'P2'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['X'] },
    ],
    {
      P1: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      P2: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      X: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  untangleLineOrder(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  const i1 = t.lineOrder.indexOf('P1');
  const i2 = t.lineOrder.indexOf('P2');
  assert.equal(Math.abs(i1 - i2), 1, `partners adjacent on the trunk (got ${t.lineOrder})`);
  assert.equal(t.lineOrder.length, 3, 'all lines present after block expansion');
});

test('cornerTurnFactor: straight LOCKED, 45deg half, 90deg+ nearly free', async () => {
  const { cornerTurnFactor, xCornerTurnFactor } = await import('./untangle');
  assert.equal(cornerTurnFactor(-1), 2.5e5); // straight through: LOCKED (lexicographic)
  assert.equal(cornerTurnFactor(-0.71), 0.5); // 45 degree bend
  assert.equal(cornerTurnFactor(0), 0.15); // 90 degree corner
  assert.equal(cornerTurnFactor(0.7), 0.15); // 135 degree hook
  // U-shaped variant: BOTH near-collinear ends lock (straight braid + hairpin
  // braid); the 90deg valley keeps its ordinary price
  assert.equal(xCornerTurnFactor(-1), 2.5e5);
  assert.equal(xCornerTurnFactor(1), 2.5e5);
  assert.ok(xCornerTurnFactor(0) < 1, `90deg stays cheap: ${xCornerTurnFactor(0)}`);
});

test('cornerTurnFactor: OCTI_STRAIGHT_LOCK=0 restores the soft 6x tiers', async () => {
  const { cornerTurnFactor, xCornerTurnFactor } = await import('./untangle');
  const prev = process.env.OCTI_STRAIGHT_LOCK;
  process.env.OCTI_STRAIGHT_LOCK = '0';
  try {
    assert.equal(cornerTurnFactor(-1), 6); // legacy soft tier
    assert.equal(xCornerTurnFactor(-1), 6); // U-shape peak (xAngleK default 6)
    assert.equal(xCornerTurnFactor(1), 6);
  } finally {
    if (prev === undefined) delete process.env.OCTI_STRAIGHT_LOCK;
    else process.env.OCTI_STRAIGHT_LOCK = prev;
  }
});

test('straight-lock: a pinned crossing migrates to the bend, never the straight run', () => {
  // Corridor r -> m -> n carrying {A,B}: r->m->n runs straight east, then
  // BENDS 90 degrees at n toward s. Branch tips at m's north/south force
  // nothing; the order is pinned at r as [A,B] (by branch fan at r... instead
  // we pin by construction: give the two ends conflicting preferred orders
  // via single-line branches). Setup:
  //   ra (north) feeds A, rb (south) feeds B into r  -> trunk wants [A,B] at r
  //   past the bend at n, sa (south) takes A, sb (north) takes B -> the swap
  //   MUST happen somewhere between r and s.
  // With the straight-lock, the flip may not sit at m (straight deg-2 node,
  // line sets differ so m stays an opt boundary via the branch stub) — it
  // must land at n, the 90-degree bend.
  const layout = makeLayout(
    [
      ['ra', -10, -10], ['rb', -10, 10], ['r', 0, 0],
      ['m', 20, 0], ['mstub', 20, -10],
      ['n', 40, 0],
      ['sa', 50, 10], ['sb', 30, 20], // south leg after the bend: n -> (40,20)ish
      ['s', 40, 20],
    ],
    [
      { id: 'ea', from: 'ra', to: 'r', lines: ['A'] },
      { id: 'eb', from: 'rb', to: 'r', lines: ['B'] },
      { id: 't1', from: 'r', to: 'm', lines: ['A', 'B'] },
      { id: 'stub', from: 'm', to: 'mstub', lines: ['S'] }, // breaks t1/t2 contraction at m
      { id: 't2', from: 'm', to: 'n', lines: ['A', 'B'] },
      { id: 't3', from: 'n', to: 's', lines: ['A', 'B'] }, // 90-degree bend at n
      { id: 'fa', from: 's', to: 'sa', lines: ['A'] },
      { id: 'fb', from: 's', to: 'sb', lines: ['B'] },
    ],
    {
      A: [
        { edgeId: 'ea', reversed: false }, { edgeId: 't1', reversed: false },
        { edgeId: 't2', reversed: false }, { edgeId: 't3', reversed: false },
        { edgeId: 'fa', reversed: false },
      ],
      B: [
        { edgeId: 'eb', reversed: false }, { edgeId: 't1', reversed: false },
        { edgeId: 't2', reversed: false }, { edgeId: 't3', reversed: false },
        { edgeId: 'fb', reversed: false },
      ],
      S: [{ edgeId: 'stub', reversed: false }],
    },
  );
  untangleLineOrder(layout);
  const t1 = layout.edges.find((e) => e.id === 't1')!;
  const t2 = layout.edges.find((e) => e.id === 't2')!;
  // the straight m boundary must NOT flip the pair: t1 and t2 agree
  assert.deepEqual(t1.lineOrder, t2.lineOrder,
    `no reorder across the straight node m (t1=${t1.lineOrder} t2=${t2.lineOrder})`);
});

test('untangle: Y rewrite locks the trunk side by branch geometry', () => {
  const mk = (flip: boolean) => makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, flip ? 10 : -10], ['qe', 30, flip ? -10 : 10]],
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
  const a = mk(false);
  untangleLineOrder(a);
  const b = mk(true);
  untangleLineOrder(b);
  const ta = a.edges.find((e) => e.id === 't')!.lineOrder;
  const tb = b.edges.find((e) => e.id === 't')!.lineOrder;
  assert.deepEqual([...ta].sort(), ['A', 'B']);
  assert.notDeepEqual(ta, tb, 'mirrored branch geometry flips the trunk side');
});

test('seam scoring: composed stack order governs the un-stacked continuation', () => {
  // Trunk r->n->m carrying {A,B,C,D}; a stub at n breaks contraction so
  // r->n (t1) and n->m (t2) are separate opt edges; at m the lines partition
  // into branches {A,B} and {C,D} -> tryY stacks t2 into two siblings. Colors
  // are chosen ADVERSARIALLY: A/C share one color and B/D another, so
  // colorFrag prefers the interleaved t1 order [A,C,B,D] (one boundary) over
  // the seam-consistent grouped order (three boundaries). Without seam
  // scoring the optimizer takes the frag-optimal order and writes a silent
  // cross-sibling braid at n (the Franklin Av class); WITH seam scoring the
  // straight-lock prices that braid lexicographically and the continuation
  // must match the composed sibling order.
  const mkSeam = () => {
    const layout = makeLayout(
      [['r', 0, 0], ['n', 20, 0], ['s', 20, 10], ['m', 40, 0], ['pe', 50, -10], ['qe', 50, 10]],
      [
        { id: 't1', from: 'r', to: 'n', lines: ['A', 'B', 'C', 'D'], order: ['A', 'C', 'B', 'D'] },
        { id: 'stub', from: 'n', to: 's', lines: ['S'] },
        { id: 't2', from: 'n', to: 'm', lines: ['A', 'B', 'C', 'D'], order: ['A', 'C', 'B', 'D'] },
        { id: 'bp', from: 'm', to: 'pe', lines: ['A', 'B'] },
        { id: 'bq', from: 'm', to: 'qe', lines: ['C', 'D'] },
      ],
      {
        A: [{ edgeId: 't1', reversed: false }, { edgeId: 't2', reversed: false }, { edgeId: 'bp', reversed: false }],
        B: [{ edgeId: 't1', reversed: false }, { edgeId: 't2', reversed: false }, { edgeId: 'bp', reversed: false }],
        C: [{ edgeId: 't1', reversed: false }, { edgeId: 't2', reversed: false }, { edgeId: 'bq', reversed: false }],
        D: [{ edgeId: 't1', reversed: false }, { edgeId: 't2', reversed: false }, { edgeId: 'bq', reversed: false }],
        S: [{ edgeId: 'stub', reversed: false }],
      },
    );
    // adversarial colors: frag pressure wants A/C adjacent and B/D adjacent
    for (const e of layout.edges) {
      for (const l of e.lines) {
        l.color = l.id === 'A' || l.id === 'C' ? '#e00' : l.id === 'B' || l.id === 'D' ? '#0a0' : '#888';
      }
    }
    return layout;
  };
  const layout = mkSeam();
  untangleLineOrder(layout);
  const t1 = layout.edges.find((e) => e.id === 't1')!;
  const t2 = layout.edges.find((e) => e.id === 't2')!;
  // continuity at n (t1 arrives, t2 leaves; same canonical direction): the
  // un-stacked continuation must equal t2's COMPOSED written-back order —
  // zero cross-sibling flips at the straight seam
  assert.deepEqual(t1.lineOrder, t2.lineOrder,
    `seam-consistent orders at n (t1=${t1.lineOrder} t2=${t2.lineOrder})`);
  // and the branch partition really is a stack: {A,B} contiguous, {C,D} contiguous
  const pos = new Map(t2.lineOrder.map((l, i) => [l, i]));
  assert.equal(Math.abs(pos.get('A')! - pos.get('B')!), 1, 'A/B contiguous in the composed order');
  assert.equal(Math.abs(pos.get('C')! - pos.get('D')!), 1, 'C/D contiguous in the composed order');
});
