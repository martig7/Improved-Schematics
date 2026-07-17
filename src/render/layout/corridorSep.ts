// Parallel-corridor separation pairs: two edges whose base polylines run
// near-parallel within each other's painted reach for a sustained span (a
// warp can compress two distinct octilinear ports to a few degrees of
// divergence, stacking four lanes in one pitch). The bias relaxation
// consumes these pairs and pushes the two stacks apart so they ride SIDE BY
// SIDE at proper pitch until the corridors genuinely part; the fan joints
// absorb the end seats. See docs/draw-geometry-invariants.md invariant I4.

import type { Pixel } from './types';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface SepPair {
  eA: string;
  eB: string;
  /** Mean signed lateral offset of B's center from A's, along A's perp,
   *  over the overlapping run, WITHOUT biases. */
  d0: number;
  /** +1 when B's bias shifts along A's perp, -1 when the edges run
   *  antiparallel (B's perp points the other way). */
  sign: number;
  /** Required center separation: both half widths plus one pitch. */
  needed: number;
}

/**
 * Find sustained near-parallel sub-clearance edge pairs. Deterministic:
 * sorted edge ids, fixed sampling. Cost is bounded by an AABB prefilter.
 *
 * @param edgeIds  drawn edge ids (edges with no lanes contribute nothing)
 * @param polyOf   base polyline per edge (from -> to)
 * @param halfWidthOf painted half width per edge (bias-free)
 * @param spacing  lane pitch, px
 */
export function findParallelPairs(
  edgeIds: string[],
  polyOf: (id: string) => Pixel[] | undefined,
  halfWidthOf: (id: string) => number,
  spacing: number,
  /** Node pair per edge; only edges SHARING a node pair up (the compressed
   *  port family diverges from a hub; unrelated parallel streets that
   *  merely run close are legitimate and must not be pushed). */
  nodesOf?: (id: string) => [string, string] | undefined,
): SepPair[] {
  interface Info { id: string; pts: Pixel[]; box: [number, number, number, number]; chord: Pixel; arc: number }
  const infos: Info[] = [];
  for (const id of [...edgeIds].sort()) {
    const pts = polyOf(id);
    if (!pts || pts.length < 2) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, arc = 0;
    for (let i = 0; i < pts.length; i++) {
      x0 = Math.min(x0, pts[i][0]); y0 = Math.min(y0, pts[i][1]);
      x1 = Math.max(x1, pts[i][0]); y1 = Math.max(y1, pts[i][1]);
      if (i > 0) arc += hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    const cl = hyp(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) || 1;
    infos.push({
      id, pts, box: [x0, y0, x1, y1], arc,
      chord: [(pts[pts.length - 1][0] - pts[0][0]) / cl, (pts[pts.length - 1][1] - pts[0][1]) / cl],
    });
  }

  /** Nearest point on polyline to p, plus the local segment direction. */
  const nearestOn = (pts: Pixel[], p: Pixel): { q: Pixel; dir: Pixel; d: number } => {
    let best: { q: Pixel; dir: Pixel; d: number } = { q: pts[0], dir: [1, 0], d: Infinity };
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1];
      const vx = pts[i][0] - ax, vy = pts[i][1] - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1e-12) continue;
      let t = ((p[0] - ax) * vx + (p[1] - ay) * vy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + vx * t, qy = ay + vy * t;
      const d = hyp(p[0] - qx, p[1] - qy);
      if (d < best.d) {
        const l = Math.sqrt(len2);
        best = { q: [qx, qy], dir: [vx / l, vy / l], d };
      }
    }
    return best;
  };

  const out: SepPair[] = [];
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const A = infos[i], B = infos[j];
      if (nodesOf) {
        const na = nodesOf(A.id);
        const nb = nodesOf(B.id);
        if (!na || !nb) continue;
        if (na[0] !== nb[0] && na[0] !== nb[1] && na[1] !== nb[0] && na[1] !== nb[1]) continue;
      }
      const needed = halfWidthOf(A.id) + halfWidthOf(B.id) + spacing;
      // Qualify on actual INK overlap (outer lanes inside the sub-pitch
      // band), not on center spacing below full clearance: legitimately
      // close parallel corridors clear by less than a full pitch.
      const overlapAt = halfWidthOf(A.id) + halfWidthOf(B.id) + spacing * 0.75;
      if (
        A.box[0] > B.box[2] + needed || B.box[0] > A.box[2] + needed ||
        A.box[1] > B.box[3] + needed || B.box[1] > A.box[3] + needed
      ) continue;
      // sample along the shorter edge, test against the longer
      const [S, L] = B.arc <= A.arc ? [B, A] : [A, B];
      const step = Math.max(4, spacing);
      const n = Math.min(64, Math.max(2, Math.floor(S.arc / step) + 1));
      const perpL: Pixel = [-L.chord[1], L.chord[0]];
      let run = 0, bestRun = 0, sum = 0, cnt = 0;
      // walk sample points by arclength over S
      let seg = 1, acc = 0;
      for (let k = 0; k < n; k++) {
        const target = (S.arc * k) / (n - 1);
        while (seg < S.pts.length - 1 && acc + hyp(S.pts[seg][0] - S.pts[seg - 1][0], S.pts[seg][1] - S.pts[seg - 1][1]) < target) {
          acc += hyp(S.pts[seg][0] - S.pts[seg - 1][0], S.pts[seg][1] - S.pts[seg - 1][1]);
          seg++;
        }
        const segLen = hyp(S.pts[seg][0] - S.pts[seg - 1][0], S.pts[seg][1] - S.pts[seg - 1][1]) || 1;
        const t = Math.min(1, Math.max(0, (target - acc) / segLen));
        const p: Pixel = [
          S.pts[seg - 1][0] + (S.pts[seg][0] - S.pts[seg - 1][0]) * t,
          S.pts[seg - 1][1] + (S.pts[seg][1] - S.pts[seg - 1][1]) * t,
        ];
        const sDir: Pixel = [(S.pts[seg][0] - S.pts[seg - 1][0]) / segLen, (S.pts[seg][1] - S.pts[seg - 1][1]) / segLen];
        const near = nearestOn(L.pts, p);
        const dot = Math.abs(sDir[0] * near.dir[0] + sDir[1] * near.dir[1]);
        if (dot >= 0.94 && near.d < overlapAt) {
          run += S.arc / (n - 1);
          sum += (p[0] - near.q[0]) * perpL[0] + (p[1] - near.q[1]) * perpL[1];
          cnt++;
          if (run > bestRun) bestRun = run;
        } else {
          run = 0;
        }
      }
      if (bestRun < spacing * 3 || cnt === 0) continue;
      // d0 in A's frame: when B was the sampled (shorter) edge the signed
      // mean is already B-relative-to-A along A's perp; otherwise it is
      // A-relative-to-B along B's perp, so flip it and map the perp frames
      // (B's perp is A's perp times the chord alignment sign).
      const sign = A.chord[0] * B.chord[0] + A.chord[1] * B.chord[1] >= 0 ? 1 : -1;
      const meanSigned = sum / cnt;
      const d0 = S === B ? meanSigned : -meanSigned * sign;
      out.push({ eA: A.id, eB: B.id, d0, sign, needed });
    }
  }
  return out;
}
