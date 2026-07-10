// Straight connector joining two axis-aligned rectangles, attaching on the two
// FACING FLAT EDGES so a teardrop neck's bulb always sits on a flat edge (never a
// corner, which would make the bulb overshoot). The facing edges are chosen by
// the dominant separation axis: boxes separated more horizontally attach on their
// vertical (left/right) faces, more vertically on their horizontal (top/bottom)
// faces. The free coordinate of each endpoint is the overlap midpoint when the
// rects overlap on that axis (a clean vertical/horizontal connector), else the
// other box's center clamped onto the edge with a `margin` so the bulb fits. The
// result is a single straight segment that faces the true direction — vertical
// when stacked, horizontal when side by side, and a diagonal slope when offset on
// both axes. Overlapping/touching rects collapse to a degenerate boundary point
// (the neck paints nothing).
//
// Pure geometry, fully deterministic: no Math.random / Date, exact comparisons,
// so offline output equals in-game output.

import type { Point } from '../stations/types';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Connector {
  points: Point[];
  /** Inward unit normals of the two attach edges (into rect A, into rect B),
   *  axis-aligned. Used to tuck the drawn neck perpendicular into each box so its
   *  bulb sits flat on the edge. Absent for a degenerate contact connector. */
  normals?: [Point, Point];
}

const EPS = 1e-9;

/** Overlap of two closed intervals [a0,a1] and [b0,b1]; null when disjoint. */
function overlap(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return lo <= hi + EPS ? [lo, hi] : null;
}

/** Clamp v into [lo,hi]; when the interval is empty (edge shorter than 2*margin)
 *  fall back to its midpoint so the attachment stays centered. */
function clampEdge(v: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Flat-edge connector between rects A and B. Always two points, both on the
 * respective rect boundaries; a degenerate two-point contact point when the
 * rects overlap or touch. `margin` pulls a sloped endpoint in from the edge's
 * corners so a bulb of that half-width fits on the flat edge (default 0 attaches
 * at the corner).
 */
export function octiConnect(A: Rect, B: Rect, margin = 0): Connector {
  const ax0 = A.x, ax1 = A.x + A.w, ay0 = A.y, ay1 = A.y + A.h;
  const bx0 = B.x, bx1 = B.x + B.w, by0 = B.y, by1 = B.y + B.h;

  // Overlapping or touching rects (ranges meet on both axes): no separating gap,
  // so return a degenerate boundary-to-boundary point on the contact region. The
  // teardrop neck skips a zero-length centerline, and the capsules union on their
  // own under expand-overdraw. Defense-in-depth: callers seat boxes apart, but
  // this stays robust if one slips through.
  const xlo = Math.max(ax0, bx0), xhi = Math.min(ax1, bx1);
  const ylo = Math.max(ay0, by0), yhi = Math.min(ay1, by1);
  if (xlo <= xhi + EPS && ylo <= yhi + EPS) {
    return { points: contactConnector(A, B, xlo, xhi, ylo, yhi) };
  }

  const acx = ax0 + A.w / 2, acy = ay0 + A.h / 2;
  const bcx = bx0 + B.w / 2, bcy = by0 + B.h / 2;
  const sepX = Math.max(bx0 - ax1, ax0 - bx1, 0); // positive x gap (0 if x overlaps)
  const sepY = Math.max(by0 - ay1, ay0 - by1, 0); // positive y gap

  if (sepX >= sepY) {
    // Facing vertical edges (left/right); the free coordinate is y. Inward
    // normals are horizontal (into A away from B, into B away from A).
    const right = bcx >= acx;
    const p0x = right ? ax1 : ax0;
    const p1x = right ? bx0 : bx1;
    const normals: [Point, Point] = [[right ? -1 : 1, 0], [right ? 1 : -1, 0]];
    // A clean horizontal connector only when the shared y-band is wide enough to
    // seat the bulb centered in it (so the bulb stays within BOTH boxes). A
    // narrow overlap means the boxes are really diagonally offset -> slope the
    // endpoints, each clamped onto its own edge with the bulb margin.
    const oy = overlap(ay0, ay1, by0, by1);
    if (oy && oy[1] - oy[0] >= 2 * margin - EPS) {
      const m = (oy[0] + oy[1]) / 2;
      return { points: [[p0x, m], [p1x, m]], normals };
    }
    const p0y = clampEdge(bcy, ay0 + margin, ay1 - margin);
    const p1y = clampEdge(acy, by0 + margin, by1 - margin);
    return { points: [[p0x, p0y], [p1x, p1y]], normals };
  }

  // Facing horizontal edges (top/bottom); the free coordinate is x. Inward
  // normals are vertical.
  const down = bcy >= acy;
  const p0y = down ? ay1 : ay0;
  const p1y = down ? by0 : by1;
  const normals: [Point, Point] = [[0, down ? -1 : 1], [0, down ? 1 : -1]];
  const ox = overlap(ax0, ax1, bx0, bx1);
  if (ox && ox[1] - ox[0] >= 2 * margin - EPS) {
    const m = (ox[0] + ox[1]) / 2;
    return { points: [[m, p0y], [m, p1y]], normals };
  }
  const p0x = clampEdge(bcx, ax0 + margin, ax1 - margin);
  const p1x = clampEdge(acx, bx0 + margin, bx1 - margin);
  return { points: [[p0x, p0y], [p1x, p1y]], normals };
}

/** True when point p is strictly inside rect r (touching the boundary is out). */
function strictlyInside(p: Point, r: Rect): boolean {
  return p[0] > r.x + EPS && p[0] < r.x + r.w - EPS &&
         p[1] > r.y + EPS && p[1] < r.y + r.h - EPS;
}

/**
 * Boundary-to-boundary connector for overlapping or touching rects. The overlap
 * box is [xlo,xhi] x [ylo,yhi]; its corners are boundary-crossing points of the
 * two rects (each on an edge of A and an edge of B) except under full
 * containment, where no shared-boundary point exists. Pick the overlap-box
 * corner that is not strictly interior to either rect and is nearest the mean of
 * the rect centers, with a fixed tie-break, and return it as a degenerate
 * two-point segment so no vertex lies strictly inside either rect.
 */
function contactConnector(
  A: Rect, B: Rect, xlo: number, xhi: number, ylo: number, yhi: number,
): Point[] {
  const mx = (A.x + A.x + A.w + B.x + B.x + B.w) / 4;
  const my = (A.y + A.y + A.h + B.y + B.y + B.h) / 4;
  const corners: Point[] = [[xlo, ylo], [xhi, ylo], [xlo, yhi], [xhi, yhi]];
  const nonInterior = corners.filter((c) => !strictlyInside(c, A) && !strictlyInside(c, B));
  const pool = nonInterior.length > 0 ? nonInterior : corners;
  let bc = pool[0];
  let bd = Infinity;
  for (const c of pool) {
    const d = (c[0] - mx) * (c[0] - mx) + (c[1] - my) * (c[1] - my);
    if (d < bd - EPS) { bd = d; bc = c; }
  }
  return [bc, bc];
}
