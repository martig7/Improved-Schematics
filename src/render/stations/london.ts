import type { StationDesign, StopScene, StopLine, Glyph, Point } from './types';
import { line, circle } from './primitives';
import { MARK_R0, LINE_WIDTH } from '../constants';

const R0 = MARK_R0;
const INK = '#111111';
const PAPER = '#ffffff';

// Octilinear run-axis (0=-, 1=/, 2=|, 3=\, mod 180 deg) as a fallback tangent
// when the exact one is absent (non-topo path, picker preview). An absent axis
// reads as a horizontal line. sqrt(1/2) as a literal stays byte-identical
// across V8 versions.
const S = 0.7071067811865476;
function axisTangent(axis: number | undefined): Point {
  switch ((((axis ?? 0) % 4) + 4) % 4) {
    case 1: return [S, S];  // \
    case 2: return [0, 1];  // |
    case 3: return [-S, S]; // /
    default: return [1, 0]; // -
  }
}

// Unit normal a tick is drawn along: perpendicular to the line. When the lane's
// outward direction (toward its bundle's outer edge) is known, strike toward it
// so the tick reaches into open space instead of across the co-running lanes;
// pick the perpendicular whose dot with outward is non-negative. Otherwise the
// tangent sign is arbitrary (it follows the lane's drawn direction), so
// canonicalize it to one half-plane first; then the +90 deg rotation always
// lands on the same consistent side of the line.
function tickNormal(ln: StopLine): Point {
  const [tx, ty] = ln.dir ?? axisTangent(ln.axis);
  const out = ln.outward;
  if (out) {
    const n: Point = [-ty, tx];
    return n[0] * out[0] + n[1] * out[1] >= 0 ? n : [-n[0], -n[1]];
  }
  let cx = tx, cy = ty;
  if (cx < 0 || (cx === 0 && cy < 0)) { cx = -cx; cy = -cy; }
  return [-cy, cx];
}

/** Single/terminus stop: a route-color tick struck perpendicular to the line.
 *  Intermediate roots a one-sided stub on the dot; a terminus caps it with a
 *  full two-sided tick. */
function ticks(scene: StopScene): Glyph[] {
  const len = scene.dotRadius * 2.6;
  const sw = LINE_WIDTH * Math.min(1, scene.dotRadius / R0);
  const g: Glyph[] = [];
  for (const ln of scene.lines) {
    const [nx, ny] = tickNormal(ln);
    const [x, y] = ln.pos;
    const x0 = ln.terminus ? x - nx * len : x;
    const y0 = ln.terminus ? y - ny * len : y;
    g.push(line(x0, y0, x + nx * len, y + ny * len, { stroke: ln.color, strokeWidth: sw }));
  }
  return g;
}

/**
 * London: intermediate and terminus stops are route-color ticks struck strictly
 * perpendicular to the line (a one-sided stub, or a full two-sided cap at a
 * line's end). An interchange is a chain of white ticket-hall bubbles: adjacent
 * lines pair into one bubble riding between them (an odd leftover gets its own),
 * joined by connector bars. The bubble geometry is solved at compute time; this
 * only paints it as one seamless white silhouette with a black outline via
 * expand-and-overdraw (every piece fattened in ink, then redrawn in paper).
 */
function paint(scene: StopScene): Glyph[] {
  const cap = scene.capsule;

  if (cap.kind === 'londonBubbles') {
    const bw = LINE_WIDTH * 0.85; // outline rim half-width (a thick Underground ring)
    const g: Glyph[] = [];
    // A connector's butt ends tuck inside the two bubbles it joins, so only its
    // sides show as the waist between beads.
    for (const n of cap.necks) g.push(line(n.x0, n.y0, n.x1, n.y1, { stroke: INK, strokeWidth: n.w + 2 * bw }));
    for (const b of cap.bubbles) g.push(circle(b.x, b.y, b.r + bw, { fill: INK, stroke: 'none', strokeWidth: 0 }));
    for (const n of cap.necks) g.push(line(n.x0, n.y0, n.x1, n.y1, { stroke: PAPER, strokeWidth: n.w }));
    for (const b of cap.bubbles) g.push(circle(b.x, b.y, b.r, { fill: PAPER, stroke: 'none', strokeWidth: 0 }));
    return g;
  }

  return ticks(scene);
}

export const london: StationDesign = { id: 'london', name: 'London', paint, capsule: 'londonBubbles', previewKind: 'onLine' };
