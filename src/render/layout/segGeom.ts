// Small, deterministic 2D segment-geometry helpers for operating on drawn ribbon
// polylines. Cross-V8 byte-identical: Math.sqrt only, never Math.hypot.

import type { Pixel } from './types';

/** Closest point on segment [a,b] to p. */
export function closestPointOnSegment(p: Pixel, a: Pixel, b: Pixel): Pixel {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
  return [a[0] + vx * t, a[1] + vy * t];
}

/** Intersection point of segments [a1,a2] and [b1,b2], or null when they do not
 *  cross (parallel or non-overlapping). */
export function segmentIntersection(a1: Pixel, a2: Pixel, b1: Pixel, b2: Pixel): Pixel | null {
  const r0 = a2[0] - a1[0], r1 = a2[1] - a1[1];
  const s0 = b2[0] - b1[0], s1 = b2[1] - b1[1];
  const denom = r0 * s1 - r1 * s0;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * s1 - (b1[1] - a1[1]) * s0) / denom;
  const u = ((b1[0] - a1[0]) * r1 - (b1[1] - a1[1]) * r0) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a1[0] + r0 * t, a1[1] + r1 * t];
}

/** Closest points and the gap between two segments; gap 0 at a true crossing. */
export function segmentsClosest(a1: Pixel, a2: Pixel, b1: Pixel, b2: Pixel): { gap: number; pA: Pixel; pB: Pixel } {
  const x = segmentIntersection(a1, a2, b1, b2);
  if (x) return { gap: 0, pA: x, pB: x };
  const cands: Array<{ pA: Pixel; pB: Pixel }> = [
    { pA: a1, pB: closestPointOnSegment(a1, b1, b2) },
    { pA: a2, pB: closestPointOnSegment(a2, b1, b2) },
    { pA: closestPointOnSegment(b1, a1, a2), pB: b1 },
    { pA: closestPointOnSegment(b2, a1, a2), pB: b2 },
  ];
  let best = cands[0], bestG = Infinity;
  for (const c of cands) {
    const g = Math.sqrt((c.pA[0] - c.pB[0]) ** 2 + (c.pA[1] - c.pB[1]) ** 2);
    if (g < bestG) { bestG = g; best = c; }
  }
  return { gap: bestG, pA: best.pA, pB: best.pB };
}

/** Sample a quadratic bezier a..apex..b into `n` chords (returns n+1 points,
 *  endpoints included). */
export function sampleQuadratic(a: Pixel, apex: Pixel, b: Pixel, n: number): Pixel[] {
  const out: Pixel[] = [];
  for (let k = 0; k <= n; k++) {
    const u = k / n, m = 1 - u;
    out.push([m * m * a[0] + 2 * m * u * apex[0] + u * u * b[0], m * m * a[1] + 2 * m * u * apex[1] + u * u * b[1]]);
  }
  return out;
}

/** Acute angle (radians, 0..pi/2) between two segment directions. */
export function segmentAngle(a1: Pixel, a2: Pixel, b1: Pixel, b2: Pixel): number {
  const ax = a2[0] - a1[0], ay = a2[1] - a1[1];
  const bx = b2[0] - b1[0], by = b2[1] - b1[1];
  const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(0, Math.min(1, Math.abs((ax * bx + ay * by) / (la * lb)))));
}

/** The closest approach between two polylines: the segment pair with the least
 *  gap, its midpoint, and the acute angle between those segments. Null for empty
 *  input. Used to decide where (and whether) two drawn lanes truly cross. */
export function polylinesClosest(
  A: Pixel[][],
  B: Pixel[][],
): { gap: number; mid: Pixel; angle: number } | null {
  let best: { gap: number; mid: Pixel; angle: number } | null = null;
  for (const pa of A) {
    for (let i = 1; i < pa.length; i++) {
      for (const pb of B) {
        for (let k = 1; k < pb.length; k++) {
          const c = segmentsClosest(pa[i - 1], pa[i], pb[k - 1], pb[k]);
          if (!best || c.gap < best.gap) {
            best = { gap: c.gap, mid: [(c.pA[0] + c.pB[0]) / 2, (c.pA[1] + c.pB[1]) / 2], angle: segmentAngle(pa[i - 1], pa[i], pb[k - 1], pb[k]) };
          }
        }
      }
    }
  }
  return best;
}
