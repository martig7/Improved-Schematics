// Dots-on-lanes marker placement (spec: docs/superpowers/specs/
// 2026-06-12-dots-on-lanes-chain-dp-design.md). A dot's position is an arc
// parameter on its own lane curve; a station's marker is a chain over its
// dots, solved EXACTLY per station by dynamic programming (spec P4). The
// pair-distance target is the lane PITCH, not the dot diameter — with 2r
// the optimizer chases lane-pinch regions (crossings) instead of clean
// parallel track (spec §2.3).

import type { Pixel } from './types';

export interface LaneCurve {
  pts: Pixel[];     // windowed polyline through the station
  cum: number[];    // cumulative arc length; cum[0] = 0
  anchorT: number;  // arc position of the stop anchor
}

const arcCum = (pts: Pixel[]): number[] => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
};

export const curvePoint = (c: LaneCurve, t: number): Pixel => {
  const total = c.cum[c.cum.length - 1];
  const tt = Math.max(0, Math.min(total, t));
  let lo = 0;
  let hi = c.cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= tt) lo = mid;
    else hi = mid;
  }
  const seg = c.cum[hi] - c.cum[lo];
  const u = seg < 1e-9 ? 0 : (tt - c.cum[lo]) / seg;
  return [
    c.pts[lo][0] + (c.pts[hi][0] - c.pts[lo][0]) * u,
    c.pts[lo][1] + (c.pts[hi][1] - c.pts[lo][1]) * u,
  ];
};

export const curveTangent = (c: LaneCurve, t: number): Pixel => {
  const total = c.cum[c.cum.length - 1];
  const tt = Math.max(1e-9, Math.min(total - 1e-9, t));
  let lo = 0;
  let hi = c.cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= tt) lo = mid;
    else hi = mid;
  }
  const dx = c.pts[hi][0] - c.pts[lo][0];
  const dy = c.pts[hi][1] - c.pts[lo][1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
};

// arc position of the point on the polyline nearest to p
const projectArc = (pts: Pixel[], cum: number[], p: Pixel): number => {
  let bestD = Infinity;
  let bestT = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const ay = pts[i - 1][1];
    const dx = pts[i][0] - ax;
    const dy = pts[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const d = Math.hypot(p[0] - (ax + dx * u), p[1] - (ay + dy * u));
    if (d < bestD) { bestD = d; bestT = cum[i - 1] + Math.sqrt(l2) * u; }
  }
  return bestT;
};

// clip a polyline to the arc range [t0, t1]
const clipArc = (pts: Pixel[], cum: number[], t0: number, t1: number): Pixel[] => {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(t0, total));
  const b = Math.max(a, Math.min(t1, total));
  const tmp: LaneCurve = { pts, cum, anchorT: 0 };
  const out: Pixel[] = [curvePoint(tmp, a)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > a && cum[i] < b) out.push(pts[i]);
  }
  out.push(curvePoint(tmp, b));
  return out;
};

/** Chain a line's incident lane polylines (each oriented AWAY from the
 *  node) into one curve through the station, windowed to ±arcLimit of the
 *  stop anchor. Terminus lines contribute one side; their domain ends at
 *  the drawn tip. */
export const buildLaneCurve = (
  incident: Pixel[][],
  anchor: Pixel,
  arcLimit: number,
): LaneCurve => {
  const lenOf = (p: Pixel[]) => arcCum(p)[p.length - 1];
  const sides = incident
    .filter((p) => p.length >= 2)
    .sort((x, y) => lenOf(y) - lenOf(x))
    .slice(0, 2);
  let pts: Pixel[];
  if (sides.length === 0) pts = [anchor, [anchor[0] + 1e-6, anchor[1]]];
  else if (sides.length === 1) pts = [...sides[0]].reverse();
  else pts = [...sides[1]].reverse().concat(sides[0]);
  const dd: Pixel[] = [pts[0]];
  for (const p of pts) {
    const q = dd[dd.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) dd.push(p);
  }
  if (dd.length < 2) dd.push([dd[0][0] + 1e-6, dd[0][1]]);
  let cum = arcCum(dd);
  const aT = projectArc(dd, cum, anchor);
  const clipped = clipArc(dd, cum, aT - arcLimit, aT + arcLimit);
  cum = arcCum(clipped);
  return { pts: clipped, cum, anchorT: projectArc(clipped, cum, anchor) };
};

/** Ramer–Douglas–Peucker on a point chain (used for the rendered spine). */
export const rdpSimplify = (pts: Pixel[], eps: number): Pixel[] => {
  if (pts.length <= 2) return [...pts];
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0;
    let wi = -1;
    const ax = pts[a][0];
    const ay = pts[a][1];
    const dx = pts[b][0] - ax;
    const dy = pts[b][1] - ay;
    const l2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2));
      const d = Math.hypot(pts[i][0] - (ax + dx * u), pts[i][1] - (ay + dy * u));
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > eps && wi > 0) {
      keep[wi] = true;
      stack.push([a, wi], [wi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
};
