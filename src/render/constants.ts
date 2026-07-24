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
const BASE_LINE_WIDTH =
  (typeof process !== 'undefined' &&
    envNum('IS_LINE_WIDTH')) ||
  LINE_WIDTH_DEFAULT;
const BASE_LINE_GAP = 2;

/** Drawn line/marker chrome sizes. These are LIVE bindings (`let`, not `const`)
 *  so the per-render Line-size control can scale every stroke, marker and
 *  derived spacing together via setDrawScale below. ES module live bindings
 *  mean importers that READ these at call time see the current value; a few
 *  modules that aliased them at import were changed to read live too. */
export let LINE_WIDTH = BASE_LINE_WIDTH;
export let LINE_GAP = BASE_LINE_GAP;

/** Base station-marker (dot) radius, shared by the octilinear renderer, the
 *  station placement/primitive geometry, and label collision boxes so every
 *  site sizes the marker identically. Derived from the line width. */
export let MARK_R0 = LINE_WIDTH * 0.7;

/** The current draw scale k (1 = base). A live binding for the few chrome
 *  dimensions that are FIXED-px offsets — capsule border padding, ring-capsule
 *  radius margin and outline, dot-marker outline — rather than multiples of
 *  LINE_WIDTH / MARK_R0. Multiplying those offsets by this makes them thin and
 *  thicken with the Line-size control too, so a capsule stays proportional
 *  instead of keeping a fixed rim as its dots shrink. */
export let DRAW_SCALE = 1;

/** Scale the drawn line/marker chrome by `s` (1 = base size, the shipped
 *  values). Set at the start of a render from the Line-size option, so both the
 *  precompute (seating/capsule geometry) and the draw (strokes/markers) size
 *  themselves identically. Deterministic: callers pass the option value, never
 *  wall-clock. `s <= 0` or non-finite is treated as 1. */
const _drawScaleCbs: Array<() => void> = [];
/** Register a callback that recomputes a module's LINE_WIDTH/MARK_R0-derived
 *  values. Modules that alias these at import (so their value would otherwise be
 *  frozen at the base scale) call this with a recompute closure; it also runs
 *  the closure once immediately to initialize. Fired on every setDrawScale so
 *  cascading derivations stay in sync with the current chrome scale. */
export function onDrawScale(cb: () => void): void {
  _drawScaleCbs.push(cb);
  cb();
}
export function setDrawScale(s: number): void {
  const k = Number.isFinite(s) && s > 0 ? s : 1;
  DRAW_SCALE = k;
  LINE_WIDTH = BASE_LINE_WIDTH * k;
  LINE_GAP = BASE_LINE_GAP * k;
  MARK_R0 = LINE_WIDTH * 0.7;
  for (const cb of _drawScaleCbs) cb();
}

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

/** Scale-aware refinement of the grid divisor. On geographically large networks
 *  the median station spacing (in real meters) is long, so the base cell is
 *  coarse in real terms and grid snapping can push a coastal station across the
 *  shoreline into the water. When the geographic median edge exceeds `refMeters`,
 *  raise the divisor proportionally so the cell stays near a target real-world
 *  size, bounded by `dmax` so a huge network cannot explode the cell count (which
 *  drives routing cost). Networks at or below the reference spacing are unchanged
 *  (returns `base`), so compact cities keep their current grid.
 *  @param base the regime divisor.
 *  @param medGeoMeters geographic median edge length in meters (0 disables).
 *  @param refMeters median spacing at which refinement starts (<= 0 disables).
 *  @param dmax upper bound on the refined divisor. */
export function scaleAwareDivisor(base: number, medGeoMeters: number, refMeters: number, dmax: number): number {
  if (!(medGeoMeters > 0) || refMeters <= 0) return base;
  const scaled = base * (medGeoMeters / refMeters);
  return Math.min(dmax, Math.max(base, scaled));
}

/** Reference median station spacing (meters): at or below this, the grid keeps
 *  the plain regime divisor; above it the cell is refined proportionally so it
 *  stays fine enough in real terms to keep coastal stations on the correct side
 *  of the shoreline. Compact cities sit at/below this; only geographically large
 *  networks refine. Override with OCTI_SCALEGRID. */
export const SCALE_GRID_REF_M = 680;
/** Upper bound on the scale-refined divisor, so a huge network cannot explode the
 *  cell count (which drives routing cost). Override with OCTI_SCALEGRID_MAX. */
export const SCALE_GRID_DMAX = 3.2;

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
/** Names estimated wider than this wrap to two lines (split on a space). Set so
 *  genuinely long names wrap while borderline ~15-char names stay one line. */
export const LABEL_WRAP_W = 96;

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
