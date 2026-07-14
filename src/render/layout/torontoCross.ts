/**
 * Toronto "direct intersection" detection. A perfect crossing is a node whose
 * stopping lines run on at least two different octilinear axes AND meet at one
 * point each line can reach by sliding its stop a short way ALONG the line.
 *
 * The dot is placed on the DRAWN ribbons: for the common two-line case it is the
 * point where the two lanes actually come closest (their true crossing, or the
 * apex where they merge into a bundle), found from the drawn lane segments so it
 * lands on the ink rather than on a straight-tangent estimate that drifts off
 * where the ribbons curve. A parallel bundle (one axis), a pair that never comes
 * within a lane's width, or a meeting point out of slide range is NOT collapsed
 * and is left to the pill capsule. Design-agnostic, computed once at compute
 * time; the three-or-more-line case uses the London coverCenter test.
 */
import { coverCenter, axisUnit, type Line } from './londonBubbles';
import { LINE_WIDTH, LINE_GAP } from '../constants';

type P = [number, number];
type Seg = [P, P];

/** Drawn lane segments of a line within `win` of a point. */
export type LaneSegsAt = (lineId: string, pos: P, win: number) => Seg[];

/** The mark fields the crossing test needs. The exact tangent locates the
 *  three-plus-line intersection; the axis keys the parallel-bundle gate; the
 *  lineId fetches the drawn lanes for the two-line case. */
interface CrossMark { lineId: string; axis?: number; dir?: [number, number]; pos: P; mega?: boolean }

export interface TorontoCross { cx: number; cy: number }

// ---- drawn-segment geometry (squared distances until the final sqrt) --------

function pointSeg(p: P, a: P, b: P): { d2: number; q: P } {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
  const q: P = [a[0] + t * abx, a[1] + t * aby];
  const dx = p[0] - q[0], dy = p[1] - q[1];
  return { d2: dx * dx + dy * dy, q };
}

function segIntersect(a: P, b: P, c: P, d: P): P | null {
  const r0 = b[0] - a[0], r1 = b[1] - a[1];
  const s0 = d[0] - c[0], s1 = d[1] - c[1];
  const denom = r0 * s1 - r1 * s0;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / denom;
  const u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * r0, a[1] + t * r1];
}

/** Closest points (and squared gap) between two segments. */
function segSeg(a: P, b: P, c: P, d: P): { d2: number; pA: P; pB: P } {
  const x = segIntersect(a, b, c, d);
  if (x) return { d2: 0, pA: x, pB: x };
  const r1 = pointSeg(a, c, d), r2 = pointSeg(b, c, d);
  const r3 = pointSeg(c, a, b), r4 = pointSeg(d, a, b);
  const cands = [
    { d2: r1.d2, pA: a, pB: r1.q },
    { d2: r2.d2, pA: b, pB: r2.q },
    { d2: r3.d2, pA: r3.q, pB: c },
    { d2: r4.d2, pA: r4.q, pB: d },
  ];
  let best = cands[0];
  for (const cd of cands) if (cd.d2 < best.d2) best = cd;
  return best;
}

/** Where two drawn lanes meet: the closest-approach midpoint. Only meetings each
 *  stop can reach by sliding a short way count (both closest points within
 *  `maxSlide` of their own stop), so a merge resolves at the apex near the
 *  station, not deep in the parallel run that follows. Ties in gap prefer the
 *  meeting nearest the stops. Null when the lanes never come within `meet` inside
 *  that reachable band. */
function drawnMeet(segsA: Seg[], segsB: Seg[], mA: P, mB: P, meet: number, maxSlide: number): TorontoCross | null {
  const ms2 = maxSlide * maxSlide;
  let best: { d2: number; mid: P; toMark: number } | null = null;
  for (const [a1, a2] of segsA) {
    for (const [b1, b2] of segsB) {
      const r = segSeg(a1, a2, b1, b2);
      // both closest points must be a short slide from their own stop
      if ((r.pA[0] - mA[0]) ** 2 + (r.pA[1] - mA[1]) ** 2 > ms2) continue;
      if ((r.pB[0] - mB[0]) ** 2 + (r.pB[1] - mB[1]) ** 2 > ms2) continue;
      const mid: P = [(r.pA[0] + r.pB[0]) / 2, (r.pA[1] + r.pB[1]) / 2];
      const toMark = (mid[0] - mA[0]) ** 2 + (mid[1] - mA[1]) ** 2 + (mid[0] - mB[0]) ** 2 + (mid[1] - mB[1]) ** 2;
      if (!best || r.d2 < best.d2 - 1e-9 || (r.d2 < best.d2 + 1e-9 && toMark < best.toMark)) {
        best = { d2: r.d2, mid, toMark };
      }
    }
  }
  if (!best || best.d2 > meet * meet) return null;
  return { cx: best.mid[0], cy: best.mid[1] };
}

export function computeTorontoByNode(stops: Map<string, CrossMark[]>, laneSegsAt?: LaneSegsAt): Map<string, TorontoCross> {
  const spacing = LINE_WIDTH + LINE_GAP;
  // Tighter than half the lane spacing, so two parallel lanes never collapse.
  const cover = spacing * 0.35;
  // Farthest a stop may slide along its line to the meeting point; past this the
  // convergence is too shallow to read as a crossing, so use a pill.
  const maxSlide = spacing * 3.5;
  // Two lanes "meet" when they come within about a lane spacing (a true crossing
  // touches; a merge settles at the parallel gap).
  const meet = spacing + 2;
  const out = new Map<string, TorontoCross>();
  for (const [nodeId, marks] of stops) {
    const ms = marks.filter((m) => !m.mega);
    if (ms.length <= 1) continue;
    const axes = new Set(ms.map((m) => (m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4))));
    if (axes.size < 2) continue; // one run-axis = a parallel bundle, not a crossing

    // Two lines: place the dot on the drawn ribbons where they meet.
    if (ms.length === 2 && laneSegsAt) {
      const segsA = laneSegsAt(ms[0].lineId, ms[0].pos, maxSlide);
      const segsB = laneSegsAt(ms[1].lineId, ms[1].pos, maxSlide);
      if (segsA.length && segsB.length) {
        const c = drawnMeet(segsA, segsB, ms[0].pos, ms[1].pos, meet, maxSlide);
        if (c) out.set(nodeId, c);
      }
      continue; // drawn geometry is authoritative; no off-ribbon tangent fallback
    }

    // Three or more lines: the exact-tangent intersection covered by one dot.
    const lines: Line[] = ms.map((m) => {
      const key = m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4);
      const [ux, uy] = m.dir ?? axisUnit(key === -1 ? 0 : key);
      return { ux, uy, px: m.pos[0], py: m.pos[1], axisKey: key };
    });
    const c = coverCenter(lines, cover, maxSlide);
    if (!c) continue;
    let slide = 0;
    for (const m of ms) slide = Math.max(slide, Math.sqrt((c.x - m.pos[0]) ** 2 + (c.y - m.pos[1]) ** 2));
    if (slide > maxSlide) continue;
    out.set(nodeId, { cx: c.x, cy: c.y });
  }
  return out;
}
