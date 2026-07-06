import type { Pixel } from './types';

export interface ConnectorControls { c1: Pixel; c2: Pixel }

/** Tangent-matched cubic control points for a node-connector bridge, with a
 *  PER-END lateral clamp: a control point may not cross the far end's lane
 *  line (spec §1). Without the cap the longitudinal k can drive a control
 *  point past the destination lane and read as a spike. kBase is the existing
 *  min(spacing*4, max(gap, spacing*2), lon). This helper only LOWERS it. */
export function connectorControls(
  pa: Pixel, pb: Pixel, dirA: Pixel, dirB: Pixel, kBase: number,
): ConnectorControls {
  const d: Pixel = [pb[0] - pa[0], pb[1] - pa[1]];
  // outgoing-axis unit + normal (dirB is unit-length at the call site)
  const nB: Pixel = [-dirB[1], dirB[0]];
  const nA: Pixel = [-dirA[1], dirA[0]];
  const TOL = 0.75; // px a control point may stray outside the lane band
  // SIGNED clamp: s = signed perpendicular speed of the control point,
  // l = signed lane delta to the far end. Heading TOWARD the far lane, the
  // control point stops exactly AT it (zero overshoot by the Bezier
  // convex-hull argument). Heading AWAY, allow only TOL of stray so the
  // tangent shortens instead of overshooting. s ≈ 0 (near-parallel) keeps
  // kBase; the excursion is ≤ TOL by the same bound, with no threshold cliff.
  const clampK = (s: number, l: number): number => {
    if (s * l > 1e-12) return Math.min(kBase, l / s);
    const as = s < 0 ? -s : s;
    return as > 1e-9 ? Math.min(kBase, TOL / as) : kBase;
  };
  const kA = clampK(dirA[0] * nB[0] + dirA[1] * nB[1], d[0] * nB[0] + d[1] * nB[1]);
  // c2 moves along −dirB from pb; mirror the same signed logic against the
  // INCOMING lane band. Its nB-coordinate is pinned at pb's lane regardless.
  const kB = clampK(-(dirB[0] * nA[0] + dirB[1] * nA[1]), -(d[0] * nA[0] + d[1] * nA[1]));
  return {
    c1: [pa[0] + dirA[0] * kA, pa[1] + dirA[1] * kA],
    c2: [pb[0] - dirB[0] * kB, pb[1] - dirB[1] * kB],
  };
}
