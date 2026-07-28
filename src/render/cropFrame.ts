// Geometry for the crop box's orientation: the corners of a turned rectangle,
// and the snapping that lands its angle on a preferred axis.

import type { Coordinate } from '../types/core';

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
