// LOOM topo: build the support graph H by merging geographically-parallel
// transit edges into single corridor edges carrying the union of their line
// ids, then re-insert stations at the best-scoring support nodes.
// Reference: Brosi & Bast 2024, "Network Topology Extraction".

import type { Pixel } from './types';

/** sin(pi/4): the paper's line-creep angle factor. */
export const ALPHA = Math.SQRT1_2; // 0.70710678…

export function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(pts: Pixel[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/** Resample a polyline into equispaced points ~`step` apart. Always returns
 *  the exact first/last endpoints; returns just the endpoints when the line is
 *  shorter than one step. */
export function densify(pts: Pixel[], step: number): Pixel[] {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const total = polylineLength(pts);
  if (total <= step) return [pts[0].slice() as Pixel, pts[pts.length - 1].slice() as Pixel];
  const n = Math.max(1, Math.round(total / step));
  const seg = total / n;
  const out: Pixel[] = [pts[0].slice() as Pixel];
  let acc = 0;          // distance consumed along the source polyline
  let target = seg;     // next sample distance
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    while (target <= acc + segLen + 1e-9 && out.length < n) {
      const t = segLen === 0 ? 0 : (target - acc) / segLen;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      target += seg;
    }
    acc += segLen;
  }
  out.push(pts[pts.length - 1].slice() as Pixel);
  return out;
}

/** Paper's line-creep mitigation. With p1/pl the first/last samples of the
 *  edge being densified, reject candidate node `v` when it sits too far from
 *  the current sample relative to that sample's distance to either endpoint —
 *  this prevents two edges meeting at an obtuse angle from interlacing. */
export function creepBlocked(vPos: Pixel, pk: Pixel, samples: Pixel[]): boolean {
  const p1 = samples[0];
  const pl = samples[samples.length - 1];
  const dv = dist(pk, vPos);
  return ALPHA * dist(pk, p1) <= dv || ALPHA * dist(pk, pl) <= dv;
}
