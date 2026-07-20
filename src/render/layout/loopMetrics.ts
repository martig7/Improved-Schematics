// Loop detector for the PAINTED track (what's actually drawn). A loop is where
// a route's painted track crosses itself. This can be a balloon loop, a hairpin
// wrap, or the fused-station hook octi can manufacture at a station group.
// Self-INTERSECTION (a proper crossing) is the right signal, not self-proximity.
// An out-and-back route retraces itself, so its two legs are COINCIDENT (not
// crossing) over most of their length. Proximity drowns in that overlap, but a
// real loop crosses at a point the overlap never does.
// Coincident/collinear segments are not proper crossings, so the retrace is
// correctly ignored while the loop is caught.

import type { Pixel } from './types';
import { envNum } from '../../env';

const num = (k: string, d: number): number => {
  const v = envNum(k);
  return Number.isFinite(v) ? v : d;
};

const MERGE = num('OCTI_LOOP_MERGE', 12); // crossings within this px are one loop
const ARTIFACT_DIAM = num('OCTI_LOOP_ARTDIAM', 300); // enclosed diameter ≥ this = likely a genuine route loop

/** artifact = a small self-crossing loop (the actionable kind, such as
 *  fused-station hooks and balloon loops). bigloop = a map-scale self-crossing,
 *  usually a genuine near-circular route rather than an artifact. */
export type LoopKind = 'artifact' | 'bigloop';

export interface PaintedLoop {
  lineId: string;
  kind: LoopKind;
  at: Pixel; // the self-crossing point
  loopArc: number; // arc length of the enclosed sub-path (segment i → segment j)
  diameter: number; // max extent of the enclosed loop geometry
  segI: [Pixel, Pixel]; // the two crossing segments, for pinpointing the ink
  segJ: [Pixel, Pixel];
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
function crossingsOf(pts: Pixel[]): Array<{ at: Pixel; loopArc: number; diameter: number; segI: [Pixel, Pixel]; segJ: [Pixel, Pixel] }> {
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
      if (i === 0 && j + 1 === n - 1) continue; // closed loop shares endpoints, not a crossing
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
  const out: Array<{ at: Pixel; loopArc: number; diameter: number; segI: [Pixel, Pixel]; segJ: [Pixel, Pixel] }> = [];
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
    out.push({
      at: best.at, loopArc: bestArc, diameter,
      segI: [pts[best.i], pts[best.i + 1]], segJ: [pts[best.j], pts[best.j + 1]],
    });
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
        segI: c.segI,
        segJ: c.segJ,
      });
    }
  }
  const rank = (k: LoopKind): number => (k === 'artifact' ? 0 : 1);
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.loopArc - b.loopArc);
  return out;
}

interface RawCross { at: Pixel; loopArc: number; diameter: number; segI: [Pixel, Pixel]; segJ: [Pixel, Pixel] }

// A chain endpoint of one subpath sits ON another subpath within this many px
// where a branching route's subpaths meet (the T-junction / ring-closure seam).
const CONNECT_EPS = 3;

/** Enclosed diameter of a crossing between two DIFFERENT chains of one line.
 *  The two subpaths meet at a junction (they are the same line); the enclosed
 *  loop is bounded by the crossing point and the NEAREST place the two chains
 *  reconnect, so its size is twice that reach. A tiny junction nick (a fillet
 *  overlapping the corner it rounds) reconnects a pixel away and measures near
 *  zero; a hook laid across the corridor reconnects a stub length away and
 *  measures the visible loop. When the two chains never reconnect (independent
 *  pieces that merely cross) the span of the crossing segments is the fallback. */
function crossChainDiameter(A: Pixel[], B: Pixel[], P: Pixel, seg: Pixel[]): number {
  let jDist = Infinity;
  for (const a of A) {
    for (const b of B) {
      if (dist(a, b) > CONNECT_EPS) continue; // only where the chains join
      const dp = dist(a, P);
      if (dp < 0.5) continue; // the crossing itself, not a reconnection
      if (dp < jDist) jDist = dp;
    }
  }
  if (Number.isFinite(jDist)) return 2 * jDist;
  let span = 0;
  for (let a = 0; a < seg.length; a++) for (let b = a + 1; b < seg.length; b++) {
    const dd = dist(seg[a], seg[b]);
    if (dd > span) span = dd;
  }
  return span;
}

/** Proper crossings between segments of DIFFERENT drawn chains of one line.
 *  A route that branches (serves a spur, closes a terminal ring) is drawn as
 *  several subpaths meeting at a junction; a subpath laid ACROSS another
 *  subpath of the same line (a jog taper or ring-closure curve painted over
 *  the corridor it joins) is a real self-crossing the reader sees, even though
 *  each subpath alone is simple. properCross is strict-transversal, so a spur
 *  that merely ENDS on the corridor (a T-junction touch, not an X) never fires;
 *  only ink genuinely laid across ink does. The genuine map-scale ring is a
 *  single self-crossing CHAIN, caught by crossingsOf, not here. */
function crossChainCrossings(chains: Pixel[][]): RawCross[] {
  interface Seg { a: Pixel; b: Pixel; ci: number }
  const segs: Seg[] = [];
  for (let ci = 0; ci < chains.length; ci++) {
    const p = chains[ci];
    for (let i = 0; i + 1 < p.length; i++) segs.push({ a: p[i], b: p[i + 1], ci });
  }
  if (segs.length < 2) return [];
  const CELL = 48;
  const grid = new Map<string, number[]>();
  const cellsOf = (s: Seg): string[] => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELL), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELL), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
    const ks: string[] = [];
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) ks.push(gx + ',' + gy);
    return ks;
  };
  for (let i = 0; i < segs.length; i++) for (const k of cellsOf(segs[i])) {
    let arr = grid.get(k); if (!arr) grid.set(k, (arr = [])); arr.push(i);
  }
  const out: RawCross[] = [];
  const seen = new Set<string>();
  for (const arr of grid.values()) {
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const S = segs[arr[x]], T = segs[arr[y]];
        if (S.ci === T.ci) continue; // same-chain adjacency handled by crossingsOf
        if (!properCross(S.a, S.b, T.a, T.b)) continue;
        const at: Pixel = [(S.a[0] + S.b[0] + T.a[0] + T.b[0]) / 4, (S.a[1] + S.b[1] + T.a[1] + T.b[1]) / 4];
        const key = Math.round(at[0] / 4) + ',' + Math.round(at[1] / 4);
        if (seen.has(key)) continue;
        seen.add(key);
        const diameter = crossChainDiameter(chains[S.ci], chains[T.ci], at, [S.a, S.b, T.a, T.b]);
        out.push({ at, loopArc: diameter * 2, diameter, segI: [S.a, S.b], segJ: [T.a, T.b] });
      }
    }
  }
  return out;
}

/** Detect self-crossings in the FINAL DRAWN ink of each route. Pass each
 *  line's drawn chains (maximal contiguous subpaths of the drawn 'd', e.g.
 *  from inkChains over drawnSegsByLine). Unlike the traversal-concatenated
 *  painted track, the drawn ink carries no phantom bridge across a course
 *  discontinuity (a retrace or a non-adjacent traversal step), so a route that
 *  legitimately jumps or retraces no longer reports a spurious loop where the
 *  concatenation chord would have crossed its own ink. Self-crossings that ARE
 *  drawn (balloon loops, terminal-ring hooks, jog tapers laid over a corridor)
 *  are still caught: within one chain by crossingsOf, across two chains of the
 *  same line by crossChainCrossings. */
export function detectDrawnLoops(routes: ReadonlyArray<{ lineId: string; chains: Pixel[][] }>): PaintedLoop[] {
  const out: PaintedLoop[] = [];
  for (const { lineId, chains } of routes) {
    const raws: RawCross[] = [];
    for (const pts of chains) if (pts.length >= 4) raws.push(...crossingsOf(pts));
    raws.push(...crossChainCrossings(chains));
    // Merge crossings whose points are within MERGE px (one visual loop can
    // clip several pairs); keep the tightest enclosed loop of the cluster.
    const usedR = new Array(raws.length).fill(false);
    for (let r = 0; r < raws.length; r++) {
      if (usedR[r]) continue;
      let best = raws[r];
      usedR[r] = true;
      for (let s = r + 1; s < raws.length; s++) {
        if (usedR[s]) continue;
        if (Math.abs(best.at[0] - raws[s].at[0]) < MERGE && Math.abs(best.at[1] - raws[s].at[1]) < MERGE) {
          usedR[s] = true;
          if (raws[s].loopArc < best.loopArc) best = raws[s];
        }
      }
      out.push({
        lineId,
        kind: best.diameter >= ARTIFACT_DIAM ? 'bigloop' : 'artifact',
        at: best.at, loopArc: best.loopArc, diameter: best.diameter,
        segI: best.segI, segJ: best.segJ,
      });
    }
  }
  const rank = (k: LoopKind): number => (k === 'artifact' ? 0 : 1);
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.loopArc - b.loopArc);
  return out;
}
