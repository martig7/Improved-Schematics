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
// How far a stub reaches inside and outside the band edge it straddles.
let STUB_IN = LINE_WIDTH * 0.45;
let STUB_OUT = LINE_WIDTH * 0.5;
onDrawScale(() => {
  STOP_OUTER = LINE_WIDTH / 2;
  STOP_RING = LINE_WIDTH * 0.2;
  REACH = LINE_WIDTH * 0.95;
  TICK_W = LINE_WIDTH * 0.22;
  STUB_IN = LINE_WIDTH * 0.45;
  STUB_OUT = LINE_WIDTH * 0.5;
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

/** The single mark's seat on a bundle: the middle lane when the count is odd,
 *  the gap between the two middle lanes when it is even. */
function seat(lines: readonly StopLine[]): Point {
  const ordered = [...lines].sort((a, b) => a.chain - b.chain || (a.lineId < b.lineId ? -1 : 1));
  const n = ordered.length;
  const mid = n >> 1;
  if (n % 2 === 1) return ordered[mid].pos;
  const a = ordered[mid - 1].pos;
  const b = ordered[mid].pos;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** The pair of stubs a bundle stop wears: one straddling each edge of the band,
 *  struck perpendicular to the run so a short length shows OUTSIDE the paint. The
 *  stub is what marks the station across a band too wide for its dot to span; it
 *  does not replace the dot. `half` is the band's half-width. */
function stubs(c: Point, t: Point, half: number): Glyph[] {
  const nx = -t[1];
  const ny = t[0];
  const seg = (side: number): Glyph => {
    const a = half - STUB_IN;
    const b = half + STUB_OUT;
    return {
      kind: 'line',
      x1: +(c[0] + nx * a * side).toFixed(2), y1: +(c[1] + ny * a * side).toFixed(2),
      x2: +(c[0] + nx * b * side).toFixed(2), y2: +(c[1] + ny * b * side).toFixed(2),
      stroke: PAPER, strokeWidth: +TICK_W.toFixed(2),
    };
  };
  return [seg(1), seg(-1)];
}

/** Half-width of the band the lanes form, out to the outer edge of the paint. */
function bandHalf(lines: readonly StopLine[]): number {
  const a = lines[0].pos;
  const b = lines[lines.length - 1].pos;
  return Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) / 2 + STOP_OUTER;
}

/**
 * DC: a plain stop is a black-ringed white circle fitted inside the line.
 *
 * An interchange is read from the geometry rather than the line count. While
 * every lane runs the same way the station is still ONE band of track, so it
 * takes a single mark: one circle seated mid-bundle (on the centre lane, or in
 * the gap between the two middle lanes), with a white stub straddling each edge
 * of the band so a short length shows outside the paint. The stubs are what carry
 * the mark across a band too wide for the circle to span, at any lane count.
 *
 * A station where the lanes point different ways, or where a bundle splits, is a
 * genuine transfer and takes the double ring: an inner circle the size of every
 * other stop, inside an outer ring at the same distance the ticks reach, so the
 * two interchange motifs share one scale.
 */
function paint(scene: StopScene, _ctx: PaintCtx): Glyph[] {
  const lines = scene.lines;
  if (lines.length === 0) return [];

  if (lines.length === 1) {
    const ln = lines[0];
    return disc(ln.pos[0], ln.pos[1], STOP_OUTER, STOP_RING, ln.lineId);
  }

  if (!oneBundle(lines)) {
    // Transfer: double ring, seated on the marker anchor so it reads as one
    // station rather than attaching to any single lane.
    const [cx, cy] = scene.anchor;
    return [
      circle(cx, cy, REACH, { fill: INK, stroke: 'none', strokeWidth: 0 }),
      circle(cx, cy, REACH - STOP_RING, { fill: PAPER, stroke: 'none', strokeWidth: 0 }),
      ...disc(cx, cy, STOP_OUTER, STOP_RING),
    ];
  }

  // One bundle: a single mark seated mid-bundle, with a stub straddling each
  // edge of the band. Stubs are drawn FIRST so the dot sits over them.
  const s = seat(lines);
  return [...stubs(s, tangent(lines[0]), bandHalf(lines)), ...disc(s[0], s[1], STOP_OUTER, STOP_RING)];
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
