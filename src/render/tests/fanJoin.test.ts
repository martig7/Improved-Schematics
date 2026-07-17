import { test } from 'node:test';
import assert from 'node:assert';
import { buildFanJoins, collectFanGroups, type FanArgs, type FanEdgeRef } from '../fanJoin';
import type { Pixel, TraversalStep } from '../layout/types';

const SPACING = 6;

function offsetLane(base: Pixel[], o: number): Pixel[] {
  // straight-segment offset good enough for fixtures (bases are single segments)
  const [a, b] = [base[0], base[base.length - 1]];
  const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  return base.map((p): Pixel => [p[0] + nx * o, p[1] + ny * o]);
}

interface Fixture {
  edges: FanEdgeRef[];
  bases: Map<string, Pixel[]>;           // edgeId -> base polyline (from -> to)
  orders: Map<string, string[]>;         // edgeId -> lineOrder
  traversals: Map<string, TraversalStep[]>;
}

function makeArgs(f: Fixture): FanArgs {
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
  return {
    lineTraversals: f.traversals,
    lineIds,
    edgeById,
    segPath,
    suppressed: new Set<string>(),
    orderOf,
    biasOf: new Map(),
    nodePx,
    spacing: SPACING,
    smoothR: 15,
    bigGapMult: 16,
  };
}

const fwd = (edgeId: string): TraversalStep => ({ edgeId, reversed: false });

test('grouping: bundle corner is one group with slot-ordered members; out-and-back seam skipped', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['l1', 'l2', 'l3']],
      ['e2', ['l1', 'l2', 'l3']],
    ]),
    traversals: new Map([
      ['l2', [fwd('e1'), fwd('e2')]],
      ['l1', [fwd('e1'), fwd('e2')]],
      ['l3', [fwd('e1'), fwd('e2')]],
      // out-and-back on one edge: same-edge seam contributes nothing
      ['lx', [fwd('e1'), { edgeId: 'e1', reversed: true }]],
    ]),
  };
  const args = makeArgs(f);
  (args.lineIds as Set<string>).add('lx');
  const groups = collectFanGroups(args.lineTraversals, args.lineIds, args.edgeById, args.orderOf, args.segPath, args.suppressed);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].node, 'N');
  assert.deepEqual(groups[0].members.map((m) => m.lineId), ['l1', 'l2', 'l3']);
});

test('grouping: a closed ring contributes its seam corner', () => {
  // triangle ring: three edges, traversal returns to its start node
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'B', to: 'C' },
      { id: 'e3', from: 'C', to: 'A' },
    ],
    bases: new Map([
      ['e1', [[0, 0], [100, 0]] as Pixel[]],
      ['e2', [[100, 0], [50, 80]] as Pixel[]],
      ['e3', [[50, 80], [0, 0]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['r']],
      ['e2', ['r']],
      ['e3', ['r']],
    ]),
    traversals: new Map([['r', [fwd('e1'), fwd('e2'), fwd('e3')]]]),
  };
  const args = makeArgs(f);
  const groups = collectFanGroups(args.lineTraversals, args.lineIds, args.edgeById, args.orderOf, args.segPath, args.suppressed);
  // corners at B and C from the linear scan, plus the seam corner at A
  assert.equal(groups.length, 3);
  assert.ok(groups.some((g) => g.node === 'A'));
});

test('curve fan: shared trim, nested non-crossing sweeps', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['l1', 'l2', 'l3']],
      ['e2', ['l1', 'l2', 'l3']],
    ]),
    traversals: new Map([
      ['l1', [fwd('e1'), fwd('e2')]],
      ['l2', [fwd('e1'), fwd('e2')]],
      ['l3', [fwd('e1'), fwd('e2')]],
    ]),
  };
  const args = makeArgs(f);
  // give l3's inbound lane a short end segment so ITS leg limits the shared trim
  const p3 = args.segPath.get('e1|l3')!;
  p3.splice(1, 0, [96, p3[1][1]]);
  const r = buildFanJoins(args);
  assert.equal(r.joinCurves.length, 3);
  // shared trim: every member's |apex - a| and |apex - b| equal
  const trims = r.joinCurves.map((c) =>
    Math.sqrt((c.apex[0] - c.a[0]) ** 2 + (c.apex[1] - c.a[1]) ** 2).toFixed(3));
  assert.equal(new Set(trims).size, 1);
  // l3's short leg governs: apex at (106,106), inner vertex x=96 -> la=10 -> f=6
  assert.equal(trims[0], '6.000');
  // nested: apexes ordered along the corner diagonal without collisions
  const apexes = r.joinCurves.map((c) => c.apex[0]).sort((a, b) => a - b);
  assert.deepEqual(apexes, [94, 100, 106]);
  // stops recorded on-curve for each member
  assert.equal(r.joinStopPos.size, 3);
});

test('curve fan: wide-bundle outer lane still curves via fan reach', () => {
  const ids = Array.from({ length: 11 }, (_, i) => 'w' + i);
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ids],
      ['e2', ids],
    ]),
    // only the outermost line turns; its apex sits 30px out (> spacing*4 = 24)
    traversals: new Map([['w10', [fwd('e1'), fwd('e2')]]]),
  };
  const r = buildFanJoins(makeArgs(f));
  assert.equal(r.joinCurves.length, 1);
  assert.equal(r.joinCurves[0].lineId, 'w10');
});

test('jog group: lateral slot change tapers both ends to the midpoint', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [200, 100]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['j1', 'j2']],
      ['e2', ['j2', 'j1']], // order flips across the node: both lines jog
    ]),
    traversals: new Map([
      ['j1', [fwd('e1'), fwd('e2')]],
      ['j2', [fwd('e1'), fwd('e2')]],
    ]),
  };
  const args = makeArgs(f);
  const r = buildFanJoins(args);
  assert.equal(r.joinCurves.length, 0);
  const pIn = args.segPath.get('e1|j1')!;
  const pOut = args.segPath.get('e2|j1')!;
  const end = pIn[pIn.length - 1];
  assert.deepEqual(end, pOut[0]);
  assert.deepEqual(end, [100, 100]); // midpoint of the two lane ends
  assert.ok(r.endMoved.has('e1|j1|e'));
  assert.ok(r.mitered.has('j1|N|e1|e2'));
});

test('absorption: a corner overrunning a micro lane consumes it and spans to the through corridor', () => {
  // 3-line horizontal bundle: m1 rides the outer slot (y=94), turns north
  // at N through a 4px micro edge to F, then continues on e2. Its apex
  // (100,94) lies BEYOND F (y=96), so the corner absorbs the micro lane.
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
  const args = makeArgs(f);
  const r = buildFanJoins(args);
  const abs = r.joinCurves.find((c) => c.lineId === 'm1');
  assert.ok(abs, 'absorbed corner curve exists');
  assert.deepEqual([abs!.edgeA, abs!.edgeB], ['e1', 'e2'], 'curve spans to the through corridor');
  assert.equal(args.segPath.has('eM|m1'), false, 'micro lane consumed');
  assert.ok(args.suppressed.has('eM|m1'), 'consumed lane marked bridgeable');
  assert.ok(r.joinStopPos.has('N|m1') && r.joinStopPos.has('F|m1'), 'stops at both spanned nodes sit on the curve');
});

test('absorption: through reference rides the base corridor, not a tapered micro end segment', () => {
  // m1 turns at N onto a 40px near edge whose through continuation is an
  // 8px micro. The micro's lane is pre-slanted (as a prior jog taper leaves
  // it); the corner's corridor reference must extend the BASE direction
  // from the lane anchor, not the slanted end segment, or the slope
  // amplifies across the absorbed span and the corner lands off-corridor.
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'eM', from: 'N', to: 'Z' },
      { id: 'e2', from: 'Z', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['eM', [[100, 100], [100, 88]] as Pixel[]],
      ['e2', [[100, 88], [100, 80]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['m1', 'x', 'y']],
      ['eM', ['m1']],
      ['e2', ['m1']],
    ]),
    traversals: new Map([['m1', [fwd('e1'), fwd('eM'), fwd('e2')]]]),
  };
  const args = makeArgs(f);
  args.segPath.set('e2|m1', [[101, 88], [104, 80]]);
  args.baseEndDir = (edgeId, node) => {
    const base = f.bases.get(edgeId);
    const e = f.edges.find((x) => x.id === edgeId);
    if (!base || !e) return null;
    const atStart = e.from === node;
    const a = atStart ? base[0] : base[base.length - 1];
    const b = atStart ? base[1] : base[base.length - 2];
    const l = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    return l > 1e-6 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
  };
  const r = buildFanJoins(args);
  const abs = r.joinCurves.find((c) => c.lineId === 'm1' && c.edgeA === 'e1');
  assert.ok(abs, 'absorbed corner curve exists');
  // the outbound leg stays on the corridor-parallel ray through the anchor
  // (x=104); the slanted end segment extended to the corner would land it
  // several px west of the base line
  for (const p of args.segPath.get('e2|m1') ?? []) {
    assert.ok(p[0] >= 100.9, 'through lane stays on its corridor side: x=' + p[0]);
  }
  // the anchor end sits at x=101, so the corridor-parallel reference puts
  // the apex there; the slanted end segment extended to the corner would
  // land it at x=98.75
  assert.ok(Math.abs(abs!.apex[0] - 101) < 0.5, 'apex on the corridor-parallel ray: x=' + abs!.apex[0]);
});

test('absorption: a corner engulfed on both flanks absorbs both and spans corridor to corridor', () => {
  // m1 turns at N between two micro edges whose lanes both sit off their
  // through seats; the corner absorbs BOTH and spans e1 -> e2, resolving
  // the seat seams at P and Q inside the corner.
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'P' },
      { id: 'eM1', from: 'P', to: 'N' },
      { id: 'eM2', from: 'N', to: 'Q' },
      { id: 'e2', from: 'Q', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [92, 100]] as Pixel[]],
      ['eM1', [[92, 100], [100, 100]] as Pixel[]],
      ['eM2', [[100, 100], [100, 92]] as Pixel[]],
      ['e2', [[100, 92], [100, 0]] as Pixel[]],
    ]),
    orders: new Map([
      ['e1', ['m1']],
      ['eM1', ['m1']],
      ['eM2', ['m1']],
      ['e2', ['m1']],
    ]),
    traversals: new Map([['m1', [fwd('e1'), fwd('eM1'), fwd('eM2'), fwd('e2')]]]),
  };
  const args = makeArgs(f);
  args.segPath.set('eM1|m1', [[92, 101], [100, 101]]);
  args.segPath.set('eM2|m1', [[101, 100], [101, 92]]);
  args.baseEndDir = (edgeId, node) => {
    const base = f.bases.get(edgeId);
    const e = f.edges.find((x) => x.id === edgeId);
    if (!base || !e) return null;
    const atStart = e.from === node;
    if (!atStart && e.to !== node) return null;
    const a = atStart ? base[0] : base[base.length - 1];
    const b = atStart ? base[1] : base[base.length - 2];
    const l = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    return l > 1e-6 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
  };
  const r = buildFanJoins(args);
  const abs = r.joinCurves.find((c) => c.lineId === 'm1' && c.edgeA === 'e1' && c.edgeB === 'e2');
  assert.ok(abs, 'corner spans corridor to corridor');
  assert.ok(Math.abs(abs!.apex[0] - 100) < 0.5 && Math.abs(abs!.apex[1] - 100) < 0.5, 'apex at the junction: ' + abs!.apex);
  assert.equal(args.segPath.has('eM1|m1'), false, 'inbound micro consumed');
  assert.equal(args.segPath.has('eM2|m1'), false, 'outbound micro consumed');
  assert.ok(args.suppressed.has('eM1|m1') && args.suppressed.has('eM2|m1'), 'both marked bridgeable');
  assert.ok(r.joinStopPos.has('N|m1') && r.joinStopPos.has('P|m1') && r.joinStopPos.has('Q|m1'), 'stops at all spanned nodes');
});

test('sharp fan: hairpin turn pins both lane ends to the shared meet', () => {
  const f: Fixture = {
    edges: [
      { id: 'e1', from: 'A', to: 'N' },
      { id: 'e2', from: 'N', to: 'B' },
    ],
    bases: new Map([
      ['e1', [[0, 100], [100, 100]] as Pixel[]],
      ['e2', [[100, 100], [30, 30]] as Pixel[]], // back out northwest: dot ~ -0.71
    ]),
    orders: new Map([
      ['e1', ['s1', 's2']],
      ['e2', ['s1', 's2']],
    ]),
    traversals: new Map([
      ['s1', [fwd('e1'), fwd('e2')]],
      ['s2', [fwd('e1'), fwd('e2')]],
    ]),
  };
  const args = makeArgs(f);
  const r = buildFanJoins(args);
  assert.equal(r.joinCurves.length, 0);
  for (const id of ['s1', 's2']) {
    const pIn = args.segPath.get('e1|' + id)!;
    const pOut = args.segPath.get('e2|' + id)!;
    const a = pIn[pIn.length - 1];
    const b = pOut[0];
    assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6, id + ' ends meet');
    assert.ok(r.mitered.has(id + '|N|e1|e2'));
  }
});
