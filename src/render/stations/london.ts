import type { StationDesign, StopScene, StopLine, Glyph, Point } from './types';
import { line } from './primitives';
import { MARK_R0, LINE_WIDTH } from '../constants';

const R0 = MARK_R0;

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

// Unit normal a tick is drawn along: perpendicular to the line, on a single
// consistent side. The tangent sign is arbitrary (it follows the lane's drawn
// direction), so canonicalize it to one half-plane first; then the +90 deg
// rotation always lands on the same side of the line.
function tickNormal(ln: StopLine): Point {
  let [tx, ty] = ln.dir ?? axisTangent(ln.axis);
  if (tx < 0 || (tx === 0 && ty < 0)) { tx = -tx; ty = -ty; }
  return [-ty, tx];
}

/**
 * London: each stopping line is a short tick struck strictly perpendicular to
 * the line, in the route color. An intermediate stop roots the tick on the dot
 * and extends it to one side; a terminus (the line's end) gets a full two-sided
 * tick that caps the line. A loop has no terminus, so all its stops are
 * one-sided. No dot, no capsule; an interchange reads as a row of parallel
 * ticks. A starting point toward the fuller Underground marker vocabulary.
 */
function paint(scene: StopScene): Glyph[] {
  // Tick length scales with the dot so capsule members shorten and the picker
  // preview fills its tile; weight matches the line and is never heavier than
  // it, so bundled ticks and the preview stay clean.
  const len = scene.dotRadius * 2.6;
  const sw = LINE_WIDTH * Math.min(1, scene.dotRadius / R0);
  const g: Glyph[] = [];
  for (const ln of scene.lines) {
    const [nx, ny] = tickNormal(ln);
    const [x, y] = ln.pos;
    // A terminus is capped by a full tick centered on the dot (both sides); an
    // intermediate stop by a one-sided stub rooted on it.
    const x0 = ln.terminus ? x - nx * len : x;
    const y0 = ln.terminus ? y - ny * len : y;
    g.push(line(x0, y0, x + nx * len, y + ny * len, { stroke: ln.color, strokeWidth: sw }));
  }
  return g;
}

export const london: StationDesign = { id: 'london', name: 'London', paint };
