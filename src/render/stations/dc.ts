import type { StationDesign, StopScene, Glyph } from './types';
import { circle, pillPath } from './primitives';
import {
  marksFor, STOP_OUTER, STOP_RING, REACH, CAPSULE_W,
  type DcMark,
} from '../layout/dcStations';
import { lineEndGlyphs } from './lineEnds';

// Ink on paper in both themes, like the printed WMATA diagram.
const INK = '#111111';
const PAPER = '#ffffff';

/** A black-ringed white disc by overdraw (ink disc, then a smaller paper disc),
 *  so the ring needs no stroke alignment. */
function disc(cx: number, cy: number, outer: number, ring: number, lineId?: string): Glyph[] {
  return [
    circle(cx, cy, outer, { fill: INK, stroke: 'none', strokeWidth: 0 }),
    circle(cx, cy, outer - ring, { fill: PAPER, stroke: 'none', strokeWidth: 0, ...(lineId ? { data: { 'data-line': lineId } } : {}) }),
  ];
}

/** The transfer motif: an inner circle the size of every other stop, inside an
 *  outer ring. */
function doubleRing(cx: number, cy: number): Glyph[] {
  return [
    circle(cx, cy, REACH, { fill: INK, stroke: 'none', strokeWidth: 0 }),
    circle(cx, cy, REACH - STOP_RING, { fill: PAPER, stroke: 'none', strokeWidth: 0 }),
    ...disc(cx, cy, STOP_OUTER, STOP_RING),
  ];
}

/** The station's own geometry when the solved version is absent, as it is for
 *  geometry cached before the solve existed. Marks only: the line-end symbols need
 *  the whole map to seat against, so they are left to the solve. */
function fallbackMarks(scene: StopScene): DcMark[] {
  const cap = scene.capsule;
  if (cap.kind === 'ring') return [{ at: [cap.cx, cap.cy], r: REACH, ring: true }];
  return marksFor(scene.lines, cap.kind === 'pill' ? cap.cross : undefined);
}

/**
 * DC Metro: a plain stop is a black-ringed white circle fitted inside the line.
 *
 * Every other station is marked in pairs of track. Where one mark can stand on
 * every lane the station is a point transfer and takes that mark alone: the double
 * ring, an inner circle the size of every other stop inside an outer ring, seated
 * where the bands meet. Anything wider is drawn as the capsule it is, its spine
 * stroked as one continuous white line with each bundle marked along it, lanes
 * pairing off two at a time under a double ring and a single-ringed stop circle for
 * a lane left over.
 *
 * A terminating line runs on past its stop, is cut square, and hangs its own symbol
 * off the end.
 *
 * The geometry is solved over the whole map rather than here, because a line-end
 * symbol has to keep clear of lines and stations one station's paint cannot see.
 * This only draws it.
 */
function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const cap = scene.capsule;
  const solved = cap.kind === 'dcMarks' ? cap : undefined;
  const marks = solved ? solved.marks : fallbackMarks(scene);
  const ends = solved ? solved.ends : [];
  const spine = solved?.spine ?? (cap.kind === 'pill' ? cap.points : undefined);
  const endGlyphs = lineEndGlyphs(scene.lines, ends, ctx);
  const g: Glyph[] = [];
  // Tails first, so the station's own marks sit over them. Every casing before
  // every core, as the routes themselves are drawn, so one tail's halo cannot
  // strike through its neighbour.
  g.push(...endGlyphs.tailCasings, ...endGlyphs.tailCores);
  // The capsule ties a station's marks together, so it is drawn only when there is
  // more than one to tie.
  if (marks.length > 1 && spine && spine.length >= 2) {
    g.push({
      kind: 'path', d: pillPath(spine.map((p): Point => [p[0], p[1]]), false), fill: 'none',
      stroke: PAPER, strokeWidth: +CAPSULE_W.toFixed(2), lineCap: 'round', lineJoin: 'round',
    });
  }
  for (const m of marks) {
    g.push(...(m.ring ? doubleRing(m.at[0], m.at[1]) : disc(m.at[0], m.at[1], STOP_OUTER, STOP_RING, m.lineId)));
  }
  // Symbols last, over everything this station draws.
  g.push(...endGlyphs.badges);
  return g;
}

export const dc: StationDesign = {
  id: 'dc',
  name: 'DC Metro',
  paint,
  // Its own regime. The crossing solve gives it the exact junction where lines meet
  // at a point, and the station solve gives it every mark and line-end symbol,
  // seated against the whole map. It draws no capsule of its own and crops no
  // lanes: the lines run behind these marks by design.
  capsule: 'dc',
  // The end of a line is this design's most distinctive mark: the cut, and the
  // route's own symbol hanging off it.
  previewKind: 'lineEnd',
};
