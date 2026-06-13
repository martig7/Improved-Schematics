import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredOrdersAtNode, type IncidentEdge } from './nodePlanar';

// Helpers: an incident edge is described by its id, whether the node is its
// `from` end, the exit direction at the node, and its line ids.
const inc = (id: string, nodeIsFrom: boolean, dir: [number, number], lines: string[]): IncidentEdge => ({
  id, nodeIsFrom, dir, lines,
});

test('nodePlanar: Y split — trunk order matches the branch fan (no crossing)', () => {
  // Trunk t enters from the west (exit dir west): node is t.to, trunk carries
  // A,B. Branch p leaves NE carrying A; branch q leaves SE carrying B.
  // Planar order on the trunk (read in its from->to frame) is [A,B] because A's
  // destination (NE, -lateral side) precedes B's (SE, +lateral side).
  const edges: IncidentEdge[] = [
    inc('t', false, [-1, 0], ['A', 'B']), // node is t.to; trunk exits west
    inc('p', true, [1, -1], ['A']),        // branch exits NE
    inc('q', true, [1, 1], ['B']),         // branch exits SE
  ];
  const lineEdges = new Map<string, [string, string | null]>([
    ['A', ['t', 'p']],
    ['B', ['t', 'q']],
  ]);
  const res = desiredOrdersAtNode(edges, lineEdges);
  assert.equal(res.planar, true);
  assert.deepEqual(res.orderAtNode.get('t'), ['A', 'B']);
});

test('nodePlanar: 3-arm fan keeps co-traveling lines contiguous', () => {
  // Edge h enters carrying [X, P, Q]; P,Q both continue together on edge g (NE),
  // X branches to edge f (SE). Planar order on h keeps {P,Q} as one block.
  const edges: IncidentEdge[] = [
    inc('h', false, [-1, 0], ['X', 'P', 'Q']),
    inc('g', true, [1, -1], ['P', 'Q']),
    inc('f', true, [1, 1], ['X']),
  ];
  const lineEdges = new Map<string, [string, string | null]>([
    ['X', ['h', 'f']],
    ['P', ['h', 'g']],
    ['Q', ['h', 'g']],
  ]);
  const res = desiredOrdersAtNode(edges, lineEdges);
  assert.equal(res.planar, true);
  const h = res.orderAtNode.get('h')!;
  const pi = h.indexOf('P'), qi = h.indexOf('Q'), xi = h.indexOf('X');
  assert.equal(Math.abs(pi - qi), 1, 'P and Q stay adjacent');
  assert.ok((xi < pi && xi < qi) || (xi > pi && xi > qi), 'X is outside the {P,Q} block');
});

test('nodePlanar: genuine X-crossing (W->E over N->S) is flagged non-planar', () => {
  // Two straight lines crossing at a 4-way: U goes west<->east, V north<->south.
  // Their chords interleave on the node cycle — a real, unavoidable crossing.
  const edges: IncidentEdge[] = [
    inc('w', false, [-1, 0], ['U']),
    inc('e', true, [1, 0], ['U']),
    inc('n', false, [0, -1], ['V']),
    inc('s', true, [0, 1], ['V']),
  ];
  const lineEdges = new Map<string, [string, string | null]>([
    ['U', ['w', 'e']],
    ['V', ['n', 's']],
  ]);
  const res = desiredOrdersAtNode(edges, lineEdges);
  assert.equal(res.planar, false);
});
