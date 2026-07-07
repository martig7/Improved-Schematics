// Shortest octilinear polyline joining the boundaries of two axis-aligned
// rectangles. A connector prefers a SINGLE straight octilinear segment (one of
// the 8 directions) whenever one exists, and only bends into a two-segment
// octilinear path in the "dead zone" where no single octilinear line stabs
// both rects. This replaces axis-only L-shaped taxicab connectors for the
// rectangle interchange capsule.
//
// A single octilinear segment exists iff the two rects' projections overlap on
// at least one of x, y, x+y, or x-y (a horizontal, vertical, or 45-degree line
// crosses both). Among the valid single-segment candidates we pick the one with
// the shortest positive gap; ties break by a fixed direction order
// (vertical, horizontal, slope -1 diagonal, slope +1 diagonal).
//
// Pure geometry, fully deterministic: no Math.random / Date, exact comparisons,
// and total tie-breaks, so offline output equals in-game output.

import type { Point } from '../stations/types';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Connector { points: Point[] }

const EPS = 1e-9;

/** Overlap of two closed intervals [a0,a1] and [b0,b1]; null when disjoint. */
function overlap(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return lo <= hi + EPS ? [lo, hi] : null;
}

// One single-segment candidate: its two endpoints and its gap length. Direction
// index encodes the fixed tie-break order (0 vertical, 1 horizontal, 2 slope-1
// diagonal, 3 slope+1 diagonal).
interface Candidate { p0: Point; p1: Point; gap: number; dir: number }

/**
 * Shortest octilinear polyline joining rects A and B.
 * Returns 2 points when a single octilinear segment spans the pair, else 3
 * points (one octilinear bend).
 */
export function octiConnect(A: Rect, B: Rect): Connector {
  const ax0 = A.x, ax1 = A.x + A.w, ay0 = A.y, ay1 = A.y + A.h;
  const bx0 = B.x, bx1 = B.x + B.w, by0 = B.y, by1 = B.y + B.h;

  const cands: Candidate[] = [];

  // Vertical segment (dir 0): x-ranges overlap, connect at the overlap midpoint.
  const ox = overlap(ax0, ax1, bx0, bx1);
  if (ox) {
    const xs = (ox[0] + ox[1]) / 2;
    if (by0 - ay1 > EPS) cands.push({ p0: [xs, ay1], p1: [xs, by0], gap: by0 - ay1, dir: 0 });
    else if (ay0 - by1 > EPS) cands.push({ p0: [xs, ay0], p1: [xs, by1], gap: ay0 - by1, dir: 0 });
  }

  // Horizontal segment (dir 1): y-ranges overlap, connect at the overlap midpoint.
  const oy = overlap(ay0, ay1, by0, by1);
  if (oy) {
    const ys = (oy[0] + oy[1]) / 2;
    if (bx0 - ax1 > EPS) cands.push({ p0: [ax1, ys], p1: [bx0, ys], gap: bx0 - ax1, dir: 1 });
    else if (ax0 - bx1 > EPS) cands.push({ p0: [ax0, ys], p1: [bx1, ys], gap: ax0 - bx1, dir: 1 });
  }

  // Slope -1 diagonal (dir 2): lines x+y = const. The rects overlap on the u=x+y
  // coordinate; along that shared band the perpendicular coordinate v=x-y
  // separates them, and the diagonal gap is that v separation (each unit of v
  // is sqrt(2)/2 of world distance, but v itself is the ordering key). Endpoints
  // sit at the near corners along the shared u band.
  {
    const au0 = ax0 + ay0, au1 = ax1 + ay1;   // x+y range of A
    const bu0 = bx0 + by0, bu1 = bx1 + by1;    // x+y range of B
    const ou = overlap(au0, au1, bu0, bu1);
    if (ou) {
      const us = (ou[0] + ou[1]) / 2;           // shared x+y value
      const av0 = ax0 - ay1, av1 = ax1 - ay0;   // x-y range of A
      const bv0 = bx0 - by1, bv1 = bx1 - by0;   // x-y range of B
      // separation along v (the diagonal gap)
      const seg = diagFromUV(us, av0, av1, bv0, bv1, +1);
      if (seg) cands.push({ p0: seg.p0, p1: seg.p1, gap: seg.gap, dir: 2 });
    }
  }

  // Slope +1 diagonal (dir 3): lines x-y = const. Symmetric to the above with
  // u=x-y as the shared band and v=x+y as the separating coordinate.
  {
    const au0 = ax0 - ay1, au1 = ax1 - ay0;   // x-y range of A
    const bu0 = bx0 - by1, bu1 = bx1 - by0;    // x-y range of B
    const ou = overlap(au0, au1, bu0, bu1);
    if (ou) {
      const us = (ou[0] + ou[1]) / 2;           // shared x-y value
      const av0 = ax0 + ay0, av1 = ax1 + ay1;   // x+y range of A
      const bv0 = bx0 + by0, bv1 = bx1 + by1;   // x+y range of B
      const seg = diagFromUV(us, av0, av1, bv0, bv1, -1);
      if (seg) cands.push({ p0: seg.p0, p1: seg.p1, gap: seg.gap, dir: 3 });
    }
  }

  if (cands.length > 0) {
    // Shortest positive gap; deterministic tie-break by direction index.
    let best = cands[0];
    for (let i = 1; i < cands.length; i++) {
      const c = cands[i];
      if (c.gap < best.gap - EPS || (Math.abs(c.gap - best.gap) <= EPS && c.dir < best.dir)) {
        best = c;
      }
    }
    return { points: [best.p0, best.p1] };
  }

  // Dead zone: no single octilinear segment spans the pair. Route a two-leg
  // axis-aligned octilinear path A -> bend -> B. The first leg runs along the
  // dominant axis (the larger of |dx|,|dy| between the rect centers), the second
  // leg finishes into the other rect; the bend is an octilinear vertex and both
  // endpoints clamp to the rect boundaries.
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
  const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  const dx = bcx - acx, dy = bcy - acy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // horizontal first: leave A's near vertical edge, bend under/over B, enter B's near horizontal edge
    const aEdge: Point = [dx >= 0 ? ax1 : ax0, acy];
    const bend: Point = [bcx, acy];
    const bEdge: Point = [bcx, dy >= 0 ? by0 : by1];
    return { points: [aEdge, bend, bEdge] };
  }
  // vertical first: leave A's near horizontal edge, bend beside B, enter B's near vertical edge
  const aEdge: Point = [acx, dy >= 0 ? ay1 : ay0];
  const bend: Point = [acx, bcy];
  const bEdge: Point = [dx >= 0 ? bx0 : bx1, bcy];
  return { points: [aEdge, bend, bEdge] };
}

// Build a 45-degree segment on the shared band. `us` is the fixed value of the
// band coordinate u; the two rects' ranges on the separating coordinate v are
// [av0,av1] and [bv0,bv1]. `sign` selects how (u,v) map back to (x,y):
//   sign +1: u = x+y, v = x-y  ->  x = (u+v)/2, y = (u-v)/2   (slope -1 line)
//   sign -1: u = x-y, v = x+y  ->  x = (u+v)/2, y = (v-u)/2   (slope +1 line)
// Returns the near-corner endpoints and the positive v gap, or null when the v
// ranges are not separated (the rects touch or overlap on this diagonal).
function diagFromUV(
  us: number, av0: number, av1: number, bv0: number, bv1: number, sign: number,
): { p0: Point; p1: Point; gap: number } | null {
  let va: number, vb: number, gap: number;
  if (bv0 - av1 > EPS) { va = av1; vb = bv0; gap = bv0 - av1; }         // B beyond A on v
  else if (av0 - bv1 > EPS) { va = av0; vb = bv1; gap = av0 - bv1; }   // A beyond B on v
  else return null;
  const toXY = (u: number, v: number): Point =>
    sign > 0 ? [(u + v) / 2, (u - v) / 2] : [(u + v) / 2, (v - u) / 2];
  return { p0: toXY(us, va), p1: toXY(us, vb), gap };
}
