import { test } from 'node:test';
import assert from 'node:assert';
import { buildChainRails } from '../chainRails';
import { detectChains, type ChainEdgeRef } from '../chains';
import type { Pixel } from '../layout/types';

const SP = 6;

// C1's two-interior corridor: a(60) B m1(10) C m2(8) D b(60), branch at C.
const EDGES: ChainEdgeRef[] = [
  { id: 'a', from: 'A', to: 'B' },
  { id: 'm1', from: 'B', to: 'C' },
  { id: 'm2', from: 'C', to: 'D' },
  { id: 'b', from: 'D', to: 'E' },
  { id: 'br', from: 'C', to: 'X' },
];
const BASES: Record<string, Pixel[]> = {
  a: [[0, 0], [60, 0]],
  m1: [[60, 0], [70, 0]],
  m2: [[70, 0], [78, 0]],
  b: [[78, 0], [138, 0]],
  br: [[70, 0], [70, 40]],
};

// entry frame (edge a): l1 -6, l2 0, l3 +6, bl -12; exit frame (edge b)
// shifted +2 for every line: the chain must carry each line from its
// entry seat to its exit seat.
const OFFSETS: Record<string, Record<string, number>> = {
  a: { l1: -6, l2: 0, l3: 6, bl: -12 },
  b: { l1: -4, l2: 2, l3: 8 },
  m1: { l1: -6, l2: 0, l3: 6, bl: -12 },
  m2: { l1: -6, l2: 0, l3: 6 },
  br: { bl: 0 },
};

function offsetLane(base: Pixel[], o: number): Pixel[] {
  const [p, q] = [base[0], base[base.length - 1]];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const nx = -(q[1] - p[1]) / len;
  const ny = (q[0] - p[0]) / len;
  return base.map((v): Pixel => [v[0] + nx * o, v[1] + ny * o]);
}

function setup() {
  const segPath = new Map<string, Pixel[]>();
  for (const [edgeId, byLine] of Object.entries(OFFSETS)) {
    for (const [lineId, o] of Object.entries(byLine)) {
      segPath.set(edgeId + '|' + lineId, offsetLane(BASES[edgeId], o));
    }
  }
  const chains = detectChains({
    edges: EDGES,
    basePoly: (id) => BASES[id],
    laneCount: (id) => Object.keys(OFFSETS[id] ?? {}).length,
    spacing: SP,
  });
  const args = {
    chains,
    edgeById: new Map(EDGES.map((e) => [e.id, e])),
    basePoly: (id: string) => BASES[id],
    laneOffsetOf: (edgeId: string, lineId: string) => OFFSETS[edgeId]?.[lineId],
    lineTraversals: new Map([
      ['l1', [{ edgeId: 'a', reversed: false }, { edgeId: 'm1', reversed: false }, { edgeId: 'm2', reversed: false }, { edgeId: 'b', reversed: false }]],
      ['l2', [{ edgeId: 'a', reversed: false }, { edgeId: 'm1', reversed: false }, { edgeId: 'm2', reversed: false }, { edgeId: 'b', reversed: false }]],
      ['l3', [{ edgeId: 'a', reversed: false }, { edgeId: 'm1', reversed: false }, { edgeId: 'm2', reversed: false }, { edgeId: 'b', reversed: false }]],
      ['bl', [{ edgeId: 'a', reversed: false }, { edgeId: 'm1', reversed: false }, { edgeId: 'br', reversed: false }]],
    ]),
    segPath,
    suppressed: new Set<string>(),
    spacing: SP,
  };
  return { segPath, chains, args };
}

test('rails: entry and exit ends sit exactly on the bounding frames', () => {
  const { segPath, args } = setup();
  const n = buildChainRails(args);
  assert.ok(n >= 3, 'rails built: ' + n);
  const m1l1 = segPath.get('m1|l1')!;
  const m2l1 = segPath.get('m2|l1')!;
  assert.ok(Math.abs(m1l1[0][1] - -6) < 0.05, 'entry seat at B: ' + m1l1[0][1]);
  assert.ok(Math.abs(m2l1[m2l1.length - 1][1] - -4) < 0.05, 'exit seat at D: ' + m2l1[m2l1.length - 1][1]);
});

test('rails: pass-through pitch is preserved along the whole interior', () => {
  const { segPath, args } = setup();
  buildChainRails(args);
  for (const edge of ['m1', 'm2']) {
    const r1 = segPath.get(edge + '|l1')!;
    const r2 = segPath.get(edge + '|l2')!;
    assert.equal(r1.length, r2.length, 'same vertex count on ' + edge);
    for (let i = 0; i < r1.length; i++) {
      const d = Math.hypot(r2[i][0] - r1[i][0], r2[i][1] - r1[i][1]);
      assert.ok(Math.abs(d - SP) < 0.25, 'pitch at ' + edge + '[' + i + ']: ' + d);
    }
  }
});

test('rails: a branch line without a collinear exit frame rides its entry seat to the turn', () => {
  const { segPath, args } = setup();
  buildChainRails(args);
  const rail = segPath.get('m1|bl')!;
  for (const p of rail) {
    assert.ok(Math.abs(p[1] - -12) < 0.05, 'constant entry seat: ' + p[1]);
  }
});

test('rails: anchor lanes are untouched', () => {
  const { segPath, args } = setup();
  const beforeA = JSON.stringify(segPath.get('a|l1'));
  const beforeB = JSON.stringify(segPath.get('b|l3'));
  buildChainRails(args);
  assert.equal(JSON.stringify(segPath.get('a|l1')), beforeA);
  assert.equal(JSON.stringify(segPath.get('b|l3')), beforeB);
});
