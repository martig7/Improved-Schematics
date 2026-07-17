// Parallel-corridor separation pairs: two edges whose base polylines run
// near-parallel within each other's painted reach for a sustained span (a
// warp can compress two distinct octilinear ports to a few degrees of
// divergence, stacking four lanes in one pitch). The bias relaxation
// consumes these pairs and pushes the two stacks apart so they ride SIDE BY
// SIDE at proper pitch until the corridors genuinely part; the fan joints
// absorb the end seats. See docs/draw-geometry-invariants.md invariant I4.

import type { Pixel } from './types';
import { offsetPolyline } from './offsets';
import { debugJointRelease } from './debug/corridorSep.debug';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

/** Nearest point on polyline to p, plus the local segment direction and the
 *  arclength of the projection along the polyline. */
const nearestOn = (pts: Pixel[], p: Pixel): { q: Pixel; dir: Pixel; d: number; s: number } => {
  let best: { q: Pixel; dir: Pixel; d: number; s: number } = { q: pts[0], dir: [1, 0], d: Infinity, s: 0 };
  let arc = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1];
    const vx = pts[i][0] - ax, vy = pts[i][1] - ay;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) continue;
    const l = Math.sqrt(len2);
    let t = ((p[0] - ax) * vx + (p[1] - ay) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + vx * t, qy = ay + vy * t;
    const d = hyp(p[0] - qx, p[1] - qy);
    if (d < best.d) {
      best = { q: [qx, qy], dir: [vx / l, vy / l], d, s: arc + t * l };
    }
    arc += l;
  }
  return best;
};

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
        // A genuine side-by-side span projects onto the other edge's
        // INTERIOR; an end-to-end continuation clamps to its endpoint (its
        // samples near the shared node would otherwise qualify at every
        // corridor chain node).
        const atEnd =
          hyp(near.q[0] - L.pts[0][0], near.q[1] - L.pts[0][1]) < 1 ||
          hyp(near.q[0] - L.pts[L.pts.length - 1][0], near.q[1] - L.pts[L.pts.length - 1][1]) < 1;
        if (!atEnd && dot >= 0.94 && near.d < overlapAt) {
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

export interface JointSeatArgs {
  pairs: SepPair[];
  polyOf: (edgeId: string) => Pixel[] | undefined;
  orderOf: Map<string, string[]>;
  /** edge.id|lineId lane polylines, mutated in place. */
  segPath: Map<string, Pixel[]>;
  spacing: number;
}

/**
 * Joint seating over an overlapped parallel span (the ride-together
 * construction): along the stretch where two corridors run inside each
 * other's painted reach, their lanes seat as ONE combined bundle around the
 * local mean centerline, so the pair reads as a single wider bundle at
 * proper pitch instead of two overlapping stacks. The re-seat fades to
 * nothing where the bases diverge past clearance, so each corridor returns
 * to its own frame exactly where the pair genuinely parts. Constant
 * whole-edge shifts were falsified for this family; the construction is
 * per-span and lane-local by design. Returns the number of pairs seated.
 */
export function applyJointSeating(args: JointSeatArgs): number {
  const { pairs, polyOf, orderOf, segPath, spacing } = args;
  let seated = 0;
  for (const pair of pairs) {
    const baseA = polyOf(pair.eA);
    const baseB = polyOf(pair.eB);
    const ordA = orderOf.get(pair.eA) ?? [];
    const ordB = orderOf.get(pair.eB) ?? [];
    if (!baseA || !baseB || baseA.length < 2 || baseB.length < 2) continue;
    if (ordA.length + ordB.length < 2) continue;
    const cl = hyp(baseA[baseA.length - 1][0] - baseA[0][0], baseA[baseA.length - 1][1] - baseA[0][1]) || 1;
    const perpRef: Pixel = [
      -(baseA[baseA.length - 1][1] - baseA[0][1]) / cl,
      (baseA[baseA.length - 1][0] - baseA[0][0]) / cl,
    ];
    const tNear = pair.needed * 0.75;
    const tFar = pair.needed * 1.5;
    interface Sample { p: Pixel; q: number; w: number }
    interface LaneRef { edge: string; line: string; pts: Pixel[]; samples: Sample[]; meanQ: number }
    // Measure pass: each lane's lateral position q relative to the local
    // pair centerline, with the divergence fade weight.
    const measure = (edge: string, line: string): LaneRef | null => {
      const lane = segPath.get(edge + '|' + line);
      if (!lane) return null;
      const own = edge === pair.eA ? baseA : baseB;
      const other = edge === pair.eA ? baseB : baseA;
      const samples: Sample[] = [];
      let qSum = 0;
      let wSum = 0;
      for (const p of lane) {
        const no = nearestOn(own, p);
        const nt = nearestOn(other, p);
        const gap = hyp(nt.q[0] - no.q[0], nt.q[1] - no.q[1]);
        let w = gap <= tNear ? 1 : gap >= tFar ? 0 : 1 - (gap - tNear) / (tFar - tNear);
        w = w * w * (3 - 2 * w);
        let n: Pixel = [-no.dir[1], no.dir[0]];
        if (n[0] * perpRef[0] + n[1] * perpRef[1] < 0) n = [-n[0], -n[1]];
        const c: Pixel = [(no.q[0] + nt.q[0]) / 2, (no.q[1] + nt.q[1]) / 2];
        const q = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1];
        samples.push({ p, q, w });
      }
      // Transient-dip fill: where both bases turn a corner together, the
      // nearest-point gap spikes across the turn even though the corridors
      // resume side by side right after, and the momentary release snaps
      // every lane back toward its own overlapping frame (a weave of
      // sub-clearance crossings at the corner). A fade that RECOVERS later
      // in the span is that projection artifact, not a genuine parting, so
      // each weight rises to the smaller of its running maxima from either
      // side; a genuine end-of-span release never recovers and keeps its
      // decay. Zero-weight samples stay in the list so an apex vertex past
      // the far threshold is filled too.
      const pre: number[] = new Array(samples.length);
      const suf: number[] = new Array(samples.length);
      let m = 0;
      for (let i = 0; i < samples.length; i++) { m = Math.max(m, samples[i].w); pre[i] = m; }
      m = 0;
      for (let i = samples.length - 1; i >= 0; i--) { m = Math.max(m, samples[i].w); suf[i] = m; }
      for (let i = 0; i < samples.length; i++) {
        samples[i].w = Math.min(pre[i], suf[i]);
        qSum += samples[i].q * samples[i].w;
        wSum += samples[i].w;
      }
      if (samples.length === 0 || wSum <= 0) return null;
      return { edge, line, pts: lane, samples, meanQ: qSum / wSum };
    };
    const lanesA = ordA.map((line) => measure(pair.eA, line)).filter((l): l is LaneRef => l !== null);
    const lanesB = ordB.map((line) => measure(pair.eB, line)).filter((l): l is LaneRef => l !== null);
    if (lanesA.length + lanesB.length < 2) continue;
    // Joint order from the MEASURED arrangement, so the re-seat never drags
    // a lane across another (a guessed block order forced slow shallow
    // crossings inside the span): blocks stay whole (the ride-together
    // grouping) ordered by their mean lateral position, lanes within a
    // block by their own.
    const byQ = (x: LaneRef, y: LaneRef): number => (x.meanQ - y.meanQ) || (x.line < y.line ? -1 : 1);
    lanesA.sort(byQ);
    lanesB.sort(byQ);
    const meanOf = (ls: LaneRef[]): number => ls.reduce((s, l) => s + l.meanQ, 0) / ls.length;
    const joint = meanOf(lanesA) <= meanOf(lanesB) ? [...lanesA, ...lanesB] : [...lanesB, ...lanesA];
    const center = (joint.length - 1) / 2;
    debugJointRelease(pair.eA + 'x' + pair.eB, joint, center, spacing);
    // Shared rails: one centerline polyline for the pair (base A's vertices
    // paired with their nearest points on base B), offset per seat with the
    // miter-bisector corner handling of offsetPolyline, so every lane's
    // target through a shared corner comes from ONE frame. Per-sample local
    // frames disagree at a corner (each lane's projection reaches the turn
    // at a different phase) and seat two lanes onto colliding positions.
    // Both bases contribute their bend vertices (each paired with its
    // projection on the other, merged by arclength along base A): a corner
    // one base has and the other lacks must appear in the centerline, or
    // the lanes of the cornerless base chord across the rail bend and
    // pinch the pitch.
    interface CPt { t: number; p: Pixel }
    const cpts: CPt[] = [];
    let arcA = 0;
    for (let i = 0; i < baseA.length; i++) {
      if (i > 0) arcA += hyp(baseA[i][0] - baseA[i - 1][0], baseA[i][1] - baseA[i - 1][1]);
      const nb = nearestOn(baseB, baseA[i]);
      cpts.push({ t: arcA, p: [(baseA[i][0] + nb.q[0]) / 2, (baseA[i][1] + nb.q[1]) / 2] });
    }
    for (const v of baseB) {
      const na = nearestOn(baseA, v);
      cpts.push({ t: na.s, p: [(na.q[0] + v[0]) / 2, (na.q[1] + v[1]) / 2] });
    }
    cpts.sort((a, b) => (a.t - b.t) || (a.p[0] - b.p[0]) || (a.p[1] - b.p[1]));
    const centerPts: Pixel[] = [];
    for (const c of cpts) {
      const last = centerPts[centerPts.length - 1];
      if (last && hyp(c.p[0] - last[0], c.p[1] - last[1]) < 0.5) continue;
      centerPts.push(c.p);
    }
    if (centerPts.length < 2) continue;
    const probe = offsetPolyline(centerPts, spacing);
    const oSign =
      (probe[0][0] - centerPts[0][0]) * perpRef[0] + (probe[0][1] - centerPts[0][1]) * perpRef[1] >= 0 ? 1 : -1;
    for (let k = 0; k < joint.length; k++) {
      const rail = offsetPolyline(centerPts, (k - center) * spacing * oSign);
      const railS: number[] = [0];
      for (let r = 1; r < rail.length; r++) {
        railS.push(railS[r - 1] + hyp(rail[r][0] - rail[r - 1][0], rail[r][1] - rail[r - 1][1]));
      }
      const lane = joint[k].pts;
      const samples = joint[k].samples;
      const proj: number[] = [];
      for (const s of samples) {
        const t = nearestOn(rail, s.p);
        proj.push(t.s);
        if (s.w <= 0) continue;
        s.p[0] += (t.q[0] - s.p[0]) * s.w;
        s.p[1] += (t.q[1] - s.p[1]) * s.w;
      }
      // Lane vertices are sparse; where two consecutive vertices straddle a
      // rail bend, the straight chord between them cuts the corner, and
      // neighbouring lanes whose vertices straddle differently pinch below
      // pitch. Insert the straddled rail vertices (blended by the local
      // fade) so every lane follows the bend of its own rail.
      const out: Pixel[] = [];
      for (let i = 0; i < lane.length; i++) {
        out.push(lane[i]);
        if (i + 1 >= lane.length) break;
        const wMid = (samples[i].w + samples[i + 1].w) / 2;
        const sA = proj[i], sB = proj[i + 1];
        if (wMid <= 0.01 || sA === sB) continue;
        const between: Array<{ s: number; v: Pixel }> = [];
        const lo = Math.min(sA, sB), hi = Math.max(sA, sB);
        for (let r = 1; r < rail.length - 1; r++) {
          if (railS[r] > lo + 0.01 && railS[r] < hi - 0.01) between.push({ s: railS[r], v: rail[r] });
        }
        if (sB < sA) between.reverse();
        for (const b of between) {
          const f = (b.s - sA) / (sB - sA);
          const cx = lane[i][0] + (lane[i + 1][0] - lane[i][0]) * f;
          const cy = lane[i][1] + (lane[i + 1][1] - lane[i][1]) * f;
          out.push([cx + (b.v[0] - cx) * wMid, cy + (b.v[1] - cy) * wMid]);
        }
      }
      if (out.length !== lane.length) {
        lane.length = 0;
        for (const p of out) lane.push(p);
      }
    }
    seated++;
  }
  return seated;
}
