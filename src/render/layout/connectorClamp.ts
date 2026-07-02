import type { Pixel } from './types';

export interface ConnectorControls { c1: Pixel; c2: Pixel }

/** Tangent-matched cubic control points for a node-connector bridge, with a
 *  PER-END lateral clamp: a control point may not cross the far end's lane
 *  line (spec §1 — the uncapped longitudinal k let a 45° approach dive ~3.4px
 *  past the destination lane and read as a spike). kBase is the existing
 *  min(spacing*4, max(gap, spacing*2), lon) — this helper only LOWERS it. */
export function connectorControls(
  pa: Pixel, pb: Pixel, dirA: Pixel, dirB: Pixel, kBase: number,
): ConnectorControls {
  const d: Pixel = [pb[0] - pa[0], pb[1] - pa[1]];
  // outgoing-axis unit + normal (dirB is unit-length at the call site)
  const nB: Pixel = [-dirB[1], dirB[0]];
  const lat = Math.abs(d[0] * nB[0] + d[1] * nB[1]); // slot delta across the corridor
  const perpA = Math.abs(dirA[0] * nB[0] + dirA[1] * nB[1]);
  const kA = perpA > 0.15 ? Math.min(kBase, lat / perpA) : kBase;
  const nA: Pixel = [-dirA[1], dirA[0]];
  const latA = Math.abs(d[0] * nA[0] + d[1] * nA[1]);
  const perpB = Math.abs(dirB[0] * nA[0] + dirB[1] * nA[1]);
  const kB = perpB > 0.15 ? Math.min(kBase, latA / perpB) : kBase;
  return {
    c1: [pa[0] + dirA[0] * kA, pa[1] + dirA[1] * kA],
    c2: [pb[0] - dirB[0] * kB, pb[1] - dirB[1] * kB],
  };
}
