// Pure geometry for the mutual capsule-slide collision resolver (spec
// 2026-06-15-capsule-mutual-slide). A capsule's spine is approximated by a
// HULL: its consecutive chain-pair segments at a fill+border half-width. Two
// capsules "clear" when the penetration between their hulls drops to a small
// negative margin. `chooseMutualSlide` searches the grid of each capsule's
// reachable lane offsets for the least-total-slide pair that clears, falling
// back to the least-penetration pair (best effort) when none does.
//
// Extracted verbatim (segSegDist/penBetween) from renderOctilinear.ts so the
// collision resolver can be unit-tested in isolation; the render code feeds
// precomputed hull-per-offset arrays and applies the returned indices.

import type { Pixel } from './types';

export interface HullSeg {
  a: Pixel;
  b: Pixel;
  half: number;
}
export type Hull = HullSeg[];

function ptSeg(px: number, py: number, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / l2)) : 0;
  return Math.sqrt((px - (a[0] + vx * t)) ** 2 + (py - (a[1] + vy * t)) ** 2); // correctly-rounded cross-V8
}

/** Endpoint-min approximation of the distance between two segments — exact for
 *  non-crossing segments (spine hulls in practice). Verbatim from the render. */
export function segSegDist(a1: Pixel, b1: Pixel, a2: Pixel, b2: Pixel): number {
  return Math.min(
    ptSeg(a1[0], a1[1], a2, b2),
    ptSeg(b1[0], b1[1], a2, b2),
    ptSeg(a2[0], a2[1], a1, b1),
    ptSeg(b2[0], b2[1], a1, b1),
  );
}

/** Penetration between two hulls: max over segment pairs of (halfA + halfB −
 *  gap). > 0 ⇒ overlapping; ≤ 0 ⇒ clear with that much slack. */
export function penBetween(A: Hull, B: Hull): number {
  let pen = -Infinity;
  for (const ha of A) {
    for (const hb of B) {
      pen = Math.max(pen, ha.half + hb.half - segSegDist(ha.a, ha.b, hb.a, hb.b));
    }
  }
  return pen;
}

/** Pick the pair of lane offsets that resolves an overlap. `hullsA[ka]` /
 *  `hullsB[kb]` are each capsule's spine hull at offset index k (k = 0 = rest;
 *  higher k = slid farther apart). Returns the cleared cell (`penBetween ≤
 *  clearAt`) with the least total slide `ka + kb`; if none clears, the cell with
 *  the least residual penetration (tie-break least total slide) — best effort. */
export function chooseMutualSlide(
  hullsA: Hull[],
  hullsB: Hull[],
  clearAt = -1,
): { ka: number; kb: number } {
  let best = { ka: 0, kb: 0 };
  let bestCleared = false;
  let bestTotal = Infinity;
  let bestPen = Infinity;
  for (let ka = 0; ka < hullsA.length; ka++) {
    for (let kb = 0; kb < hullsB.length; kb++) {
      const pen = penBetween(hullsA[ka], hullsB[kb]);
      const total = ka + kb;
      const cleared = pen <= clearAt;
      if (cleared) {
        // any cleared cell beats any uncleared one; among cleared, least total
        if (!bestCleared || total < bestTotal) {
          best = { ka, kb };
          bestCleared = true;
          bestTotal = total;
        }
      } else if (!bestCleared) {
        // best-effort: least penetration, tie-break least total slide
        if (pen < bestPen || (pen === bestPen && total < bestTotal)) {
          best = { ka, kb };
          bestPen = pen;
          bestTotal = total;
        }
      }
    }
  }
  return best;
}
