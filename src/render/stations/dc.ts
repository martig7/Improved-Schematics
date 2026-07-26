import type { StationDesign, StopScene, StopLine, PaintCtx, Glyph, Point } from './types';
import { circle } from './primitives';
import { LINE_WIDTH, onDrawScale } from '../constants';

// Ink on paper in both themes, like the printed WMATA diagram.
const INK = '#111111';
const PAPER = '#ffffff';

// A plain stop is LINE-FIT: outer diameter equals the route line width, so the
// black-ringed white circle sits inside the line, which runs on behind it.
let STOP_OUTER = LINE_WIDTH / 2;
let STOP_RING = LINE_WIDTH * 0.2;
// How far a tick strikes from the lane centre. This one distance also sets the
// transfer marker's outer ring, so a wide bundle's ticks and a transfer circle
// read at the same scale (the design calls for exactly that correspondence).
let REACH = LINE_WIDTH * 0.95;
let TICK_W = LINE_WIDTH * 0.22;
// How far a stub protrudes past its own lane, on the inward side.
let STUB_PROTRUDE = LINE_WIDTH * 0.5;
onDrawScale(() => {
  STOP_OUTER = LINE_WIDTH / 2;
  STOP_RING = LINE_WIDTH * 0.2;
  REACH = LINE_WIDTH * 0.95;
  TICK_W = LINE_WIDTH * 0.22;
  STUB_PROTRUDE = LINE_WIDTH * 0.5;
});

/** A black-ringed white disc by overdraw (ink disc, then a smaller paper disc),
 *  so the ring needs no stroke alignment. */
function disc(cx: number, cy: number, outer: number, ring: number, lineId?: string): Glyph[] {
  return [
    circle(cx, cy, outer, { fill: INK, stroke: 'none', strokeWidth: 0 }),
    circle(cx, cy, outer - ring, { fill: PAPER, stroke: 'none', strokeWidth: 0, ...(lineId ? { data: { 'data-line': lineId } } : {}) }),
  ];
}

/** Unit tangent for a stop, falling back to the octilinear axis when the exact
 *  one is absent, and to horizontal when even that is unknown. */
function tangent(ln: StopLine): Point {
  if (ln.dir) return ln.dir;
  const a = ln.axis ?? 0;
  // axis: 0 = -, 1 = /, 2 = |, 3 = \  (mod 180 degrees)
  const k = Math.SQRT1_2;
  return a === 0 ? [1, 0] : a === 1 ? [k, -k] : a === 2 ? [0, 1] : [k, k];
}

/** Do these stops run as ONE bundle? True when every lane shares a direction, so
 *  the station sits on a single band of parallel track. Tangents are compared by
 *  |dot| because a tangent is only defined up to sign (mod 180 degrees), and the
 *  octilinear axis alone is too coarse: two lanes can share an axis yet diverge
 *  where a bundle splits, which the design wants treated as a transfer. */
function oneBundle(lines: readonly StopLine[]): boolean {
  if (lines.length < 2) return true;
  const t0 = tangent(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i].axis ?? -1) !== (lines[0].axis ?? -1)) return false;
    const t = tangent(lines[i]);
    // cos 15 degrees; anything blunter than this is a split, not a shared run.
    if (Math.abs(t0[0] * t[0] + t0[1] * t[1]) < 0.966) return false;
  }
  return true;
}

/** Lanes in band order. */
function ordered(lines: readonly StopLine[]): StopLine[] {
  return [...lines].sort((a, b) => a.chain - b.chain || (a.lineId < b.lineId ? -1 : 1));
}

/** The lanes the dot itself covers: the middle one when the count is odd, the two
 *  middle ones when it is even (the dot seats in the gap and bridges both). These
 *  are already marked by the dot, so they take no stub, which is why a two-lane
 *  bundle wears none at all. */
function bridged(n: number): [number, number] {
  const mid = n >> 1;
  return n % 2 === 1 ? [mid, mid] : [mid - 1, mid];
}

/** The single mark's seat: on the middle lane, or in the gap between the two. */
function seat(lines: readonly StopLine[]): Point {
  const ord = ordered(lines);
  const [i, j] = bridged(ord.length);
  const a = ord[i].pos;
  const b = ord[j].pos;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Where the crossing bundles actually meet.
 *
 * Each direction present is one band of track; its centreline runs through the
 * mean of its lanes, so for a two-lane bundle that line passes BETWEEN the pair
 * rather than along either rail. Intersecting the two centrelines puts the mark
 * at the true crossing, centred in both bands. The station anchor will not do:
 * it sits on a lane, so the ring lands on one line instead of at the junction.
 *
 * Falls back to the centroid of every lane when the bands are near-parallel (no
 * usable intersection), which is still the middle of the cluster.
 */
function crossing(lines: readonly StopLine[]): Point {
  const byAxis = new Map<number, StopLine[]>();
  for (const ln of lines) {
    const k = ln.axis ?? -1;
    const arr = byAxis.get(k);
    if (arr) arr.push(ln);
    else byAxis.set(k, [ln]);
  }
  const mean = (ls: readonly StopLine[]): Point => {
    let x = 0, y = 0;
    for (const l of ls) { x += l.pos[0]; y += l.pos[1]; }
    return [x / ls.length, y / ls.length];
  };
  const groups = [...byAxis.keys()].sort((a, b) => a - b).map((k) => byAxis.get(k)!);
  if (groups.length >= 2) {
    const p = mean(groups[0]);
    const d = tangent(groups[0][0]);
    const q = mean(groups[1]);
    const e = tangent(groups[1][0]);
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) > 1e-6) {
      const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
      return [p[0] + d[0] * t, p[1] + d[1] * t];
    }
  }
  return mean(lines);
}

/** A stub for one lane: struck perpendicular to the run, crossing its own lane and
 *  protruding on the INWARD side, toward the band's centreline. Every lane the dot
 *  does not already cover gets one, so the whole interchange is marked. */
function stub(p: Point, t: Point, inward: Point): Glyph {
  const nx = -t[1];
  const ny = t[0];
  // Sign the perpendicular so it points inward for THIS lane.
  const sgn = nx * inward[0] + ny * inward[1] >= 0 ? 1 : -1;
  const ox = -nx * sgn * STOP_OUTER;
  const oy = -ny * sgn * STOP_OUTER;
  const ix = nx * sgn * (STOP_OUTER + STUB_PROTRUDE);
  const iy = ny * sgn * (STOP_OUTER + STUB_PROTRUDE);
  return {
    kind: 'line',
    x1: +(p[0] + ox).toFixed(2), y1: +(p[1] + oy).toFixed(2),
    x2: +(p[0] + ix).toFixed(2), y2: +(p[1] + iy).toFixed(2),
    stroke: PAPER, strokeWidth: +TICK_W.toFixed(2),
  };
}

/**
 * DC: a plain stop is a black-ringed white circle fitted inside the line.
 *
 * An interchange is read from the geometry rather than the line count. While
 * every lane runs the same way the station is still ONE band of track, so it
 * takes a single mark: one circle seated mid-bundle (on the centre lane, or in
 * the gap between the two middle lanes), plus a white stub on every OTHER lane,
 * struck perpendicular and protruding inward toward the band's centreline. The
 * stubs carry the mark across a band too wide for the circle to span; the lanes
 * the circle already covers take none, so a two-lane bundle wears no stubs.
 *
 * A station where the lanes point different ways, or where a bundle splits, is a
 * genuine transfer and takes the double ring: an inner circle the size of every
 * other stop, inside an outer ring. It seats where the crossing bands' centrelines
 * meet, so it lands at the junction and centred in each band, rather than on
 * whichever single lane the station anchor happens to sit on.
 */
function paint(scene: StopScene, _ctx: PaintCtx): Glyph[] {
  const lines = scene.lines;
  if (lines.length === 0) return [];

  if (lines.length === 1) {
    const ln = lines[0];
    return disc(ln.pos[0], ln.pos[1], STOP_OUTER, STOP_RING, ln.lineId);
  }

  if (!oneBundle(lines)) {
    // Transfer: double ring, seated where the bands actually cross so it reads as
    // one junction rather than a mark sitting on whichever lane the anchor took.
    const [cx, cy] = crossing(lines);
    return [
      circle(cx, cy, REACH, { fill: INK, stroke: 'none', strokeWidth: 0 }),
      circle(cx, cy, REACH - STOP_RING, { fill: PAPER, stroke: 'none', strokeWidth: 0 }),
      ...disc(cx, cy, STOP_OUTER, STOP_RING),
    ];
  }

  // One bundle: a single mark seated mid-bundle, plus a stub on every lane the
  // mark does not already cover. Stubs are drawn FIRST so the dot sits over them.
  const ord = ordered(lines);
  const s = seat(ord);
  const t = tangent(ord[0]);
  const [bi, bj] = bridged(ord.length);
  const g: Glyph[] = [];
  for (let i = 0; i < ord.length; i++) {
    if (i === bi || i === bj) continue; // already marked by the dot
    const p = ord[i].pos;
    // Inward is simply the direction from this lane back to the seated mark.
    const dx = s[0] - p[0];
    const dy = s[1] - p[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) continue;
    g.push(stub(p, t, [dx / len, dy / len]));
  }
  g.push(...disc(s[0], s[1], STOP_OUTER, STOP_RING));
  return g;
}

export const dc: StationDesign = {
  id: 'dc',
  name: 'Washington',
  paint,
  // Pill seating gives the lanes their chained order along the band, which is
  // what `seat` reads; the design draws no capsule of its own.
  capsule: 'pill',
  previewKind: 'interchange',
};
