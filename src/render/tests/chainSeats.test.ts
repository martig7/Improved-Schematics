import { test } from 'node:test';
import assert from 'node:assert';
import { computeChainSeats } from '../chainSeats';
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
const OFFSETS: Record<string, Record<string, number>> = {
  a: { l1: -6, l2: 0, l3: 6, bl: -12, l4: -8 },
  b: { l1: -4, l2: 2, l3: 8, l4: -10 },
  m1: { l1: -6, l2: 0, l3: 6, bl: -12, l4: -8 },
  m2: { l1: -6, l2: 0, l3: 6, l4: -8 },
  br: { bl: 0 },
};

function setup(travOverride?: Map<string, Array<{ edgeId: string; reversed: boolean }>>) {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  const chains = detectChains({
    edges: EDGES,
    basePoly: (id) => BASES[id],
    laneCount: (id) => Object.keys(OFFSETS[id] ?? {}).length,
    spacing: SP,
  });
  return computeChainSeats({
    chains,
    edgeById: new Map(EDGES.map((e) => [e.id, e])),
    basePoly: (id) => BASES[id],
    laneOffsetOf: (edgeId, lineId) => OFFSETS[edgeId]?.[lineId],
    lineTraversals: travOverride ?? new Map([
      ['l1', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
      ['l2', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
      ['l3', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
      ['bl', [fwd('a'), fwd('m1'), { edgeId: 'br', reversed: false }]],
      ['l4', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
    ]),
    spacing: SP,
  }).seats;
}

test('seats: every interior pair sits at pitch or more (cross-feeder included)', () => {
  const seats = setup();
  const lines = ['bl', 'l4', 'l1', 'l2', 'l3'];
  const m1 = lines.map((l) => seats.get('m1|' + l));
  for (const s of m1) assert.ok(s !== undefined, 'seat assigned on m1');
  const sorted = [...(m1 as number[])].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= SP - 1e-6, 'pitch: ' + (sorted[i] - sorted[i - 1]));
  }
});

test('seats: interior edges of one line share the ladder frame (no interior seams)', () => {
  const seats = setup();
  for (const l of ['l1', 'l2', 'l3', 'l4']) {
    assert.equal(seats.get('m1|' + l), seats.get('m2|' + l), 'same seat across interior edges for ' + l);
  }
});

test('seats: anchors and unframed lanes are not assigned', () => {
  const seats = setup();
  assert.equal(seats.get('a|l1'), undefined);
  assert.equal(seats.get('b|l1'), undefined);
  assert.equal(seats.get('br|bl'), undefined);
});

test('seats: a round-trip line occupies ONE ladder slot (no directional duplicates)', () => {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  const rev = (edgeId: string) => ({ edgeId, reversed: true });
  const oneWay = setup();
  const roundTrip = setup(new Map([
    ['l1', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b'), rev('b'), rev('m2'), rev('m1'), rev('a')]],
    ['l2', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b'), rev('b'), rev('m2'), rev('m1'), rev('a')]],
    ['l3', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b'), rev('b'), rev('m2'), rev('m1'), rev('a')]],
    ['bl', [fwd('a'), fwd('m1'), fwd('br'), rev('br'), rev('m1'), rev('a')]],
    ['l4', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b'), rev('b'), rev('m2'), rev('m1'), rev('a')]],
  ]));
  for (const key of ['m1|l1', 'm1|l2', 'm1|l3', 'm1|bl', 'm1|l4', 'm2|l1', 'm2|l4']) {
    assert.ok(Math.abs((oneWay.get(key) ?? NaN) - (roundTrip.get(key) ?? NaN)) < 1e-9,
      key + ': ' + oneWay.get(key) + ' vs ' + roundTrip.get(key));
  }
});

test('seats: runs on disjoint interior spans ladder independently', () => {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  const chains = detectChains({
    edges: EDGES,
    basePoly: (id) => BASES[id],
    laneCount: (id) => Object.keys(OFFSETS[id] ?? {}).length,
    spacing: SP,
  });
  // x occupies only m1, y occupies only m2: they never share an edge, so
  // neither may consume a slot in the other's ladder.
  const seats = computeChainSeats({
    chains,
    edgeById: new Map(EDGES.map((e) => [e.id, e])),
    basePoly: (id) => BASES[id],
    laneOffsetOf: (edgeId, lineId) =>
      lineId === 'x' ? (edgeId === 'a' || edgeId === 'm1' ? 0 : undefined)
        : lineId === 'y' ? (edgeId === 'm2' || edgeId === 'b' ? 0 : undefined)
          : undefined,
    lineTraversals: new Map([
      ['x', [fwd('a'), fwd('m1')]],
      ['y', [fwd('m2'), fwd('b')]],
    ]),
    spacing: SP,
  }).seats;
  assert.ok(Math.abs((seats.get('m1|x') ?? NaN) - 0) < 1e-9, 'x keeps its desired seat: ' + seats.get('m1|x'));
  assert.ok(Math.abs((seats.get('m2|y') ?? NaN) - 0) < 1e-9, 'y keeps its desired seat: ' + seats.get('m2|y'));
});

test('seats: a component with an unseated cohabitant lane does not seat', () => {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  const chains = detectChains({
    edges: EDGES,
    basePoly: (id) => BASES[id],
    laneCount: (id) => Object.keys(OFFSETS[id] ?? {}).length,
    spacing: SP,
  });
  // u holds lanes on the interior but earns no frame bound (its whole
  // traversal is interior), so it stays on slot+bias; re-seating x around
  // an unmoved cohabitant would land them sub-pitch.
  const seats = computeChainSeats({
    chains,
    edgeById: new Map(EDGES.map((e) => [e.id, e])),
    basePoly: (id) => BASES[id],
    laneOffsetOf: (edgeId, lineId) =>
      lineId === 'x' ? ({ a: -3, m1: -3, m2: -3, b: -3 } as Record<string, number>)[edgeId]
        : lineId === 'u' ? (edgeId === 'm1' || edgeId === 'm2' ? 3 : undefined)
          : undefined,
    lineTraversals: new Map([
      ['x', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
      ['u', [fwd('m1'), fwd('m2')]],
    ]),
    spacing: SP,
  }).seats;
  assert.equal(seats.get('m1|x'), undefined, 'x not seated beside unmoved u');
  assert.equal(seats.get('m2|x'), undefined, 'x not seated beside unmoved u');
});

test('seats: two overlapping parallel chains merge into one pitched ladder', () => {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  // Two sub-clearance parallel corridors 4px apart, one single-lane chain
  // each. Seated independently their lanes ride 4px apart; the merged
  // ladder must put them at pitch.
  const edges: ChainEdgeRef[] = [
    { id: 'a1', from: 'A1', to: 'B1' }, { id: 'm1', from: 'B1', to: 'C1' }, { id: 'b1', from: 'C1', to: 'D1' },
    { id: 'a2', from: 'A2', to: 'B2' }, { id: 'm2', from: 'B2', to: 'C2' }, { id: 'b2', from: 'C2', to: 'D2' },
  ];
  const bases: Record<string, Pixel[]> = {
    a1: [[0, 0], [60, 0]], m1: [[60, 0], [120, 0]], b1: [[120, 0], [180, 0]],
    a2: [[0, 4], [60, 4]], m2: [[60, 4], [120, 4]], b2: [[120, 4], [180, 4]],
  };
  const chains = [
    { edgeIds: ['m1'], anchorA: 'a1', anchorB: 'b1', arc: 60, interiorNodes: [] },
    { edgeIds: ['m2'], anchorA: 'a2', anchorB: 'b2', arc: 60, interiorNodes: [] },
  ];
  const seats = computeChainSeats({
    chains,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    basePoly: (id) => bases[id],
    laneOffsetOf: (edgeId, lineId) =>
      lineId === 'p' ? (edgeId.endsWith('1') ? 0 : undefined)
        : lineId === 'q' ? (edgeId.endsWith('2') ? 0 : undefined)
          : undefined,
    lineTraversals: new Map([
      ['p', [fwd('a1'), fwd('m1'), fwd('b1')]],
      ['q', [fwd('a2'), fwd('m2'), fwd('b2')]],
    ]),
    spacing: SP,
    halfWidthOf: () => 0,
  }).seats;
  const sp = seats.get('m1|p');
  const sq = seats.get('m2|q');
  assert.ok(sp !== undefined && sq !== undefined, 'both seated: ' + sp + ', ' + sq);
  const gap = Math.abs((0 + sp!) - (4 + sq!));
  assert.ok(Math.abs(gap - SP) < 1e-6, 'physical gap at pitch: ' + gap);
});

test('seats: a chain beside a sub-clearance parallel NON-chain edge does not seat', () => {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  // Same two parallel corridors, but corridor 2 is NOT a chain: its lane
  // stays on slot+bias, so seating corridor 1's ladder beside that
  // unmoved ink risks sub-pitch adjacency. The group must decline.
  const edges: ChainEdgeRef[] = [
    { id: 'a1', from: 'A1', to: 'B1' }, { id: 'm1', from: 'B1', to: 'C1' }, { id: 'b1', from: 'C1', to: 'D1' },
    { id: 'm2', from: 'B2', to: 'C2' },
  ];
  const bases: Record<string, Pixel[]> = {
    a1: [[0, 0], [60, 0]], m1: [[60, 0], [120, 0]], b1: [[120, 0], [180, 0]],
    m2: [[60, 4], [120, 4]],
  };
  const chains = [
    { edgeIds: ['m1'], anchorA: 'a1', anchorB: 'b1', arc: 60, interiorNodes: [] },
  ];
  const seats = computeChainSeats({
    chains,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    basePoly: (id) => bases[id],
    laneOffsetOf: (edgeId, lineId) =>
      lineId === 'p' ? (edgeId === 'a1' || edgeId === 'm1' || edgeId === 'b1' ? 0 : undefined)
        : lineId === 'q' ? (edgeId === 'm2' ? 0 : undefined)
          : undefined,
    lineTraversals: new Map([
      ['p', [fwd('a1'), fwd('m1'), fwd('b1')]],
      ['q', [fwd('m2')]],
    ]),
    spacing: SP,
    halfWidthOf: () => 0,
    drawnEdgeIds: ['a1', 'm1', 'b1', 'm2'],
  }).seats;
  assert.equal(seats.get('m1|p'), undefined, 'chain declines beside unmoved parallel ink');
});

test('seats: output is per-edge and identical for a reversed traversal', () => {
  const fwd = (edgeId: string) => ({ edgeId, reversed: false });
  const rev = (edgeId: string) => ({ edgeId, reversed: true });
  const forward = setup();
  const reversed = setup(new Map([
    ['l1', [rev('b'), rev('m2'), rev('m1'), rev('a')]],
    ['l2', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
    ['l3', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
    ['bl', [fwd('a'), fwd('m1'), fwd('br')]],
    ['l4', [fwd('a'), fwd('m1'), fwd('m2'), fwd('b')]],
  ]));
  for (const key of ['m1|l1', 'm2|l1', 'm1|l4']) {
    assert.ok(Math.abs((forward.get(key) ?? NaN) - (reversed.get(key) ?? NaN)) < 1e-9,
      key + ': ' + forward.get(key) + ' vs ' + reversed.get(key));
  }
});
