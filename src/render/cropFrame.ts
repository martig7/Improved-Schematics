// Framing a rotated map. A city with a map bearing is rotated at assembly, so
// its harvest rect arrives in the render frame as a diamond with data-void
// triangles at the corners. Fitting the square canvas to that diamond spends a
// large share of the canvas on nothing, so the default crop is instead the
// largest rectangle that fits INSIDE the region.
//
// Determinism: fixed-iteration binary search using only + - * / and comparisons,
// so the seeded crop bbox (which reaches the layout fingerprint) is bit-identical
// across engines.

import type { Coordinate } from '../types/core';

const ITERS = 50;

/** Centre of a convex ring, as the mean of its vertices. For the rotated harvest
 *  rect this is the centre of symmetry. */
function centroid(hull: readonly Coordinate[]): Coordinate {
  let sx = 0, sy = 0;
  for (const p of hull) { sx += p[0]; sy += p[1]; }
  return [sx / hull.length, sy / hull.length];
}

/** Whether a point lies inside a convex ring (either winding), edges counting as
 *  inside. */
export function insideConvex(hull: readonly Coordinate[], x: number, y: number): boolean {
  let neg = false, pos = false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cross < 0) neg = true;
    else if (cross > 0) pos = true;
    if (neg && pos) return false;
  }
  return true;
}

/**
 * The largest axis-aligned rectangle of the given width:height ratio that fits
 * inside a convex ring, centred on the ring's centre.
 *
 * Centring costs nothing for the region this is used on: the hull is a rotated
 * rectangle, hence centrally symmetric, and for a centrally symmetric convex
 * region the largest inscribed rectangle of a fixed aspect can always be taken
 * about the centre.
 *
 * @param hull   convex ring, in the rotated render frame
 * @param aspect rectangle width / height (> 0)
 * @param scaleX horizontal unit per one unit of `aspect`; the frame is
 *               pseudo-lng/lat, where a degree of longitude is shorter than a
 *               degree of latitude, so the ratio is measured in metric units
 * @returns [x0, y0, x1, y1], or null if the ring is degenerate
 */
export function largestInscribedRect(
  hull: readonly Coordinate[],
  aspect: number,
  scaleX = 1,
): [number, number, number, number] | null {
  if (hull.length < 3 || !(aspect > 0) || !(scaleX > 0)) return null;
  const [cx, cy] = centroid(hull);
  if (!insideConvex(hull, cx, cy)) return null;
  // Half-height is the search variable; half-width follows from the aspect,
  // converted out of metric so the drawn rectangle reads as `aspect` on screen.
  let lo = 0;
  let hi = 0;
  for (const p of hull) {
    const dx = (p[0] - cx) * scaleX, dy = p[1] - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > hi) hi = r;
  }
  if (!(hi > 0)) return null;
  const fits = (h: number): boolean => {
    const w = (h * aspect) / scaleX;
    return insideConvex(hull, cx - w, cy - h) && insideConvex(hull, cx + w, cy - h)
      && insideConvex(hull, cx + w, cy + h) && insideConvex(hull, cx - w, cy + h);
  };
  for (let i = 0; i < ITERS; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  if (!(lo > 0)) return null;
  const w = (lo * aspect) / scaleX;
  return [cx - w, cy - lo, cx + w, cy + lo];
}

/** The four corners of a rectangle turned by `rad` about its own centre, in
 *  drawing order. */
export function rotatedRectCorners(
  cx: number, cy: number, hw: number, hh: number, rad: number,
): Array<[number, number]> {
  const c = Math.cos(rad), s = Math.sin(rad);
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Array<[number, number]>)
    .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as [number, number]);
}

/**
 * Snap an angle to the nearest preferred orientation within a tolerance.
 * @param deg      candidate angle, degrees
 * @param extra    additional targets beyond the 45 degree multiples
 * @param tolDeg   how near a target has to be to snap onto it
 */
export function snapAngle(deg: number, extra: readonly number[] = [], tolDeg = 4): number {
  const norm = (a: number): number => ((a % 360) + 360) % 360;
  const targets: number[] = [];
  for (let k = 0; k < 8; k++) targets.push(k * 45);
  for (const e of extra) if (Number.isFinite(e)) targets.push(norm(e));
  const d = norm(deg);
  let best = deg, bestGap = tolDeg;
  for (const t of targets) {
    let gap = Math.abs(d - t);
    if (gap > 180) gap = 360 - gap;
    if (gap < bestGap) { bestGap = gap; best = deg + (t - d > 180 ? t - d - 360 : t - d < -180 ? t - d + 360 : t - d); }
  }
  return best;
}
