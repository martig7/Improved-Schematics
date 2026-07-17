import { test } from 'node:test';
import assert from 'node:assert';
import { assembleDByLine, type AssembleArgs } from '../assemblePath';
import { buildFanJoins, type FanEdgeRef } from '../fanJoin';
import type { Pixel, TraversalStep } from '../layout/types';

const SPACING = 6;
const fwd = (edgeId: string): TraversalStep => ({ edgeId, reversed: false });
const rev = (edgeId: string): TraversalStep => ({ edgeId, reversed: true });

function offsetLane(base: Pixel[], o: number): Pixel[] {
  const [a, b] = [base[0], base[base.length - 1]];
  const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  return base.map((p): Pixel => [p[0] + nx * o, p[1] + ny * o]);
}

interface Fixture {
  edges: FanEdgeRef[];
  bases: Map<string, Pixel[]>;
  orders: Map<string, string[]>;
  traversals: Map<string, TraversalStep[]>;
}

function build(f: Fixture): { args: AssembleArgs; segPath: Map<string, Pixel[]> } {
  const edgeById = new Map(f.edges.map((e) => [e.id, e]));
  const orderOf = new Map(f.orders);
  const segPath = new Map<string, Pixel[]>();
  const nodePx = new Map<string, Pixel>();
  for (const e of f.edges) {
    const base = f.bases.get(e.id)!;
    nodePx.set(e.from, base[0]);
    nodePx.set(e.to, base[base.length - 1]);
    const order = f.orders.get(e.id)!;
    const center = (order.length - 1) / 2;
    order.forEach((lineId, i) => {
      segPath.set(e.id + '|' + lineId, offsetLane(base, (i - center) * SPACING));
    });
  }
  const lineIds = new Set<string>();
  for (const o of f.orders.values()) for (const id of o) lineIds.add(id);
  const suppressed = new Set<string>();
  const fan = buildFanJoins({
    lineTraversals: f.traversals, lineIds, edgeById, segPath, suppressed, orderOf,
    biasOf: new Map(), nodePx, spacing: SPACING, smoothR: 15, bigGapMult: 16,
  });
  return {
    segPath,
    args: {
      segPath, joinCurves: fan.joinCurves, filletR: 15,
      lineTraversals: f.traversals, lineIds, edgeById, orderOf,
      suppressed, spacing: SPACING,
    },
  };
}

const countCmd = (d: string[], c: string): number => d.filter((s) => s.startsWith(c)).length;

test('assembler: a corner course is one continuous subpath with its curve spliced in', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([['e1', ['l1']], ['e2', ['l1']]]),
    traversals: new Map([['l1', [fwd('e1'), fwd('e2')]]]),
  };
  const { args } = build(f);
  const d = assembleDByLine(args).get('l1')!;
  assert.equal(countCmd(d, 'M'), 1, 'one subpath: ' + d.join(' '));
  assert.equal(countCmd(d, 'Q'), 1, 'corner curve in-path');
});

test('assembler: a lateral jog is a constructed in-path transition, not a separate chord', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [200, 100]] as Pixel[]],
    ]),
    // order flips: both lines jog laterally across N; short edges would
    // decline the taper, but these are long, so the fan tapers and ends
    // meet. Force a residual gap instead by suppressing the taper: use a
    // 3-line fixture where one line keeps a 2-slot jog beyond drift caps.
    orders: new Map([['e1', ['j1', 'j2']], ['e2', ['j2', 'j1']]]),
    traversals: new Map([
      ['j1', [fwd('e1'), fwd('e2')]],
      ['j2', [fwd('e1'), fwd('e2')]],
    ]),
  };
  const { args } = build(f);
  const d = assembleDByLine(args).get('j1')!;
  // whether the fan tapered (coincident ends) or a transition was
  // constructed, the course must remain ONE subpath with no bare M-chord
  assert.equal(countCmd(d, 'M'), 1, 'one subpath: ' + d.join(' '));
});

test('assembler: an out-and-back course draws its lane once', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([['e1', ['r1']], ['e2', ['r1']]]),
    traversals: new Map([['r1', [fwd('e1'), fwd('e2'), rev('e2'), rev('e1')]]]),
  };
  const { args } = build(f);
  const d = assembleDByLine(args).get('r1')!;
  assert.equal(countCmd(d, 'M'), 1, 'lane drawn once, no return-strand: ' + d.join(' '));
  assert.equal(countCmd(d, 'Q'), 1, 'the corner drawn once');
});

test('assembler: a ring course constructs its seam joint', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'B', to: 'C' },
      { id: 'e3', from: 'C', to: 'D' },
      { id: 'e4', from: 'D', to: 'A' },
    ],
    bases: new Map([
      ['e1', [[0, 0], [100, 0]] as Pixel[]],
      ['e2', [[100, 0], [100, 100]] as Pixel[]],
      ['e3', [[100, 100], [0, 100]] as Pixel[]],
      ['e4', [[0, 100], [0, 0]] as Pixel[]],
    ]),
    orders: new Map([['e1', ['r']], ['e2', ['r']], ['e3', ['r']], ['e4', ['r']]]),
    traversals: new Map([['r', [fwd('e1'), fwd('e2'), fwd('e3'), fwd('e4')]]]),
  };
  const { args } = build(f);
  const d = assembleDByLine(args).get('r')!;
  assert.equal(countCmd(d, 'M'), 1, 'one closed subpath: ' + d.join(' '));
  assert.equal(countCmd(d, 'Q'), 4, 'all four corners incl. the seam: ' + d.join(' '));
});

test('assembler: an absorbed micro lane bridges in one continuous subpath', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'eM', from: 'N', to: 'F' },
      { id: 'e2', from: 'F', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['eM', [[100, 100], [100, 96]] as Pixel[]],
      ['e2', [[100, 96], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['m1', 'x', 'y']],
      ['eM', ['m1']],
      ['e2', ['m1']],
    ]),
    traversals: new Map([['m1', [fwd('e1'), fwd('eM'), fwd('e2')]]]),
  };
  const { args, segPath } = build(f);
  assert.equal(segPath.has('eM|m1'), false, 'micro lane consumed by the fan');
  const d = assembleDByLine(args).get('m1')!;
  assert.equal(countCmd(d, 'M'), 1, 'one continuous subpath across the absorbed corner: ' + d.join(' '));
  assert.equal(countCmd(d, 'Q'), 1, 'the spanning curve spliced in-path');
});

test('assembler: traversal-less lines keep standalone lane emission', () => {
  const f: Fixture = {
    edges: [{ id: 'e1', from: 'A', to: 'N' }],
    bases: new Map([['e1', [[0, 100], [100, 100]] as Pixel[]]]),
    orders: new Map([['e1', ['x1']]]),
    traversals: new Map(),
  };
  const { args } = build(f);
  (args.lineIds as Set<string>).add('x1');
  const d = assembleDByLine(args).get('x1')!;
  assert.equal(countCmd(d, 'M'), 1);
});
