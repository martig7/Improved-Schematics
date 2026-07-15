// Oriented-bounding-box (OBB) geometry for rotated station labels, plus the
// screen-tilt penalty. Only the fixed octilinear angles occur, so cos/sin are
// exact literal constants: no runtime trig, so the SVG output stays deterministic
// cross-V8. Marker and station boxes stay axis-aligned; only a label box rotates.

import type { Pixel } from './layout/types';

/** cos/sin for the label angles that can render (degrees, screen space, y-down). */
export function trig(angleDeg: number): { c: number; s: number } {
  const H = 0.7071067811865476; // cos 45 = sin 45, fixed literal
  switch (angleDeg) {
    case 45: return { c: H, s: H };
    case -45: return { c: H, s: -H };
    case 90: return { c: 0, s: 1 };
    case -90: return { c: 0, s: -1 };
    default: return { c: 1, s: 0 }; // 0 and any non-rotating value
  }
}

export interface Obb {
  corners: [Pixel, Pixel, Pixel, Pixel];
}

/** OBB for a text box whose local rectangle is [x0,x1] by [y0,y1] relative to the
 *  pivot (the text origin), rotated angleDeg about the pivot. */
export function obbFromLocalBox(pivot: Pixel, x0: number, y0: number, x1: number, y1: number, angleDeg: number): Obb {
  const { c, s } = trig(angleDeg);
  const rot = (dx: number, dy: number): Pixel => [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c];
  return { corners: [rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)] };
}

/** Axis-aligned bounds of an OBB (used for the crowding tiebreak). */
export function obbAabb(obb: Obb): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of obb.corners) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** SAT overlap of two convex quads. Touching edges count as NOT overlapping, so
 *  an axis-aligned pair reproduces boxesOverlap's half-open convention exactly. */
function satOverlap(a: Pixel[], b: Pixel[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const nx = -(p2[1] - p1[1]);
      const ny = p2[0] - p1[0];
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const q of a) { const d = q[0] * nx + q[1] * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const q of b) { const d = q[0] * nx + q[1] * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

export function obbOverlap(a: Obb, b: Obb): boolean {
  return satOverlap(a.corners, b.corners);
}

/** Whether segment p1->p2 meets the OBB: an endpoint inside, or a crossing of any edge. */
export function segmentIntersectsObb(p1: Pixel, p2: Pixel, obb: Obb): boolean {
  const poly = obb.corners;
  if (pointInConvex(p1, poly) || pointInConvex(p2, poly)) return true;
  for (let i = 0; i < 4; i++) if (segCross(p1, p2, poly[i], poly[(i + 1) % 4])) return true;
  return false;
}

function pointInConvex(pt: Pixel, poly: Pixel[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cr = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
    if (cr !== 0) {
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function segCross(a: Pixel, b: Pixel, c: Pixel, d: Pixel): boolean {
  const cross = (o: Pixel, p: Pixel, q: Pixel) => (q[1] - o[1]) * (p[0] - o[0]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Screen-tilt penalty. Flat is free, 45 is cheap, 90 (sideways) is a strong last
 *  resort. Tunable; 90 above the marker-overlap cost keeps a station tolerating a
 *  marker overlap rather than turning sideways. */
export function tilt(angleDeg: number): number {
  const a = Math.abs(angleDeg);
  return a === 0 ? 0 : a === 90 ? 35 : 4;
}
