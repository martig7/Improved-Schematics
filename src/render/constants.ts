import { envNum } from '../env';
// Octilinear layout + render constants, ported verbatim from the game
// (dev/reference/_constants.txt). Values must match the source. Do not change them.

export const STEP_SIZE = 3;
export const TARGET_EDGE_CELLS = 2.2;
export const EDGE_STIFFNESS = 0.18;
export const ITERATIONS = 80;
export const REPULSE_MIN_CELLS = 1.6;
export const REPULSE_STRENGTH = 0.6;
export const BEND_STIFFNESS = 0.12;
export const MAX_STEP_PER_ITER = 0.6;

export const CELL_PX = 36;
/** Diagnostic override for the corridor-spacing sweep (IS_LINE_WIDTH env);
 *  the literal default is the production value. Browser-safe guard: process
 *  is undefined inside the game's renderer.
 *  The default is tuned so adjacent corridors sit at least the spec target of
 *  6 line-widths apart. */
const LINE_WIDTH_DEFAULT = 3.5;
export const LINE_WIDTH =
  (typeof process !== 'undefined' &&
    envNum('IS_LINE_WIDTH')) ||
  LINE_WIDTH_DEFAULT;
export const LINE_GAP = 2;

/** Base station-marker (dot) radius, shared by the octilinear renderer, the
 *  station placement/primitive geometry, and label collision boxes so every
 *  site sizes the marker identically. Derived from the line width. */
export const MARK_R0 = LINE_WIDTH * 0.7;

/** Octilinear grid divisor selected by graph regime. Metro-scale graphs
 *  (<= 800 support edges) use a finer grid (1.6) so parallel corridors read as
 *  separate lines; larger bus-scale graphs use a coarser grid (1.2) that forces
 *  clean radial fans and stays fast. The OCTI_DIVISOR dev override applies here
 *  so the pre-warp contraction-oracle estimate and the real cell-size grid use
 *  the SAME divisor during tuning sweeps.
 *  @param edgeCount support edge count, or its pre-warp proxy (graph edge count).
 *  @returns the divisor for cellSize = max(12, medianEdgeLen / divisor). */
export function regimeDivisor(edgeCount: number): number {
  return envNum('OCTI_DIVISOR') || (edgeCount > 800 ? 1.2 : 1.6);
}

/** Capsule markers render at this fraction of full radius so bullet rings
 *  inside a capsule clear each other. SHARED so the rigid-row solver's
 *  intra-capsule gap floor (renderOctilinear) uses the SAME scale the markers
 *  are drawn at. Flooring at the full radius would box stations whose scaled
 *  rings actually clear.
 *  IS_MARKER_SCALE overrides (1 = no shrink). Browser-safe: process is
 *  undefined inside the game renderer. */
export const MARKER_SCALE = (() => {
  const env =
    envNum('IS_MARKER_SCALE');
  return Number.isFinite(env) && env > 0 ? env : 0.65;
})();

export const PAD = 24;
export const LABEL_FONT_SIZE = 11;
export const LABEL_CHAR_WIDTH = 6;
export const LABEL_OFFSET = 12;

export type Vec2 = [number, number];

/** 8 integer octilinear directions (E, NE, N, …). */
export const OCT_DIRS: Vec2[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** Unit-length versions of OCT_DIRS (diagonals scaled by SQRT1_2). */
export const OCT_UNIT: Vec2[] = OCT_DIRS.map(([x, y]) => {
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len] as Vec2;
});
