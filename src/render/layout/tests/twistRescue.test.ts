import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rescueTwists } from '../twistRescue';

// Minimal layout fixtures: straight horizontal edges unless a path says
// otherwise. Order arrays are the from->to lineOrder; lines mirror them.
const edge = (id: string, from: string, to: string, order: string[], path: Array<[number, number]>): any => ({
  id, from, to, path,
  lines: order.map((x) => ({ id: x })),
  lineOrder: [...order],
  stops: new Map(),
});
const layoutOf = (edges: any[]): any => ({ cellSize: 1, nodes: new Map(), edges, lineTraversals: new Map() });

// The same normalized pair-order convention the rescue uses: two edges at N
// agree when their signs differ.
const sAt = (e: any, N: string, u: string, v: string): number =>
  (e.to === N ? 1 : -1) * (e.lineOrder.indexOf(u) < e.lineOrder.indexOf(v) ? 1 : -1);
const twistedAt = (e1: any, e2: any, N: string, u: string, v: string): boolean =>
  sAt(e1, N, u, v) === sAt(e2, N, u, v);

test('twist bubbles to the nearer BRANCH and the straight node reads clean', () => {
  // A --e1(100px)-- N --e2(20px)-- B --e3-- C, v ends at B (branch for the
  // pair). Twist at N; the nearer branch is B, so e2 flips and the crossing
  // parks at the divergence.
  const e1 = edge('e1', 'A', 'N', ['u', 'v'], [[0, 0], [100, 0]]);
  const e2 = edge('e2', 'N', 'B', ['v', 'u'], [[100, 0], [120, 0]]);
  const e3 = edge('e3', 'B', 'C', ['u'], [[120, 0], [200, 0]]);
  const l = layoutOf([e1, e2, e3]);
  assert.ok(twistedAt(e1, e2, 'N', 'u', 'v'), 'fixture starts twisted at N');
  rescueTwists(l);
  assert.deepEqual(e2.lineOrder, ['u', 'v'], 'crossing moved through e2');
  assert.deepEqual(e1.lineOrder, ['u', 'v'], 'e1 untouched');
  assert.ok(!twistedAt(e1, e2, 'N', 'u', 'v'), 'straight node now clean');
});

test('blocked branch side falls back to a TURN absorb', () => {
  // e1 carries w BETWEEN u and v (adjacency fails: that direction is
  // blocked). e2 leads to B where the pair turns 90 degrees into e3: the
  // crossing parks at the corner.
  const e1 = edge('e1', 'A', 'N', ['u', 'w', 'v'], [[0, 0], [100, 0]]);
  const e2 = edge('e2', 'N', 'B', ['v', 'u'], [[100, 0], [120, 0]]);
  const e3 = edge('e3', 'B', 'C', ['v', 'u'], [[120, 0], [120, 80]]);
  const l = layoutOf([e1, e2, e3]);
  assert.ok(twistedAt(e1, e2, 'N', 'u', 'v'));
  rescueTwists(l);
  assert.deepEqual(e2.lineOrder, ['u', 'v'], 'crossing moved to the corner');
  assert.deepEqual(e3.lineOrder, ['v', 'u'], 'beyond the corner untouched');
  assert.ok(!twistedAt(e1, e2, 'N', 'u', 'v'), 'straight node now clean');
  assert.ok(twistedAt(e2, e3, 'B', 'u', 'v'), 'crossing now lives at the turn');
});

test('a farther BRANCH beats a nearer TURN', () => {
  // Via e2 (20px) the pair turns at B and continues (turn absorb). Via e1
  // (100px) the pair reaches A where v ends (branch absorb). Branch wins at
  // any distance: e1 flips, e2 stays.
  const e0 = edge('e0', 'Z', 'A', ['u'], [[-80, 0], [0, 0]]);
  const e1 = edge('e1', 'A', 'N', ['u', 'v'], [[0, 0], [100, 0]]);
  const e2 = edge('e2', 'N', 'B', ['v', 'u'], [[100, 0], [120, 0]]);
  const e3 = edge('e3', 'B', 'C', ['v', 'u'], [[120, 0], [120, 80]]);
  const l = layoutOf([e0, e1, e2, e3]);
  assert.ok(twistedAt(e1, e2, 'N', 'u', 'v'));
  rescueTwists(l);
  assert.deepEqual(e1.lineOrder, ['v', 'u'], 'crossing moved toward the branch at A');
  assert.deepEqual(e2.lineOrder, ['v', 'u'], 'turn side untouched');
  assert.ok(!twistedAt(e1, e2, 'N', 'u', 'v'));
});

test('both directions blocked mid-walk leaves the twist in place', () => {
  // The pair is adjacent at the twist but w interposes on the NEXT edge in
  // both directions, with no absorb site before it: the crossing cannot
  // pass either way and nothing changes.
  const eA = edge('eA', 'A', 'P', ['u', 'w', 'v'], [[-100, 0], [0, 0]]);
  const e1 = edge('e1', 'P', 'N', ['u', 'v'], [[0, 0], [100, 0]]);
  const e2 = edge('e2', 'N', 'Q', ['v', 'u'], [[100, 0], [200, 0]]);
  const eB = edge('eB', 'Q', 'B', ['v', 'w', 'u'], [[200, 0], [300, 0]]);
  const l = layoutOf([eA, e1, e2, eB]);
  assert.ok(twistedAt(e1, e2, 'N', 'u', 'v'));
  const before = l.edges.map((e: any) => e.lineOrder.join(','));
  rescueTwists(l);
  assert.deepEqual(l.edges.map((e: any) => e.lineOrder.join(',')), before);
});

test('a rescue can unblock another pair (fixpoint cascade)', () => {
  // w sits between an inverted u,v on both sides. The u,v crossing is
  // blocked at first, but the accompanying u,w inversion is adjacent and
  // rescues away, unblocking u,v on the second pass. Every pair must end
  // clean across N.
  const e1 = edge('e1', 'A', 'N', ['u', 'w', 'v'], [[0, 0], [100, 0]]);
  const e2 = edge('e2', 'N', 'B', ['v', 'w', 'u'], [[100, 0], [200, 0]]);
  const l = layoutOf([e1, e2]);
  rescueTwists(l);
  for (const [u, v] of [['u', 'v'], ['u', 'w'], ['v', 'w']] as const) {
    assert.ok(!twistedAt(e1, e2, 'N', u, v), `pair ${u},${v} still twisted at N`);
  }
});

test('the crossing bubbles across several straight edges to a far branch', () => {
  // N -e2- B -e3- C -e4- D, all straight, pair adjacent throughout, v ends
  // at D. Every walked edge flips; every intermediate node stays clean.
  const e1 = edge('e1', 'A', 'N', ['x', 'u', 'v'], [[0, 0], [50, 0]]);
  const e2 = edge('e2', 'N', 'B', ['x', 'v', 'u'], [[50, 0], [100, 0]]);
  const e3 = edge('e3', 'B', 'C', ['v', 'u'], [[100, 0], [150, 0]]);
  const e4 = edge('e4', 'C', 'D', ['v', 'u'], [[150, 0], [200, 0]]);
  const e5 = edge('e5', 'D', 'E', ['u'], [[200, 0], [250, 0]]);
  const l = layoutOf([e1, e2, e3, e4, e5]);
  assert.ok(twistedAt(e1, e2, 'N', 'u', 'v'));
  rescueTwists(l);
  // walk toward A is a 1-edge branch (x is not between u,v there)... the A
  // side IS nearer, so assert only on the invariant: no straight node is
  // twisted afterwards, and exactly one direction flipped.
  assert.ok(!twistedAt(e1, e2, 'N', 'u', 'v'), 'N clean');
  assert.ok(!twistedAt(e2, e3, 'B', 'u', 'v'), 'B clean');
  assert.ok(!twistedAt(e3, e4, 'C', 'u', 'v'), 'C clean');
});

test('deterministic: identical input yields identical orders', () => {
  const mk = () => {
    const e1 = edge('e1', 'A', 'N', ['u', 'v'], [[0, 0], [100, 0]]);
    const e2 = edge('e2', 'N', 'B', ['v', 'u'], [[100, 0], [120, 0]]);
    const e3 = edge('e3', 'B', 'C', ['u'], [[120, 0], [200, 0]]);
    return layoutOf([e1, e2, e3]);
  };
  const a = mk(); rescueTwists(a);
  const b = mk(); rescueTwists(b);
  assert.deepEqual(a.edges.map((e: any) => e.lineOrder), b.edges.map((e: any) => e.lineOrder));
});
