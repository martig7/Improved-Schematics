import type { StationDesign, StopScene, StopLine, PaintCtx, Glyph, Point } from './types';
import { circle, pillPath, bullet, contrastInk } from './primitives';
import { LINE_WIDTH } from '../constants';
import {
  marksFor, STOP_OUTER, STOP_RING, REACH, CAPSULE_W, TAIL, BADGE_GAP, BADGE_R,
  type DcMark, type DcEnd,
} from '../layout/dcStations';

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

// The routes are drawn on a casing this much wider than the stroke, so the halo
// stands this far proud of the line on every side.
const CASING_EXTRA = 3;

/**
 * The tail: the route colour run from the stop out to the cut, over the ribbon's
 * own rounded end, and cut square (a line glyph caps butt).
 *
 * It carries the route's casing with it. A tail is a piece of line like any other,
 * and without the halo it would run out past where the ribbon's casing stops as a
 * bare colour. The casing runs on half its own margin past the cut, so the halo
 * wraps the end face too and the cut reads as an edge of the line rather than a
 * place the colour simply stops.
 */
function tailGlyphs(ln: StopLine, ep: DcEnd, land: string): Glyph[] {
  const dx = ep.cut[0] - ln.pos[0];
  const dy = ep.cut[1] - ln.pos[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const over = len > 1e-6 ? CASING_EXTRA / 2 / len : 0;
  return [
    {
      kind: 'line',
      x1: +ln.pos[0].toFixed(2), y1: +ln.pos[1].toFixed(2),
      x2: +(ep.cut[0] + dx * over).toFixed(2), y2: +(ep.cut[1] + dy * over).toFixed(2),
      stroke: land, strokeWidth: +(LINE_WIDTH + CASING_EXTRA).toFixed(2),
    },
    {
      kind: 'line',
      x1: +ln.pos[0].toFixed(2), y1: +ln.pos[1].toFixed(2),
      x2: +ep.cut[0].toFixed(2), y2: +ep.cut[1].toFixed(2),
      stroke: ln.color, strokeWidth: +LINE_WIDTH.toFixed(2),
    },
  ];
}

/** The line's own symbol, hanging off the cut: a filled route-colour disc holding
 *  the route bullet, or plain when the route has none. */
function badge(at: Point, ln: StopLine, showBullet: boolean): Glyph[] {
  const g: Glyph[] = [circle(at[0], at[1], BADGE_R, { fill: ln.color, stroke: 'none', strokeWidth: 0, data: { 'data-line': ln.lineId } })];
  if (showBullet && ln.bullet) g.push(bullet(at[0], at[1], ln.bullet, BADGE_R, ln.textColor || contrastInk(ln.color)));
  return g;
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
  const byLine = new Map(scene.lines.map((l) => [l.lineId, l]));

  const land = ctx.land ?? (ctx.dark ? '#18181b' : '#ffffff');
  const g: Glyph[] = [];
  // Tails first, so the station's own marks sit over them. Every casing before
  // every core, as the routes themselves are drawn, so one tail's halo cannot
  // strike through its neighbour.
  const tails = ends.map((ep) => ({ ep, ln: byLine.get(ep.lineId) }))
    .filter((t): t is { ep: DcEnd; ln: StopLine } => !!t.ln)
    .map((t) => tailGlyphs(t.ln, t.ep, land));
  for (const t of tails) g.push(t[0]);
  for (const t of tails) g.push(t[1]);
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
  for (const ep of ends) {
    const ln = byLine.get(ep.lineId);
    if (ln) g.push(...badge([ep.at[0], ep.at[1]], ln, ctx.showBullets));
  }
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
