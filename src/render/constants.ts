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

/** Drawn line and station chrome sizes. These are live bindings so each render
 *  can set ribbon and marker scales independently. */
export let LINE_WIDTH = BASE_LINE_WIDTH;
export let LINE_GAP = BASE_LINE_GAP;
export let STATION_WIDTH = BASE_LINE_WIDTH;

/** Base station-marker (dot) radius, shared by the octilinear renderer, the
 *  station placement/primitive geometry, and label collision boxes so every
 *  site sizes the marker identically. Derived from the station width. */
export let MARK_R0 = STATION_WIDTH * 0.7;

/** Current independent ribbon and station scales (1 = base). */
export let LINE_SCALE = 1;
export let STATION_SCALE = 1;

const _renderScaleCbs: Array<() => void> = [];
/** Register a callback that recomputes values derived from live render scales. */
export function onRenderScale(cb: () => void): void {
  _renderScaleCbs.push(cb);
  cb();
}

export interface RenderScales {
  line: number;
  station: number;
}

/** Set the two layout-baked chrome scales through one render-metrics seam. */
export function setRenderScales(scales: RenderScales): void {
  LINE_SCALE = Number.isFinite(scales.line) && scales.line > 0 ? scales.line : 1;
  STATION_SCALE = Number.isFinite(scales.station) && scales.station > 0 ? scales.station : 1;
  LINE_WIDTH = BASE_LINE_WIDTH * LINE_SCALE;
  LINE_GAP = BASE_LINE_GAP * LINE_SCALE;
  STATION_WIDTH = BASE_LINE_WIDTH * STATION_SCALE;
  MARK_R0 = STATION_WIDTH * 0.7;
  for (const cb of _renderScaleCbs) cb();
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
