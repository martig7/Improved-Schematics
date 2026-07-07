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

  // Overlapping or touching rects (gap <= 0 on both axes): the single-segment
  // and dead-zone branches below assume a positive gap and would otherwise place
  // a vertex inside a rect. Return a degenerate boundary-to-boundary connector on
  // the contact region instead. Defense-in-depth: callers should seat boxes so
  // they never overlap, but this stays robust if one slips through.
  {
    const xlo = Math.max(ax0, bx0), xhi = Math.min(ax1, bx1);
    const ylo = Math.max(ay0, by0), yhi = Math.min(ay1, by1);
    if (xlo <= xhi + EPS && ylo <= yhi + EPS) {
      return { points: contactConnector(A, B, xlo, xhi, ylo, yhi) };
    }
  }

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
  // are clamped onto each rect's boundary along the chosen diagonal line.
  {
    const au0 = ax0 + ay0, au1 = ax1 + ay1;   // x+y range of A
    const bu0 = bx0 + by0, bu1 = bx1 + by1;    // x+y range of B
    const ou = overlap(au0, au1, bu0, bu1);
    if (ou) {
      const us = (ou[0] + ou[1]) / 2;           // shared x+y value
      const seg = diagFromUV(us, A, B, +1);
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
      const seg = diagFromUV(us, A, B, -1);
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

  // Dead zone: no single octilinear segment spans the pair. Reaching here means
  // the rects are strictly separated on BOTH x and y (any axis overlap would have
  // produced a single-segment candidate above, and touching/overlapping pairs
  // returned earlier), so the bend below sits between the rects and no vertex
  // lands strictly inside either rect. Route a two-leg axis-aligned octilinear
  // path A -> bend -> B. The first leg runs along the dominant axis (the larger
  // of |dx|,|dy| between the rect centers), the second leg finishes into the
  // other rect; the bend is an octilinear vertex and both endpoints lie on the
  // rect boundaries.
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
// band coordinate u; `sign` selects how (u,v) map back to (x,y):
//   sign +1: u = x+y, v = x-y  ->  x = (u+v)/2, y = (u-v)/2   (slope -1 line)
//   sign -1: u = x-y, v = x+y  ->  x = (u+v)/2, y = (v-u)/2   (slope +1 line)
// The diagonal line u = us cuts each rect over a v-interval; that interval is
// computed from the rect's own x and y bounds (the full-rect v-range is wider
// than the range achievable at a fixed u slice, so clamping to it is what keeps
// both endpoints on the actual boundary). Returns the near-boundary endpoints
// and the positive v gap, or null when the two rects' v-intervals are not
// separated (they touch or overlap on this diagonal, handled elsewhere).
function diagFromUV(
  us: number, A: Rect, B: Rect, sign: number,
): { p0: Point; p1: Point; gap: number } | null {
  // v-interval where the line u = us intersects a rect, from its x/y bounds.
  const vRange = (r: Rect): [number, number] => {
    const x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
    // sign +1: v = x - y, with x = (us+v)/2, y = (us-v)/2. sign -1: v = x + y,
    // with x = (us+v)/2, y = (v-us)/2. Both invert to bounds on v below.
    const vx0 = 2 * x0 - us, vx1 = 2 * x1 - us;               // from x bounds
    const vy0 = sign > 0 ? us - 2 * y1 : 2 * y0 - us;         // from y bounds
    const vy1 = sign > 0 ? us - 2 * y0 : 2 * y1 - us;
    return [Math.max(vx0, vy0), Math.min(vx1, vy1)];
  };
  const [av0, av1] = vRange(A);
  const [bv0, bv1] = vRange(B);
  let va: number, vb: number, gap: number;
  if (bv0 - av1 > EPS) { va = av1; vb = bv0; gap = bv0 - av1; }         // B beyond A on v
  else if (av0 - bv1 > EPS) { va = av0; vb = bv1; gap = av0 - bv1; }   // A beyond B on v
  else return null;
  const toXY = (u: number, v: number): Point =>
    sign > 0 ? [(u + v) / 2, (u - v) / 2] : [(u + v) / 2, (v - u) / 2];
  return { p0: toXY(us, va), p1: toXY(us, vb), gap };
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
