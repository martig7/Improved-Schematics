import type { Pixel } from './types';
import { offsetPolyline } from './offsets';

export interface Swap {
  /** Lateral slot index (0-based, low side) of the adjacent pair that swaps. */
  lo: number;
  /** Arc-length position along the base where the crossing occurs. */
  arc: number;
}

/** Cumulative arc length at each base vertex; cum[0] = 0. */
function arcLengths(base: Pixel[]): number[] {
  const cum = [0];
  for (let i = 1; i < base.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]));
  }
  return cum;
}

/** Point + unit normal at an arc position along the base polyline. The normal
 *  is the left-hand perpendicular of the local travel direction (matches the
 *  sign convention of offsetPolyline: positive offset = perp(unit) = [-dy,dx]). */
function sampleBase(base: Pixel[], cum: number[], arc: number): { p: Pixel; n: Pixel } {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(total, arc));
  let seg = 1;
  while (seg < cum.length - 1 && cum[seg] < a) seg++;
  const t = cum[seg] === cum[seg - 1] ? 0 : (a - cum[seg - 1]) / (cum[seg] - cum[seg - 1]);
  const p0 = base[seg - 1];
  const p1 = base[seg];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  return { p: [p0[0] + dx * t, p0[1] + dy * t], n: [-dy / len, dx / len] };
}

/** Decompose the permutation orderFrom -> orderTo into adjacent transpositions
 *  (bubble sort records every swap). Each swap is placed at an arc position
 *  along the base. PHASE 1 placement: evenly spaced in the interior; Phase 3
 *  refines this to prefer bend vertices. Deterministic. */
export function planSwaps(orderFrom: string[], orderTo: string[], base: Pixel[]): Swap[] {
  // Map each line to its target rank under orderTo, expressed in orderFrom space.
  const targetRank = new Map<string, number>();
  orderTo.forEach((l, i) => targetRank.set(l, i));
  const work = orderFrom.map((l) => targetRank.get(l)!); // permutation as rank array
  const swaps: { lo: number }[] = [];
  // Bubble sort: each adjacent inversion fixed is one transposition (one crossing).
  for (let pass = 0; pass < work.length; pass++) {
    let done = true;
    for (let i = 0; i + 1 < work.length; i++) {
      if (work[i] > work[i + 1]) {
        [work[i], work[i + 1]] = [work[i + 1], work[i]];
        swaps.push({ lo: i });
        done = false;
      }
    }
    if (done) break;
  }
  if (swaps.length === 0) return [];
  const cum = arcLengths(base);
  const total = cum[cum.length - 1];
  // Interior bend vertices are the strongest swap anchors (the turn absorbs the
  // crossing). Rank candidate arc positions: interior vertices first (sharpest
  // turn wins), then evenly spaced fallbacks for any extra swaps. Assign the
  // chosen arcs to swaps in spatial (ascending) order so the per-line slot
  // timeline in buildEdgeLanes stays monotone along the edge.
  const bends: { arc: number; sharp: number }[] = [];
  for (let i = 1; i < base.length - 1; i++) {
    const a = base[i - 1], v = base[i], b = base[i + 1];
    const l1 = Math.hypot(v[0] - a[0], v[1] - a[1]) || 1;
    const l2 = Math.hypot(b[0] - v[0], b[1] - v[1]) || 1;
    const dot = ((v[0] - a[0]) * (b[0] - v[0]) + (v[1] - a[1]) * (b[1] - v[1])) / (l1 * l2);
    bends.push({ arc: cum[i], sharp: 1 - dot }); // sharp in [0,2]
  }
  bends.sort((p, q) => q.sharp - p.sharp || p.arc - q.arc);
  const candidates: number[] = bends.map((b) => b.arc);
  for (let k = 1; k <= swaps.length; k++) candidates.push((total * k) / (swaps.length + 1));
  const chosen = candidates.slice(0, swaps.length).sort((a, b) => a - b);
  return swaps.map((s, k) => ({ lo: s.lo, arc: chosen[k] }));
}

/** Whether the swap at arc `s.arc` exchanges this line, given its timeline. */
function swapInvolves(s: Swap, tl: { arc: number; slot: number }[]): boolean {
  return tl.some((ev) => Math.abs(ev.arc - s.arc) < 1e-9);
}

/** Build each line's lane polyline for one edge. `orderFrom`/`orderTo` are the
 *  drawn-line orders at the two endpoints (same set, possibly permuted). When
 *  they are equal every lane is a constant lateral offset == today's renderer.
 *  Returns lineId -> Pixel[]. */
export function buildEdgeLanes(
  base: Pixel[],
  orderFrom: string[],
  orderTo: string[],
  spacing: number,
  bias: number,
): Map<string, Pixel[]> {
  const out = new Map<string, Pixel[]>();
  const n = orderFrom.length;
  const center = (n - 1) / 2;

  // Identity fast-path: byte-identical to the legacy constant-offset renderer.
  const identical = n === orderTo.length && orderFrom.every((l, i) => l === orderTo[i]);
  if (identical) {
    for (let i = 0; i < n; i++) {
      const o = (i - center) * spacing + bias;
      out.set(
        orderFrom[i],
        Math.abs(o) < 1e-9 ? base.map((p) => p.slice() as Pixel) : offsetPolyline(base, o, false),
      );
    }
    return out;
  }

  // Stepping path: each line holds a slot, stepping at swaps. Build a per-line
  // slot timeline (slot index as a function of arc), then sample the base at
  // every base vertex AND every swap arc, offsetting by (slot-center)*spacing.
  const cum = arcLengths(base);
  const swaps = planSwaps(orderFrom, orderTo, base);
  const occupant = [...orderFrom]; // occupant[slot] = lineId
  // timeline[line] = array of {arc, slot}; arc=0 is the start slot.
  const timeline = new Map<string, { arc: number; slot: number }[]>();
  orderFrom.forEach((l, i) => timeline.set(l, [{ arc: 0, slot: i }]));
  for (const s of swaps) {
    const a = occupant[s.lo];
    const b = occupant[s.lo + 1];
    occupant[s.lo] = b;
    occupant[s.lo + 1] = a;
    timeline.get(a)!.push({ arc: s.arc, slot: s.lo + 1 });
    timeline.get(b)!.push({ arc: s.arc, slot: s.lo });
  }

  // Arc positions at which to emit a lane vertex: every base vertex plus a pair
  // of points bracketing each swap (so the crossing is a single X, not a shared
  // collinear run).
  const W = 6; // px half-window for a swap step
  const totalArc = cum[cum.length - 1];
  for (const line of orderFrom) {
    const tl = timeline.get(line)!;
    // slotAt(arc): the slot this line occupies as of `arc` (post-step at the
    // swap arc, since events use arc <= comparison).
    const slotAt = (arc: number): number => {
      let slot = tl[0].slot;
      for (const ev of tl) if (ev.arc <= arc + 1e-9) slot = ev.slot;
      return slot;
    };
    const stops: number[] = [...cum];
    for (const s of swaps) {
      if (swapInvolves(s, tl)) {
        stops.push(Math.max(0, s.arc - W), s.arc, Math.min(totalArc, s.arc + W));
      }
    }
    stops.sort((x, y) => x - y);
    const dedup: number[] = [];
    for (const a of stops) if (dedup.length === 0 || a - dedup[dedup.length - 1] > 1e-6) dedup.push(a);
    const poly: Pixel[] = dedup.map((arc) => {
      const slot = slotAt(arc);
      const o = (slot - center) * spacing + bias;
      const { p, n: nrm } = sampleBase(base, cum, arc);
      return [p[0] + nrm[0] * o, p[1] + nrm[1] * o] as Pixel;
    });
    out.set(line, poly);
  }
  return out;
}
