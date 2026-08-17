import type { StationDesign, StopScene, PaintCtx, Glyph } from './types';
import { circle, capsuleGlyphs, capsuleStrokeWidths, pillPath } from './primitives';
import { STATION_WIDTH, MARK_R0, MARKER_SCALE, onRenderScale } from '../constants';

// Fixed paper-map palette: black ink on white paper in both themes.
const INK = '#111111';
const PAPER = '#ffffff';

// A plain stop uses the station-width unit independently from the route line
// running continuously behind it.
let STOP_OUTER = STATION_WIDTH / 2;
let STOP_RING = STATION_WIDTH * 0.2;

// A crossing dot is INTERCHANGE-SIZED: the same cross-section as a capsule end
// (its outer/inner radii are the capsule's border/fill half-widths), so a
// perfect intersection reads as a one-station interchange, not a plain stop.
let CAP_W = capsuleStrokeWidths(MARK_R0 * MARKER_SCALE);
let MARK_OUTER = CAP_W.border / 2;
let MARK_RING = (CAP_W.border - CAP_W.fill) / 2;

// The interchange motif is a solid black dot: a bundle chains one per station
// inside a white capsule joined by a thin black spine along the capsule's own
// centerline; a perfect crossing collapses to a single dot in a white circle.
let DOT_R = STATION_WIDTH * 0.42;
let CONNECTOR_W = STATION_WIDTH * 0.5;
onRenderScale(() => {
  STOP_OUTER = STATION_WIDTH / 2;
  STOP_RING = STATION_WIDTH * 0.2;
  CAP_W = capsuleStrokeWidths(MARK_R0 * MARKER_SCALE);
  MARK_OUTER = CAP_W.border / 2;
  MARK_RING = (CAP_W.border - CAP_W.fill) / 2;
  DOT_R = STATION_WIDTH * 0.42;
  CONNECTOR_W = STATION_WIDTH * 0.5;
});

/** A black-ringed white disc via expand-and-overdraw (an ink disc, then a
 *  smaller paper disc), so the ring needs no stroke alignment. */
function disc(cx: number, cy: number, outer: number, ring: number): Glyph[] {
  return [
    circle(cx, cy, outer, { fill: INK, stroke: 'none', strokeWidth: 0 }),
    circle(cx, cy, outer - ring, { fill: PAPER, stroke: 'none', strokeWidth: 0 }),
  ];
}

const dot = (cx: number, cy: number, lineId?: string): Glyph =>
  circle(cx, cy, DOT_R, { fill: INK, stroke: 'none', strokeWidth: 0, ...(lineId ? { data: { 'data-line': lineId } } : {}) });

/**
 * Toronto: a plain stop is a blank black-ringed white circle embedded in the
 * line. An interchange is a white capsule with a black border (a wide pill, or
 * a single circle where lines cross at a point) holding one solid black dot per
 * station, joined by a thin black spine. The capsule geometry is design-agnostic
 * (pill / ring from placement); this only chooses the paper-map colours and
 * lays the dots and spine over the white fill.
 */
function paint(scene: StopScene, _ctx: PaintCtx): Glyph[] {
  const cap = scene.capsule;

  if (cap.kind === 'pill') {
    // White pill, black border, then a black dot per station joined by a spine
    // that traces the capsule's OWN centerline (not the shortest path between
    // dots), so the join never leaks outside the pill.
    const g: Glyph[] = capsuleGlyphs(cap, { border: INK, fill: PAPER }, scene.dotRadius);
    if (cap.points.length >= 2) g.push({ kind: 'path', d: pillPath(cap.points, cap.smooth), fill: 'none', stroke: INK, strokeWidth: +CONNECTOR_W.toFixed(1), lineCap: 'round', lineJoin: 'round' });
    for (const ln of scene.lines) g.push(dot(ln.pos[0], ln.pos[1], ln.lineId));
    return g;
  }

  if (cap.kind === 'ring') {
    // A perfect crossing: one white circle sized like a one-station capsule,
    // with a single black dot.
    return [...disc(cap.cx, cap.cy, MARK_OUTER, MARK_RING), dot(cap.cx, cap.cy)];
  }

  // Single stop: a blank line-fit circle embedded in the line.
  const g: Glyph[] = [];
  for (const ln of scene.lines) g.push(...disc(ln.pos[0], ln.pos[1], STOP_OUTER, STOP_RING));
  return g;
}

export const toronto: StationDesign = { id: 'toronto', name: 'Toronto', paint, capsule: 'toronto', previewKind: 'interchange' };
