// Loop detector for the PAINTED track (what's actually drawn). A loop is where
// a route's painted track crosses itself — a balloon loop, hairpin wrap, or the
// fused-station hook octi can manufacture at a station group (Chicago's Blue A
// at Chestnut St). Self-INTERSECTION (a proper crossing) is the right signal,
// not self-proximity: an out-and-back route retraces itself, so its two legs
// are COINCIDENT (not crossing) over most of their length — proximity drowns in
// that overlap, but a real loop crosses at a point the overlap never does.
// Coincident/collinear segments are not proper crossings, so the retrace is
// correctly ignored while the loop is caught.

import type { Pixel } from './types';

const num = (k: string, d: number): number => {
  const v =
    typeof process !== 'undefined'
      ? Number((process as { env?: Record<string, string> }).env?.[k])
      : NaN;
  return Number.isFinite(v) ? v : d;
};

const MERGE = num('OCTI_LOOP_MERGE', 12); // crossings within this px are one loop
const ARTIFACT_DIAM = num('OCTI_LOOP_ARTDIAM', 300); // enclosed diameter ≥ this = likely a genuine route loop

/** artifact = a small self-crossing loop (the actionable kind — fused-station
 *  hooks, balloon loops). bigloop = a map-scale self-crossing, usually a
 *  genuine near-circular route rather than an artifact. */
export type LoopKind = 'artifact' | 'bigloop';

export interface PaintedLoop {
  lineId: string;
  kind: LoopKind;
  at: Pixel; // the self-crossing point
  loopArc: number; // arc length of the enclosed sub-path (segment i → segment j)
  diameter: number; // max extent of the enclosed loop geometry
}

const dist = (a: Pixel, b: Pixel): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

// signed area ×2 of triangle abc (orientation test).
const cross3 = (a: Pixel, b: Pixel, c: Pixel): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Proper segment crossing only: strict opposite orientations on both sides, so
 *  collinear/coincident/touching pairs (the out-and-back overlap, shared
 *  vertices) return false. */
const properCross = (p1: Pixel, p2: Pixel, p3: Pixel, p4: Pixel): boolean => {
  const d1 = cross3(p3, p4, p1);
  const d2 = cross3(p3, p4, p2);
  const d3 = cross3(p1, p2, p3);
  const d4 = cross3(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/** Self-crossings of one painted polyline. Each crossing of non-adjacent
 *  segments (i, j>i+1) is a loop enclosing the sub-path i..j. Nearby crossings
 *  merge (the smallest enclosed loop kept). */
function crossingsOf(pts: Pixel[]): Array<{ at: Pixel; loopArc: number; diameter: number }> {
  const n = pts.length;
  if (n < 4) return [];
  // cumulative arclength for loop-size measurement
  const arc: number[] = new Array(n);
  arc[0] = 0;
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + dist(pts[i - 1], pts[i]);

  interface Raw { at: Pixel; i: number; j: number }
  const raws: Raw[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const ax0 = Math.min(pts[i][0], pts[i + 1][0]);
    const ax1 = Math.max(pts[i][0], pts[i + 1][0]);
    const ay0 = Math.min(pts[i][1], pts[i + 1][1]);
    const ay1 = Math.max(pts[i][1], pts[i + 1][1]);
    for (let j = i + 2; j + 1 < n; j++) {
      if (i === 0 && j + 1 === n - 1) continue; // closed loop shares endpoints — not a crossing
      // AABB reject
      if (Math.max(pts[j][0], pts[j + 1][0]) < ax0 || Math.min(pts[j][0], pts[j + 1][0]) > ax1) continue;
      if (Math.max(pts[j][1], pts[j + 1][1]) < ay0 || Math.min(pts[j][1], pts[j + 1][1]) > ay1) continue;
      if (!properCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) continue;
      raws.push({ at: [(pts[i][0] + pts[i + 1][0] + pts[j][0] + pts[j + 1][0]) / 4, (pts[i][1] + pts[i + 1][1] + pts[j][1] + pts[j + 1][1]) / 4], i, j });
    }
  }
  if (raws.length === 0) return [];
  // merge crossings whose points are within MERGE px (one visual loop can clip
  // several segment pairs); keep the tightest enclosed loop of the cluster.
  raws.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  const out: Array<{ at: Pixel; loopArc: number; diameter: number }> = [];
  const used = new Array(raws.length).fill(false);
  for (let r = 0; r < raws.length; r++) {
    if (used[r]) continue;
    const cluster = [raws[r]];
    used[r] = true;
    for (let s = r + 1; s < raws.length; s++) {
      if (used[s]) continue;
      if (cluster.some((c) => Math.abs(c.at[0] - raws[s].at[0]) < MERGE && Math.abs(c.at[1] - raws[s].at[1]) < MERGE)) {
        cluster.push(raws[s]);
        used[s] = true;
      }
    }
    // tightest loop in the cluster (smallest enclosed arc)
    let best = cluster[0];
    let bestArc = arc[cluster[0].j] - arc[cluster[0].i];
    for (const c of cluster) {
      const a = arc[c.j] - arc[c.i];
      if (a < bestArc) { bestArc = a; best = c; }
    }
    let diameter = 0;
    for (let x = best.i; x <= best.j; x += 2) {
      for (let y = x + 2; y <= best.j; y += 2) {
        const d = dist(pts[x], pts[y]);
        if (d > diameter) diameter = d;
      }
    }
    out.push({ at: best.at, loopArc: bestArc, diameter });
  }
  return out;
}

/** Detect painted-track loops over a set of routes. Pass each route's painted
 *  polyline (offset lanes concatenated in traversal order). */
export function detectPaintedLoops(routes: ReadonlyArray<{ lineId: string; pts: Pixel[] }>): PaintedLoop[] {
  const out: PaintedLoop[] = [];
  for (const { lineId, pts } of routes) {
    for (const c of crossingsOf(pts)) {
      out.push({
        lineId,
        kind: c.diameter >= ARTIFACT_DIAM ? 'bigloop' : 'artifact',
        at: c.at,
        loopArc: c.loopArc,
        diameter: c.diameter,
      });
    }
  }
  const rank = (k: LoopKind): number => (k === 'artifact' ? 0 : 1);
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.loopArc - b.loopArc);
  return out;
}
