// Octilinear layout + render constants, ported verbatim from the game
// (dev/reference/_constants.txt). Do not change values.

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
 *  3.5 (was 5): chosen by the 2026-06-10 spacing sweep on the live Seattle
 *  dump — with grid divisor 1.6 it puts adjacent corridors ~6.6 line-widths
 *  apart (spec target >= 6) and reads closer to LOOM's proportions. */
const LINE_WIDTH_DEFAULT = 3.5;
export const LINE_WIDTH =
  (typeof process !== 'undefined' &&
    Number((process as { env?: Record<string, string> }).env?.IS_LINE_WIDTH)) ||
  LINE_WIDTH_DEFAULT;
export const LINE_GAP = 2;
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
