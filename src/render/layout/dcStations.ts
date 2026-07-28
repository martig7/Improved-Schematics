/**
 * DC Metro station geometry, solved over the whole map.
 *
 * Where a station's marks go depends only on its own lanes, but where a line-end
 * symbol goes does not: it has to keep clear of every drawn line and of every other
 * station's marks and symbols. A painter is handed one station at a time and can
 * never see that, so both are solved here, once, with the finished ribbons in hand.
 *
 * The design in one paragraph. A lone stop is a small ringed circle. A station one
 * mark can stand on is a double ring at that point. Anything wider is a capsule:
 * its spine drawn as a line, and along it each bundle marked on its own, lanes
 * pairing off two at a time under a double ring with a plain stop circle for a lane
 * left over. A terminating line runs on past its stop, is cut square, and hangs its
 * own symbol off the end.
 */
import { LINE_WIDTH, LINE_GAP, onDrawScale } from '../constants';
import type { Pixel } from './types';

// A plain stop is LINE-FIT: outer diameter equals the route line width, so the
// black-ringed white circle sits inside the line, which runs on behind it.
export let STOP_OUTER = LINE_WIDTH / 2;
export let STOP_RING = LINE_WIDTH * 0.2;
// The transfer marker's outer ring, and so also how far a mark reaches.
export let REACH = LINE_WIDTH * 0.95;
// The white capsule line along a wide station's spine.
export let CAPSULE_W = LINE_WIDTH * 0.3;
// How far a terminating line runs on past its stop before it is cut: clear of the
// widest mark a station wears, plus half a line width so the cut does not crowd it.
export let TAIL = REACH + LINE_WIDTH * 0.5;
// Paper between the cut and the line's own symbol, and the symbol's size.
export let BADGE_GAP = LINE_WIDTH * 0.45;
export let BADGE_R = LINE_WIDTH * 0.85;
// How far a mark may sit from a stop it speaks for. Matches the tolerance the
// crossing solve allows a crossing dot to slide from its stops.
let MAX_SLIDE = (LINE_WIDTH + LINE_GAP) * 3.5;
onDrawScale(() => {
  STOP_OUTER = LINE_WIDTH / 2;
  STOP_RING = LINE_WIDTH * 0.2;
  REACH = LINE_WIDTH * 0.95;
  CAPSULE_W = LINE_WIDTH * 0.3;
  TAIL = REACH + LINE_WIDTH * 0.5;
  BADGE_GAP = LINE_WIDTH * 0.45;
  BADGE_R = LINE_WIDTH * 0.85;
  MAX_SLIDE = (LINE_WIDTH + LINE_GAP) * 3.5;
});

// cos 15 degrees: the widest two lanes may differ and still count as running
// together. Anything blunter is a separate direction, not a shared run.
const PARALLEL = 0.966;

/** The lane fields the solve reads. StopMark satisfies it. */
export interface DcLane {
  lineId: string;
  pos: Pixel;
  chain?: number;
  axis?: number;
  dir?: Pixel;
  terminus?: boolean;
  end?: Pixel;
}

/** One mark of a station: where it stands, how far its ink reaches, and whether it
 *  is the interchange ring or the plain stop circle. */
export interface DcMark { at: Pixel; r: number; ring: boolean; lineId?: string }

/** A line end: where its tail is cut, and where its symbol hangs off. */
export interface DcEnd { lineId: string; cut: Pixel; at: Pixel }

/** Everything the painter draws at one station. */
export interface DcStation { marks: DcMark[]; ends: DcEnd[]; spine?: Pixel[] }

/** Does this point sit on a line's drawn ink? Absent where the drawn ribbons are
 *  not to hand, and the solve then trusts the tangents alone. */
export type OnInk = (lineId: string, p: Pixel) => boolean;

/** Unit tangent for a stop, falling back to the octilinear axis when the exact one
 *  is absent, and to horizontal when even that is unknown. */
function tangent(ln: DcLane): Pixel {
  if (ln.dir) return ln.dir;
  const a = ln.axis ?? 0;
  // axis: 0 = -, 1 = /, 2 = |, 3 = \  (mod 180 degrees)
  const k = Math.SQRT1_2;
  return a === 0 ? [1, 0] : a === 1 ? [k, -k] : a === 2 ? [0, 1] : [k, k];
}

/** Lanes in capsule order. */
function ordered(lines: readonly DcLane[]): DcLane[] {
  return [...lines].sort((a, b) => (a.chain ?? 0) - (b.chain ?? 0) || (a.lineId < b.lineId ? -1 : 1));
}

/** Lanes of one direction in ACROSS-band order, so consecutive entries are
 *  neighbouring rails. The capsule order will not do: it follows the spine along
 *  the station, and where two lanes share a place in the chain it can put
 *  non-adjacent rails next to each other, which then get marked as if they were a
 *  pair. */
function railOrder(band: readonly DcLane[]): DcLane[] {
  const t = tangent(band[0]);
  const rail = (l: DcLane): number => l.pos[0] * -t[1] + l.pos[1] * t[0];
  return [...band].sort((a, b) => rail(a) - rail(b) || (a.lineId < b.lineId ? -1 : 1));
}

/** Mean position of a set of lanes. */
function mean(ls: readonly DcLane[]): Pixel {
  let x = 0, y = 0;
  for (const l of ls) { x += l.pos[0]; y += l.pos[1]; }
  return [x / ls.length, y / ls.length];
}

/** The lanes split into parallel classes, in the order given. The octilinear axis
 *  is too coarse to group by on its own: two runs can share an axis and still point
 *  far enough apart to be separate bands, and two runs on different axes can still
 *  cross at a point one mark serves. Only the exact tangent decides. */
function classes(lines: readonly DcLane[]): DcLane[][] {
  const out: DcLane[][] = [];
  for (const ln of lines) {
    const t = tangent(ln);
    const cls = out.find((c) => {
      const u = tangent(c[0]);
      return Math.abs(u[0] * t[0] + u[1] * t[1]) >= PARALLEL;
    });
    if (cls) cls.push(ln);
    else out.push([ln]);
  }
  return out;
}

/**
 * Does a mark at (x, y) sit ON this lane, so the lane is already marked by it?
 *
 * Measured ACROSS the lane, not along it: a lane's dot may have slid some way down
 * the run, but a reader following that line still meets any mark standing on it.
 *
 * A TERMINUS is the exception. Its track stops at its stop, so there is nothing for
 * a mark to stand on further along the run: a mark placed past the end sits in open
 * space while the line visibly stops short of it.
 */
function onLane(ln: DcLane, x: number, y: number, onInk?: OnInk): boolean {
  const t = tangent(ln);
  if (Math.abs((x - ln.pos[0]) * -t[1] + (y - ln.pos[1]) * t[0]) > REACH) return false;
  if (ln.terminus && Math.abs((x - ln.pos[0]) * t[0] + (y - ln.pos[1]) * t[1]) > REACH) return false;
  // And it has to sit on the line as DRAWN. A tangent is only true at the stop, so
  // following it along a run that bends lands a mark well off the ink; two such
  // tangents can meet at a point that is on neither line.
  return !onInk || onInk(ln.lineId, [x, y]);
}

/** How far apart two rails of one band run, measured across the band. */
function railGap(a: DcLane, b: DcLane, t: Pixel): number {
  return Math.abs((b.pos[0] - a.pos[0]) * -t[1] + (b.pos[1] - a.pos[1]) * t[0]);
}

/**
 * Can one mark seated between these two rails stand on both? This is the whole
 * question the design asks of a pair of tracks.
 *
 * Across the band, the mark has to reach both strokes from the middle.
 *
 * Along the run, the two stops have to be within the mark's own reach of each
 * other. Lanes laid out across a run that is not square to the grid always pick up
 * a little offset along it, which is harmless. But when one lane's stop is further
 * down its track than the other's by more than the mark spans, their midpoint lands
 * somewhere neither of them stops, and a lane that ends around there leaves the
 * mark standing in open space.
 */
function spans(a: DcLane, b: DcLane, t: Pixel): boolean {
  if (railGap(a, b, t) / 2 > REACH + LINE_WIDTH / 2) return false;
  const along = Math.abs((b.pos[0] - a.pos[0]) * t[0] + (b.pos[1] - a.pos[1]) * t[1]);
  return along <= REACH;
}

/**
 * Every place one mark for the whole station could stand: where two directions
 * cross, or on a lane's own dot.
 *
 * A crossing takes the bands' CENTRELINES, a centreline running through the mean of
 * its lanes, so a mark between a pair of co-running lanes still lands on the line
 * that crosses them, centred in both bands. Crossings come first, since a junction
 * is where a transfer mark belongs.
 *
 * Candidates landing away from the station are dropped: any two runs that are not
 * exactly parallel meet somewhere, and for near-parallel ones that meeting lies far
 * out along their extensions, nowhere near the stops.
 */
function candidates(lines: readonly DcLane[]): Pixel[] {
  const ord = ordered(lines);
  const out: Pixel[] = [];
  const push = (p: Pixel): void => {
    const atStation = ord.some((ln) =>
      (p[0] - ln.pos[0]) ** 2 + (p[1] - ln.pos[1]) ** 2 <= MAX_SLIDE * MAX_SLIDE);
    if (!atStation) return;
    if (out.some((q) => Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6)) return;
    out.push(p);
  };
  const cls = classes(ord);
  for (let i = 0; i < cls.length; i++) {
    for (let j = i + 1; j < cls.length; j++) {
      const p = mean(cls[i]);
      const d = tangent(cls[i][0]);
      const q = mean(cls[j]);
      const e = tangent(cls[j][0]);
      const den = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(den) < 1e-6) continue;
      const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
      push([p[0] + d[0] * t, p[1] + d[1] * t]);
    }
  }
  for (const ln of ord) push([ln.pos[0], ln.pos[1]]);
  return out;
}

/** The one point standing on every lane, or undefined. A station is wide exactly
 *  when none exists: no single mark can be placed to speak for all of it. */
function pointMark(lines: readonly DcLane[], onInk?: OnInk): Pixel | undefined {
  for (const c of candidates(lines)) {
    if (lines.every((ln) => onLane(ln, c[0], c[1], onInk))) return c;
  }
  return undefined;
}

/**
 * The marks along a wide station.
 *
 * Each bundle is marked on its own, never pooled with the next: its lanes pair off
 * two at a time ACROSS the band, and each pair takes a double ring seated between
 * the two rails. A lane left over takes the plain stop circle on itself. So a
 * three-lane bundle beside a five-lane one reads as a double and a single, then two
 * doubles and a single.
 *
 * Two rails only pair when a mark between them would reach both. Lanes of one
 * direction are not always neighbours: a bundle can hold two separate runs, and
 * pairing across that gap would leave a ring stranded in the space between them.
 */
function wideMarks(lines: readonly DcLane[]): DcMark[] {
  const out: DcMark[] = [];
  for (const band of classes(ordered(lines))) {
    const rails = railOrder(band);
    const t = tangent(rails[0]);
    for (let i = 0; i < rails.length;) {
      const a = rails[i];
      const b = rails[i + 1];
      if (b && spans(a, b, t)) {
        out.push({ at: [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2], r: REACH, ring: true });
        i += 2;
      } else {
        out.push({ at: [a.pos[0], a.pos[1]], r: STOP_OUTER, ring: false });
        i += 1;
      }
    }
  }
  return out;
}

/** Every mark one station wears. */
export function marksFor(lines: readonly DcLane[], cross?: Pixel, onInk?: OnInk): DcMark[] {
  if (lines.length === 0) return [];
  if (lines.length === 1) {
    const ln = lines[0];
    return [{ at: [ln.pos[0], ln.pos[1]], r: STOP_OUTER, ring: false, lineId: ln.lineId }];
  }
  // The crossing solve runs over the drawn ribbons, so it beats anything re-derived
  // from the seated dots; take it whenever it does stand on every lane.
  if (cross && lines.every((ln) => onLane(ln, cross[0], cross[1], onInk))) return [{ at: cross, r: REACH, ring: true }];
  const point = pointMark(lines, onInk);
  if (point) return [{ at: point, r: REACH, ring: true }];
  return wideMarks(lines);
}

// Where a symbol may be tried: extra distance along the end, and offset across it,
// both in symbol radii. Stepping ASIDE costs five times what moving further out
// along the line does, so a symbol stays on its line's axis wherever it can.
const SIDE_COST = 5;
const BADGE_TRIES: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [];
  for (let s = 0; s <= 6; s++) for (let k = -3; k <= 3; k++) out.push([s, k * 1.6]);
  return out.sort((a, b) => (a[0] + SIDE_COST * Math.abs(a[1])) - (b[0] + SIDE_COST * Math.abs(b[1]))
    || a[0] - b[0] || a[1] - b[1]);
})();

/** Squared distance from a point to a segment. */
function distToSeg2(p: Pixel, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const vv = vx * vx + vy * vy;
  const t = vv < 1e-12 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  return (wx - vx * t) ** 2 + (wy - vy * t) ** 2;
}

/**
 * Solve every station's marks, and seat every line end's symbol.
 *
 * Marks come first, all of them, because a symbol has to keep clear of marks
 * anywhere on the map, not just its own station's. Symbols are then seated one at a
 * time against everything already placed: the marks, the drawn lines, the tails,
 * and the symbols before them. Where nothing is clear a symbol takes its first
 * choice, since a symbol that is there to be read beats no symbol at all.
 */
export function computeDcByNode(
  stops: Map<string, DcLane[]>,
  segsByLine?: Map<string, Array<[Pixel, Pixel]>>,
  crossByNode?: Map<string, { cx: number; cy: number }>,
): Map<string, DcStation> {
  const out = new Map<string, DcStation>();
  const nodes = [...stops.keys()].sort();

  // A mark stands on a line when that line's drawn course runs through it. Held to
  // the mark's own radius, so a mark centred between a band's two rails still counts
  // as standing on both, while one out on a tangent's extension does not.
  const onInk: OnInk | undefined = segsByLine
    ? (lineId, p) => {
      const segs = segsByLine.get(lineId);
      if (!segs || segs.length === 0) return true; // no ink recorded: cannot rule it out
      const lim = REACH * REACH;
      for (const [a, b] of segs) if (distToSeg2(p, a, b) <= lim) return true;
      return false;
    }
    : undefined;

  // Every mark on the map, and every tail, as obstacles.
  const taken: Array<{ at: Pixel; r: number }> = [];
  const tails: Array<{ key: string; a: Pixel; b: Pixel }> = [];
  for (const nodeId of nodes) {
    const lines = stops.get(nodeId)!;
    if (lines.length === 0) { out.set(nodeId, { marks: [], ends: [] }); continue; }
    const c = crossByNode?.get(nodeId);
    const marks = marksFor(lines, c ? [c.cx, c.cy] : undefined, onInk);
    out.set(nodeId, { marks, ends: [] });
    for (const m of marks) taken.push({ at: m.at, r: m.r });
    for (const ln of lines) {
      if (!ln.end) continue;
      tails.push({ key: nodeId + '|' + ln.lineId, a: [ln.pos[0], ln.pos[1]], b: [ln.pos[0] + ln.end[0] * TAIL, ln.pos[1] + ln.end[1] * TAIL] });
    }
  }

  // `own` names the end being seated: its own tail is what the symbol hangs off, so
  // the deliberate gap between them is not a collision, and its own line's ribbon
  // runs right up to that tail.
  const blocked = (p: Pixel, own: string, ownLine: string): boolean => {
    for (const q of taken) {
      if ((p[0] - q.at[0]) ** 2 + (p[1] - q.at[1]) ** 2 < (BADGE_R + q.r) ** 2) return true;
    }
    const clear2 = (BADGE_R + LINE_WIDTH / 2) ** 2;
    for (const t of tails) if (t.key !== own && distToSeg2(p, t.a, t.b) < clear2) return true;
    if (segsByLine) {
      for (const [lineId, segs] of segsByLine) {
        if (lineId === ownLine) continue;
        for (const [a, b] of segs) if (distToSeg2(p, a, b) < clear2) return true;
      }
    }
    return false;
  };

  for (const nodeId of nodes) {
    const station = out.get(nodeId)!;
    for (const ln of ordered(stops.get(nodeId)!)) {
      const e = ln.end;
      if (!e) continue;
      const cut: Pixel = [ln.pos[0] + e[0] * TAIL, ln.pos[1] + e[1] * TAIL];
      const nx = -e[1];
      const ny = e[0];
      let at: Pixel | undefined;
      for (const [step, side] of BADGE_TRIES) {
        const d = BADGE_GAP + BADGE_R + step * BADGE_R;
        const p: Pixel = [cut[0] + e[0] * d + nx * side * BADGE_R, cut[1] + e[1] * d + ny * side * BADGE_R];
        if (blocked(p, nodeId + '|' + ln.lineId, ln.lineId)) continue;
        at = p;
        break;
      }
      if (!at) at = [cut[0] + e[0] * (BADGE_GAP + BADGE_R), cut[1] + e[1] * (BADGE_GAP + BADGE_R)];
      taken.push({ at, r: BADGE_R });
      station.ends.push({ lineId: ln.lineId, cut, at });
    }
  }
  return out;
}
