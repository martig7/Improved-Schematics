import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dc } from '../dc';
import { LINE_WIDTH } from '../../constants';
import { computeDcByNode, TAIL, REACH, BADGE_GAP, BADGE_R, type DcLane } from '../../layout/dcStations';
import type { StopScene, StopLine, Point } from '../types';

const ctx = { dark: false, showBullets: true };

const ln = (i: number, pos: Point, extra: Partial<StopLine> = {}): StopLine =>
  ({ lineId: 'L' + i, color: '#dc2626', bullet: String(i), textColor: '#fff', pos, chain: i, axis: 0, dir: [1, 0], ...extra });

const scene = (lines: StopLine[], anchor: Point = [0, 0]): StopScene =>
  ({ nodeId: 'n', lines, capsule: { kind: 'none' }, anchor, dotRadius: 3 });

const circles = (g: ReturnType<typeof dc.paint>) => g.filter((x) => x.kind === 'circle') as Array<{ cx: number; cy: number; r: number }>;
const ticks = (g: ReturnType<typeof dc.paint>) => g.filter((x) => x.kind === 'line');
const paths = (g: ReturnType<typeof dc.paint>) => g.filter((x) => x.kind === 'path') as Array<{ d: string; fill: string; stroke: string; strokeWidth: number }>;

// The centre of each mark. A mark is a stack of concentric circles (two for the
// plain stop circle, four for the double ring), so the distinct centres are the
// marks.
const seatsOf = (g: ReturnType<typeof dc.paint>): Point[] => {
  const out: Point[] = [];
  for (const c of circles(g)) {
    if (!out.some((p) => p[0] === c.cx && p[1] === c.cy)) out.push([c.cx, c.cy]);
  }
  return out;
};

// Each mark with its outer radius: a double ring is wider than a stop circle, and
// how far a mark reaches depends on which it is.
const marksOf = (g: ReturnType<typeof dc.paint>): Array<{ at: Point; r: number }> => {
  const out: Array<{ at: Point; r: number }> = [];
  for (const c of circles(g)) {
    const hit = out.find((m) => m.at[0] === c.cx && m.at[1] === c.cy);
    if (hit) hit.r = Math.max(hit.r, c.r);
    else out.push({ at: [c.cx, c.cy], r: c.r });
  }
  return out;
};

// Offset of a point across a lane, i.e. along the lane's normal.
const across = (l: StopLine, p: Point): number => {
  const t = l.dir ?? [1, 0];
  return Math.abs((p[0] - l.pos[0]) * -t[1] + (p[1] - l.pos[1]) * t[0]);
};
// Does this mark's ink overlap this lane's stroke? That is what it means for a
// line to carry a mark, whether the mark sits on the rail or between a pair.
const touches = (l: StopLine, m: { at: Point; r: number }): boolean =>
  across(l, m.at) <= m.r + LINE_WIDTH / 2 + 1e-9;

test('a lone stop is one ringed circle fitted in the line', () => {
  const g = dc.paint(scene([ln(0, [10, 20])]), ctx);
  const c = circles(g);
  assert.equal(c.length, 2, 'ink disc + paper disc');
  assert.equal(ticks(g).length, 0);
  for (const x of c) assert.deepEqual([x.cx, x.cy], [10, 20]);
  assert.ok(c[0].r > c[1].r, 'the paper disc sits inside the ink one');
});

// A band's lanes at one lane pitch apart, which is what pairs off.
const band = (n: number, pitch = 5): StopLine[] =>
  Array.from({ length: n }, (_, i) => ln(i, [0, i * pitch]));
const spineOf = (lanes: StopLine[]): Point[] => lanes.map((l): Point => [l.pos[0], l.pos[1]]);

test('a two-lane bundle is one double ring bridging the pair', () => {
  const g = dc.paint(pill(band(2), spineOf(band(2))), ctx);
  const c = circles(g);
  assert.equal(c.length, 4, 'a double ring');
  assert.deepEqual([c[0].cx, c[0].cy], [0, 2.5], 'between the two rails');
  assert.equal(paths(g).length, 0, 'one mark speaks for it, so no capsule');
});

test('a three-lane bundle is a double and a single', () => {
  const lanes = band(3);
  const g = dc.paint(pill(lanes, spineOf(lanes)), ctx);
  assert.deepEqual(seatsOf(g).sort((a, b) => a[1] - b[1]), [[0, 2.5], [0, 10]]);
  assert.equal(circles(g).length, 4 + 2, 'a double ring and a stop circle');
});

test('a five-lane bundle is two doubles and a single', () => {
  const lanes = band(5);
  const g = dc.paint(pill(lanes, spineOf(lanes)), ctx);
  assert.deepEqual(seatsOf(g).sort((a, b) => a[1] - b[1]), [[0, 2.5], [0, 12.5], [0, 20]]);
  assert.equal(circles(g).length, 4 + 4 + 2, 'two double rings and a stop circle');
});

test('no station wears a dash', () => {
  // The design marks in pairs of track; nothing is marked by a bare tick.
  for (const lanes of [band(1), band(2), band(3), band(4), band(5), wideLanes(), tightLanes(), TWO_RUNS]) {
    assert.equal(ticks(dc.paint(pill(lanes, spineOf(lanes)), ctx)).length, 0, `${lanes.length} lanes`);
  }
});

test('pairing follows neighbouring RAILS, not neighbours in the chain', () => {
  // Two lanes share a place in the capsule chain, so chain order does not follow
  // the band. The pair must still be the two rails that are actually adjacent.
  const lanes = [
    ln(0, [0, 0], { chain: 0 }),
    ln(1, [0, 10], { chain: 0 }),
    ln(2, [0, 5], { chain: 2 }),
  ];
  const g = dc.paint(pill(lanes, spineOf(lanes)), ctx);
  assert.deepEqual(seatsOf(g).sort((a, b) => a[1] - b[1]), [[0, 2.5], [0, 10]]);
});

test('rails whose stops sit at different points along the run are not bridged', () => {
  // Adjacent rails, but one lane's stop is well down its track from the other's.
  // Their midpoint is somewhere neither of them stops, and where a lane may already
  // have ended, so the mark must not be seated there.
  const lanes = [
    ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
    ln(1, [13.5, 5], { axis: 0, dir: [1, 0] }),
  ];
  const g = dc.paint(pill(lanes, lanes.map((l): Point => [l.pos[0], l.pos[1]])), ctx);
  for (const s of seatsOf(g)) {
    assert.ok(Math.abs(s[1]) < 1e-6 || Math.abs(s[1] - 5) < 1e-6, `mark at ${s} is not on a rail`);
  }
  assert.equal(seatsOf(g).length, 2, 'one mark per rail, not one between them');
});

test('lanes running the same way but on separate runs are not one bundle', () => {
  // Rails three pitches apart. A dot seated between them would reach neither, and
  // its dashes would stand out on their own rails with nothing tying them to it.
  // This is a wide station, and takes the capsule.
  const lanes = [
    ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
    ln(1, [0, 16.5], { axis: 0, dir: [1, 0] }),
    ln(2, [0, 33], { axis: 0, dir: [1, 0] }),
    ln(3, [0, 49.5], { axis: 0, dir: [1, 0] }),
  ];
  const g = dc.paint(pill(lanes, lanes.map((l): Point => [l.pos[0], l.pos[1]])), ctx);
  assert.equal(ticks(g).length, 0, 'no stranded dashes');
  assert.equal(paths(g).length, 1, 'a capsule line ties the station together');
  assert.deepEqual(seatsOf(g).map((s) => s[1]).sort((a, b) => a - b), [0, 16.5, 33, 49.5], 'a mark on each rail');
});

test('a mark never slides past the end of a terminating line', () => {
  // Two bands crossing, but the vertical pair TERMINATES at this station. The
  // junction of the two band centrelines lies well down the run from where those
  // lines stop, so a mark there would stand in open space with the lines visibly
  // ending short of it. Each band is marked where its own tracks are instead.
  const g = dc.paint(pill(CROSS_ENDING, spineOf(CROSS_ENDING)), ctx);
  const seats = seatsOf(g).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(seats, [[2.75, -6], [10, 2.75]], 'a mark on each band, where its track is');
  assert.equal(paths(g).length, 1, 'the capsule ties them together');
});

test('a through line still lets its mark slide along the run', () => {
  // The same shape with nothing terminating: the junction is on every line, so one
  // mark speaks for the whole station.
  const lanes = CROSS_ENDING.map((l) => ({ ...l, terminus: false }));
  const g = dc.paint(pill(lanes, spineOf(lanes)), ctx);
  assert.deepEqual(seatsOf(g), [[2.75, 2.75]], 'one mark at the junction');
  assert.equal(paths(g).length, 0);
});

test('lanes pointing different ways make it a transfer: a double ring', () => {
  // A horizontal lane at y=20 crossed by a vertical lane at x=10.
  const lines = [ln(0, [0, 20], { axis: 0, dir: [1, 0] }), ln(1, [10, 0], { axis: 2, dir: [0, 1] })];
  const g = dc.paint(scene(lines, [999, 999]), ctx);
  const c = circles(g);
  assert.equal(c.length, 4, 'outer ring (2) plus the inner stop circle (2)');
  for (const x of c) {
    // At the junction of the two centrelines, NOT at the (deliberately bogus) anchor.
    assert.ok(Math.abs(x.cx - 10) < 1e-6 && Math.abs(x.cy - 20) < 1e-6, `seated at ${x.cx},${x.cy}`);
  }
  assert.equal(ticks(g).length, 0);
});

test('a transfer seats centred between a two-lane bundle, not on a rail', () => {
  // A two-lane horizontal band at y=0 and y=5 (adjacent lanes, so one mark spans
  // the pair), crossed by a vertical lane.
  const lines = [
    ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
    ln(1, [0, 5], { axis: 0, dir: [1, 0] }),
    ln(2, [30, 0], { axis: 2, dir: [0, 1] }),
  ];
  const g = dc.paint(scene(lines, [0, 0]), ctx);
  const c = circles(g);
  // Centred BETWEEN the pair (y=2.5), and on the crossing lane (x=30).
  assert.ok(Math.abs(c[0].cy - 2.5) < 1e-6, `expected the band centre, got y=${c[0].cy}`);
  assert.ok(Math.abs(c[0].cx - 30) < 1e-6, `expected the crossing lane, got x=${c[0].cx}`);
  assert.equal(ticks(g).length, 0, 'the mark stands on all three lanes');
});

test('a splitting bundle counts as a transfer even on a shared axis', () => {
  // Same octilinear axis, but the exact tangents diverge: a split, not a run.
  const lines = [ln(0, [0, 0], { dir: [1, 0] }), ln(1, [0, 10], { dir: [0.7, 0.71] })];
  const g = dc.paint(scene(lines, [0, 5]), ctx);
  assert.equal(circles(g).length, 4, 'double ring');
});

test('marks solved onto one another are the station: one ring there', () => {
  const sc: StopScene = {
    nodeId: 'n', lines: [], capsule: { kind: 'ring', cx: 42, cy: 17, r: 9 },
    anchor: [999, 999], dotRadius: 3,
  };
  const g = dc.paint(sc, ctx);
  assert.equal(circles(g).length, 4);
  assert.equal(ticks(g).length, 0);
  assert.equal(paths(g).length, 0, 'a point needs no capsule line');
});

// Placement hands a crossing regime the capsule spine plus, when the compute-time
// solve found one, the exact point the lanes cross at.
const pill = (lines: StopLine[], points: Point[], cross?: Point): StopScene =>
  ({ nodeId: 'n', lines, capsule: { kind: 'pill', points, smooth: false, ...(cross ? { cross } : {}) }, anchor: [0, 0], dotRadius: 3 });

// Two narrow bands meeting at a point: one mark reaches every lane.
const tightLanes = (): StopLine[] => [
  ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
  ln(1, [0, 5], { axis: 0, dir: [1, 0] }),
  ln(2, [100, 0], { axis: 2, dir: [0, 1] }),
];

// Two two-lane runs pointing 19 degrees differently and 130px apart. Each run's
// rails are offset PERPENDICULAR to it, the way rails of one band are.
const TWO_RUNS: StopLine[] = [
  ln(0, [0, 0], { axis: 2, dir: [0, 1] }),
  ln(1, [8, 0], { axis: 2, dir: [0, 1] }),
  ln(2, [130, 0], { axis: 2, dir: [-0.35, -0.94] }),
  ln(3, [137.52, -2.8], { axis: 2, dir: [-0.35, -0.94] }),
];

// Two bands crossing, where the vertical pair TERMINATES at the station: their
// track stops well short of where the two band centrelines meet.
const CROSS_ENDING: StopLine[] = [
  ln(0, [10, 0], { axis: 0, dir: [1, 0] }),
  ln(1, [10, 5.5], { axis: 0, dir: [1, 0] }),
  ln(2, [0, -6], { axis: 2, dir: [0, 1], terminus: true }),
  ln(3, [5.5, -6], { axis: 2, dir: [0, 1], terminus: true }),
];

// A four-lane band crossed by one lane: no single mark spans the band.
const wideLanes = (): StopLine[] => [
  ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
  ln(1, [0, 5], { axis: 0, dir: [1, 0] }),
  ln(2, [0, 10], { axis: 0, dir: [1, 0] }),
  ln(3, [0, 15], { axis: 0, dir: [1, 0] }),
  ln(4, [50, 0], { axis: 2, dir: [0, 1] }),
];

test('a point transfer takes the solved crossing verbatim', () => {
  // The solve runs over the DRAWN ribbons, so it beats anything re-derived from
  // the seated dots; the mark must land on it exactly.
  const g = dc.paint(pill(tightLanes(), [[0, 0], [0, 5]], [100, 2.5]), ctx);
  const c = circles(g);
  assert.equal(c.length, 4, 'one double ring');
  for (const x of c) assert.ok(Math.abs(x.cx - 100) < 1e-6 && Math.abs(x.cy - 2.5) < 1e-6, `seated at ${x.cx},${x.cy}`);
  assert.equal(paths(g).length, 0, 'a point transfer draws no capsule line');
});

test('with no solved crossing a point transfer derives one from the bands', () => {
  const c = circles(dc.paint(pill(tightLanes(), [[0, 0], [0, 5]]), ctx));
  assert.equal(c.length, 4);
  assert.ok(Math.abs(c[0].cx - 100) < 1e-6 && Math.abs(c[0].cy - 2.5) < 1e-6, `seated at ${c[0].cx},${c[0].cy}`);
});

test('a complex too wide for one mark is drawn as a continuous capsule line', () => {
  const spine: Point[] = [[0, 0], [0, 15], [50, 15], [50, 0]];
  const g = dc.paint(pill(wideLanes(), spine, [50, 7.5]), ctx);
  const p = paths(g);
  assert.equal(p.length, 1, 'one line, not a run of separate ticks');
  assert.equal(ticks(g).length, 0, 'and no stubs at all');
  assert.equal(p[0].fill, 'none');
  // It traces the capsule's own spine, bends and all.
  for (const v of spine) {
    assert.ok(p[0].d.includes(`${v[0].toFixed(1)} ${v[1].toFixed(1)}`), `spine vertex ${v} missing from ${p[0].d}`);
  }
});

test('a wide complex pairs each bundle off under double rings', () => {
  const g = dc.paint(pill(wideLanes(), [[0, 0], [0, 15]], [50, 7.5]), ctx);
  assert.equal(paths(g).length, 1, 'wide: it carries a capsule line');
  // The four-lane band pairs into two doubles; the lone crossing lane is a leftover
  // and takes the single-ringed stop circle on itself.
  assert.deepEqual(seatsOf(g).sort((a, b) => a[0] - b[0] || a[1] - b[1]), [[0, 2.5], [0, 12.5], [50, 0]]);
  assert.equal(circles(g).length, 4 + 4 + 2, 'two double rings and one stop circle');
});

test('a leftover lane takes a single ring, a pair takes a double', () => {
  // A three-lane bundle beside a five-lane one: a double and a single, then two
  // doubles and a single.
  const band = (i: number, x: number, y: number, dir: Point): StopLine =>
    ln(i, [x, y], { axis: dir[0] === 1 ? 0 : 2, dir });
  const lanes = [
    band(0, 0, 0, [1, 0]), band(1, 0, 5, [1, 0]), band(2, 0, 10, [1, 0]),
    band(3, 40, 0, [0, 1]), band(4, 45, 0, [0, 1]), band(5, 50, 0, [0, 1]),
    band(6, 55, 0, [0, 1]), band(7, 60, 0, [0, 1]),
  ];
  const g = dc.paint(pill(lanes, lanes.map((l): Point => [l.pos[0], l.pos[1]])), ctx);
  const seats = seatsOf(g).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // The three-lane band: one pair plus a leftover. The five-lane band: two pairs
  // plus a leftover.
  assert.deepEqual(seats, [[0, 2.5], [0, 10], [40, 0], [47.5, 0], [57.5, 0]]);
  // Three pairs (double rings, 4 circles each) and two leftovers (2 circles each).
  assert.equal(circles(g).length, 3 * 4 + 2 * 2);
});

test('pairing never reaches across a bundle', () => {
  // Two two-lane runs pointing differently: each pairs within itself, so neither
  // mark straddles the two runs. Each run's rails are offset perpendicular to it,
  // as rails of one band are.
  const seats = seatsOf(dc.paint(pill(TWO_RUNS, [[0, 0], [137.52, -2.8]]), ctx));
  const xs = seats.map((s) => s[0]).sort((a, b) => a - b);
  assert.equal(xs.length, 2, `one mark per run, got ${JSON.stringify(seats)}`);
  assert.ok(Math.abs(xs[0] - 4) < 1e-6 && Math.abs(xs[1] - 133.76) < 1e-6, JSON.stringify(xs));
});

// The two rules a wide complex must never break: no line without a mark on it, and
// no mark sitting off the lines. A mark either stands on a rail, or is seated
// between the two rails of one bundle and so reaches both; either way it reaches
// the ink, which is what both assertions below measure.
const COVERAGE: Array<{ name: string; lanes: StopLine[] }> = [
  { name: 'a band crossed by one lane', lanes: wideLanes() },
  { name: 'two narrow bands meeting', lanes: tightLanes() },
  { name: 'two runs that never meet', lanes: TWO_RUNS },
  {
    name: 'bands on four directions',
    lanes: [
      ln(0, [0, 0], { axis: 2, dir: [0, 1] }),
      ln(1, [6, 0], { axis: 2, dir: [0, 1] }),
      ln(2, [90, 10], { axis: 1, dir: [0.64, 0.76] }),
      ln(3, [96, 4], { axis: 1, dir: [0.64, 0.76] }),
      ln(4, [140, 20], { axis: 0, dir: [1, 0] }),
      ln(5, [146, 26], { axis: 3, dir: [0.77, -0.64] }),
    ],
  },
];

for (const c of COVERAGE) {
  test(`${c.name}: every lane carries a mark, and every mark stands on a lane`, () => {
    const spine = c.lanes.map((l): Point => [l.pos[0], l.pos[1]]);
    const marks = marksOf(dc.paint(pill(c.lanes, spine), ctx));
    assert.ok(marks.length > 0);
    for (const l of c.lanes) {
      assert.ok(marks.some((m) => touches(l, m)), `the lane at ${l.pos} carries no mark`);
    }
    for (const m of marks) {
      assert.ok(c.lanes.some((l) => touches(l, m)), `the mark at ${m.at} touches no line`);
    }
  });
}

test('lanes on DIFFERENT axes that genuinely cross share one mark', () => {
  // A horizontal lane and a diagonal one whose dots sit a few px apart but whose
  // runs meet: one mark stands on both, so grouping must not split them by axis.
  const k = Math.SQRT1_2;
  const lanes = [
    ln(0, [0, 0], { axis: 0, dir: [1, 0] }),
    ln(1, [5, 5], { axis: 3, dir: [k, -k] }),
  ];
  const c = circles(dc.paint(pill(lanes, [[0, 0], [5, 5]]), ctx));
  assert.equal(c.length, 4, 'one mark, not one per axis');
  // They meet where the diagonal reaches y=0.
  assert.ok(Math.abs(c[0].cx - 10) < 1e-6 && Math.abs(c[0].cy) < 1e-6, `met at ${c[0].cx},${c[0].cy}`);
});

test('lanes SHARING an axis but running far apart get separate marks', () => {
  // Same octilinear axis, tangents 19 degrees apart, dots 130px apart: two runs,
  // not one band, so neither may be left speaking for the other.
  const lanes = [
    ln(0, [0, 0], { axis: 2, dir: [-0.03, -1] }),
    ln(1, [130, 0], { axis: 2, dir: [-0.35, -0.94] }),
    ln(2, [65, 0], { axis: 0, dir: [1, 0] }),
  ];
  const seats = seatsOf(dc.paint(pill(lanes, [[0, 0], [130, 0]]), ctx)).map((s) => s[0]).sort((a, b) => a - b);
  assert.ok(seats.length >= 2, `expected separate marks, got ${JSON.stringify(seats)}`);
  assert.ok(seats[seats.length - 1] - seats[0] > 100, 'one at each run');
});

test('every lane of a wide complex is on the capsule line', () => {
  // The spine passes through every dot, so nothing can be left unmarked even where
  // a group's ring seats on another lane.
  const lanes = wideLanes();
  const spine: Point[] = lanes.map((l) => [l.pos[0], l.pos[1]]);
  const p = paths(dc.paint(pill(lanes, spine, [50, 7.5]), ctx));
  assert.equal(p.length, 1);
  for (const l of lanes) {
    assert.ok(p[0].d.includes(`${l.pos[0].toFixed(1)} ${l.pos[1].toFixed(1)}`), `lane at ${l.pos} not on the line`);
  }
});

// Three lines ending at one station, their ends converging on the same spot.
const THREE_ENDS: StopLine[] = [
  ln(0, [0, 0], { axis: 2, dir: [0, 1], terminus: true, end: [0, 1], bullet: 'A' }),
  ln(1, [5.5, 0], { axis: 2, dir: [0, 1], terminus: true, end: [0, 1], bullet: 'B' }),
  ln(2, [11, 0], { axis: 2, dir: [0, 1], terminus: true, end: [0, 1], bullet: 'C' }),
];

// Line ends are seated over the whole map, so they are solved rather than painted.
const endLane = (i: number, pos: Point, end: Point): DcLane =>
  ({ lineId: 'L' + i, pos, chain: i, axis: 2, dir: [0, 1], terminus: true, end });

test('a line end runs on past its stop and is cut square', () => {
  const solved = computeDcByNode(new Map([['n', [endLane(0, [0, 0], [0, 1])]]]));
  const ends = solved.get('n')!.ends;
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].cut, [0, TAIL], 'cut a tail out along the end direction');
  // Far enough that the cut clears an interchange ring seated at the stop.
  assert.ok(TAIL > REACH, `tail ${TAIL} does not clear a ring of ${REACH}`);
});

test('the symbol hangs off the cut with paper between', () => {
  const solved = computeDcByNode(new Map([['n', [endLane(0, [0, 0], [0, 1])]]]));
  const { cut, at } = solved.get('n')!.ends[0];
  const d = Math.hypot(at[0] - cut[0], at[1] - cut[1]);
  assert.ok(Math.abs(d - (BADGE_GAP + BADGE_R)) < 1e-9, `symbol ${d} from the cut`);
});

test('converging line-end symbols are moved apart', () => {
  const lanes = [0, 1, 2].map((i) => endLane(i, [i * 5.5, 0], [0, 1]));
  const ends = computeDcByNode(new Map([['n', lanes]])).get('n')!.ends;
  assert.equal(ends.length, 3);
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const d = Math.hypot(ends[i].at[0] - ends[j].at[0], ends[i].at[1] - ends[j].at[1]);
      assert.ok(d >= 2 * BADGE_R - 1e-6, `symbols ${i},${j} overlap: ${d.toFixed(2)}px`);
    }
  }
});

test('a symbol pushes further along its line rather than stepping aside', () => {
  // Its first choice is taken by a neighbouring station's mark. Stepping aside
  // costs five times a move further out, so it stays on its line's axis.
  const nominal = TAIL + BADGE_GAP + BADGE_R;
  const solved = computeDcByNode(new Map([
    ['a', [endLane(0, [0, 0], [0, 1])]],
    ['b', [{ lineId: 'X', pos: [0, nominal] as Point, chain: 0, axis: 0, dir: [1, 0] as Point }]],
  ]));
  const at = solved.get('a')!.ends[0].at;
  assert.ok(Math.abs(at[0]) < 1e-9, `stepped aside to x=${at[0]}`);
  assert.ok(at[1] > nominal, `did not move further out: y=${at[1]}`);
});

test('a symbol keeps clear of lines that are not its own', () => {
  // A line running across the way out. The symbol must not land on it.
  const segs = new Map([['X', [[[-100, 40], [100, 40]] as [Point, Point]]]]);
  const solved = computeDcByNode(new Map([['n', [endLane(0, [0, 0], [0, 1])]]]), segs);
  const at = solved.get('n')!.ends[0].at;
  const gap = Math.abs(at[1] - 40);
  assert.ok(gap >= BADGE_R + LINE_WIDTH / 2 - 1e-6, `symbol sits on the crossing line: ${gap.toFixed(2)}px`);
});

test('a mark is never placed where no line is drawn', () => {
  // Two lanes whose tangents meet a long way off, where both ribbons have long
  // since bent away. Following the tangents alone would seat one mark out in open
  // space; against the drawn ink there is nothing there, so each lane is marked on
  // itself instead.
  const lanes: DcLane[] = [
    { lineId: 'A', pos: [40, 0], chain: 0, axis: 0, dir: [-0.958, 0.286] },
    { lineId: 'B', pos: [26, -13], chain: 1, axis: 3, dir: [0.764, -0.646] },
  ];
  // Each ribbon runs only a few px past its stop, then is elsewhere.
  const segs = new Map<string, Array<[Point, Point]>>([
    ['A', [[[40, 0], [46, -2]]]],
    ['B', [[[26, -13], [31, -17]]]],
  ]);
  const marks = computeDcByNode(new Map([['n', lanes]]), segs).get('n')!.marks;
  for (const m of marks) {
    const near = Math.min(
      ...[...segs.values()].flat().map(([a, b]) => {
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const wx = m.at[0] - a[0], wy = m.at[1] - a[1];
        const vv = vx * vx + vy * vy;
        const t = vv < 1e-12 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
        return Math.sqrt((wx - vx * t) ** 2 + (wy - vy * t) ** 2);
      }),
    );
    assert.ok(near <= REACH + 1e-6, `a mark sits ${near.toFixed(1)}px from any drawn line`);
  }
});

test('a line with no recorded end direction gets no symbol', () => {
  const solved = computeDcByNode(new Map([['n', [{ lineId: 'L0', pos: [0, 0] as Point, chain: 0, terminus: true }]]]));
  assert.equal(solved.get('n')!.ends.length, 0);
});

test('the painter draws the solved tails and symbols', () => {
  const lanes = [ln(0, [0, 0], { axis: 2, dir: [0, 1], terminus: true })];
  const sc: StopScene = {
    nodeId: 'n', lines: lanes, dotRadius: 3, anchor: [0, 0],
    capsule: {
      kind: 'dcMarks',
      marks: [{ at: [0, 0], r: LINE_WIDTH / 2, ring: false, lineId: 'L0' }],
      ends: [{ lineId: 'L0', cut: [0, 20], at: [0, 30] }],
    },
  };
  const g = dc.paint(sc, ctx);
  const t = ticks(g) as Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }>;
  assert.equal(t.length, 2, 'the tail, cased like any other piece of line');
  const [casing, core] = t;
  assert.deepEqual([core.x1, core.y1, core.x2, core.y2], [0, 0, 0, 20], 'the core runs stop to cut');
  assert.equal(core.strokeWidth, +LINE_WIDTH.toFixed(2));
  assert.ok(casing.strokeWidth > core.strokeWidth, 'the casing is the wider of the two');
  assert.ok(casing.y2 > core.y2, 'and wraps the cut rather than stopping flush with it');
  assert.ok(circles(g).some((c) => c.cy === 30 && Math.abs(c.r - BADGE_R) < 1e-9), 'the symbol at the solved seat');
});

test('the tail is cased in the land colour the routes use', () => {
  const lanes = [ln(0, [0, 0], { axis: 2, dir: [0, 1], terminus: true })];
  const sc: StopScene = {
    nodeId: 'n', lines: lanes, dotRadius: 3, anchor: [0, 0],
    capsule: {
      kind: 'dcMarks',
      marks: [{ at: [0, 0], r: LINE_WIDTH / 2, ring: false, lineId: 'L0' }],
      ends: [{ lineId: 'L0', cut: [0, 20], at: [0, 30] }],
    },
  };
  // A colorset supplies its own land, which the theme alone would not give.
  const casing = ticks(dc.paint(sc, { ...ctx, land: '#2b3a2f' }))[0] as { stroke: string };
  assert.equal(casing.stroke, '#2b3a2f');
});

test('the crossing regime is its own, not Toronto\'s', () => {
  assert.equal(dc.capsule, 'dc');
});
