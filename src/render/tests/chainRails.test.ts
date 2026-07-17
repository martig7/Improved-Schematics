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

// entry frame (edge a): l1 -6, l2 0, l3 +6, bl -12, and l4 at -8 (a
// foreign-feeder seat NOT at pitch with its neighbours); exit frame
// (edge b) shifted +2 for every through line: the chain must carry each
// line from its entry seat to its exit seat, and the shared ladder must
// hold every pair at pitch through the middle.
const OFFSETS: Record<string, Record<string, number>> = {
  a: { l1: -6, l2: 0, l3: 6, bl: -12, l4: -8 },
  b: { l1: -4, l2: 2, l3: 8, l4: -10 },
  m1: { l1: -6, l2: 0, l3: 6, bl: -12, l4: -8 },
  m2: { l1: -6, l2: 0, l3: 6, l4: -8 },
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
      ['l4', [{ edgeId: 'a', reversed: false }, { edgeId: 'm1', reversed: false }, { edgeId: 'm2', reversed: false }, { edgeId: 'b', reversed: false }]],
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

test('rails: a branch line keeps anchor continuity and takes its ladder seat by the turn', () => {
  // bl has no collinear exit frame: it enters on its anchor seat and its
  // departure end takes the shared ladder's seat, moving AWAY from the
  // pack (the ladder orders it outermost), never into it.
  const { segPath, args } = setup();
  buildChainRails(args);
  const rail = segPath.get('m1|bl')!;
  assert.ok(Math.abs(rail[0][1] - -12) < 0.05, 'anchor continuity at entry: ' + rail[0][1]);
  assert.ok(rail[rail.length - 1][1] <= -12 + 0.05, 'departure seat not into the pack: ' + rail[rail.length - 1][1]);
});

test('rails: the shared ladder holds every pair at pitch through the middle', () => {
  // l4 enters 2px from l1 (a foreign frame); mid-chain the ladder must
  // separate every pair to at least one pitch.
  const { segPath, args } = setup();
  buildChainRails(args);
  const midOf = (lineId: string): Pixel => {
    const r = segPath.get('m1|' + lineId)!;
    return r[r.length - 1]; // the m1/m2 joint sits mid-chain
  };
  const lines = ['bl', 'l4', 'l1', 'l2', 'l3'];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = midOf(lines[i]);
      const b = midOf(lines[j]);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      assert.ok(d >= SP - 0.25, 'pitch ' + lines[i] + '/' + lines[j] + ': ' + d);
    }
  }
});

test('rails: a reversed traversal seats identically to its forward twin', () => {
  // l5 rides the same corridor as l1 but traverses it BACKWARD; its lane
  // offsets are mirrored (same world geometry). The rail must land on the
  // same world seats as l1's, one pitch away from l2 everywhere.
  const { segPath, args } = setup();
  const revStep = (edgeId: string): { edgeId: string; reversed: boolean } => ({ edgeId, reversed: true });
  (args.lineTraversals as Map<string, Array<{ edgeId: string; reversed: boolean }>>).set(
    'l5', [revStep('b'), revStep('m2'), revStep('m1'), revStep('a')]);
  // world seat -18 everywhere: edge-frame offset -18 forward = +18 in the
  // reversed travel frame; laneOffsetOf stays edge-frame
  const OFF = { a: -18, m1: -18, m2: -18, b: -20 };
  const orig = args.laneOffsetOf;
  args.laneOffsetOf = (edgeId: string, lineId: string) =>
    lineId === 'l5' ? (OFF as Record<string, number>)[edgeId] : orig(edgeId, lineId);
  for (const [e, o] of Object.entries(OFF)) {
    segPath.set(e + '|l5', offsetLane(BASES[e], o));
  }
  buildChainRails(args);
  const m1l5 = segPath.get('m1|l5')!;
  const m2l5 = segPath.get('m2|l5')!;
  // lanes stored in edge from->to orientation regardless of travel
  assert.ok(Math.abs(m1l5[0][1] - -18) < 0.05, 'entry-side seat at B: ' + m1l5[0][1]);
  assert.ok(Math.abs(m2l5[m2l5.length - 1][1] - -20) < 0.05, 'exit-side seat at D: ' + m2l5[m2l5.length - 1][1]);
  // never crosses bl (world seat around -12..-17): l5 must stay below
  for (const p of [...m1l5, ...m2l5]) {
    assert.ok(p[1] <= -17.5, 'stays outermost: ' + p[1]);
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
