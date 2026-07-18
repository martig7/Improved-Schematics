// Seat-ink cleanliness oracle (invariant I10, spec
// docs/superpowers/specs/2026-07-18-capsule-seat-cleanliness-design.md): a
// candidate stop-dot position is dirty when the mark's own line is OCCLUDED
// there, meaning a strand of a different-colored line with a HIGHER stroke
// rank (painted later, so visually on top) lies within the sub-pitch
// threshold of the dot. A marker on its own top-layer ink is clean no matter
// what runs underneath it. Graded by the proximity deficit; the seat solve
// adds the result as a soft cost, never a veto, so no station's feasibility
// class changes.

import type { Pixel } from './types';

export interface SeatInkArgs {
  /** Post-fan lane pieces: every drawn polyline with its owning line. */
  segments: Array<{ lineId: string; pts: Pixel[] }>;
  /** Fan join curves (quadratic a/apex/b), sampled into strands. */
  joinCurves: Array<{ lineId: string; a: Pixel; apex: Pixel; b: Pixel }>;
  /** Global stroke rank per line (paint order position; higher = on top). */
  strokeRank: Map<string, number>;
  /** Line color per line (same-color occlusion is invisible: excluded). */
  colorOf: Map<string, string>;
  spacing: number;
}

export interface SeatInkOracle {
  /** Occlusion depth at p for a mark of `lineId`: max over occluding
   *  strands of (threshold - distance), 0 when the line is top ink. */
  dirtAt(p: Pixel, lineId: string): number;
  /** Sub-pitch threshold (0.75 * spacing), exposed for census parity. */
  threshold: number;
}

interface Seg {
  ax: number; ay: number; bx: number; by: number;
  rank: number; color: string; lineId: string;
}

export function buildSeatInkOracle(args: SeatInkArgs): SeatInkOracle {
  // Sub-pitch threshold: the clip census's overlap distance, derived from
  // the lane pitch so a wider theme scales with it (I7).
  const threshold = 0.75 * args.spacing;
  const cell = Math.max(8, Math.ceil(threshold * 2));
  const grid = new Map<string, Seg[]>();
  // Padded insertion: a segment registers in every cell it comes within
  // `threshold` of, so a query reads ONLY its own cell and still sees every
  // strand that could occlude a point inside it.
  const put = (s: Seg) => {
    const x0 = Math.floor((Math.min(s.ax, s.bx) - threshold) / cell);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + threshold) / cell);
    const y0 = Math.floor((Math.min(s.ay, s.by) - threshold) / cell);
    const y1 = Math.floor((Math.max(s.ay, s.by) + threshold) / cell);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = gx + ',' + gy;
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(s);
      }
    }
  };
  const addPoly = (lineId: string, pts: Pixel[]) => {
    const rank = args.strokeRank.get(lineId);
    if (rank === undefined) return; // undrawn line: paints nowhere
    const color = (args.colorOf.get(lineId) ?? '').toLowerCase();
    for (let i = 1; i < pts.length; i++) {
      put({ ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1], rank, color, lineId });
    }
  };
  for (const s of args.segments) addPoly(s.lineId, s.pts);
  for (const jc of args.joinCurves) {
    const pts: Pixel[] = [];
    for (let k = 0; k <= 6; k++) {
      const u = k / 6;
      const w = 1 - u;
      pts.push([
        w * w * jc.a[0] + 2 * w * u * jc.apex[0] + u * u * jc.b[0],
        w * w * jc.a[1] + 2 * w * u * jc.apex[1] + u * u * jc.b[1],
      ]);
    }
    addPoly(jc.lineId, pts);
  }
  const dirtAt = (p: Pixel, lineId: string): number => {
    const myRank = args.strokeRank.get(lineId) ?? -Infinity;
    const myColor = (args.colorOf.get(lineId) ?? '').toLowerCase();
    const segs = grid.get(Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell));
    if (!segs) return 0;
    const t2 = threshold * threshold;
    let worst = 0;
    for (const s of segs) {
      if (s.lineId === lineId) continue;   // own ink (folds, retraces)
      if (s.rank <= myRank) continue;      // paints below: my ink is on top
      if (s.color === myColor) continue;   // invisible occlusion
      const vx = s.bx - s.ax, vy = s.by - s.ay;
      const len2 = vx * vx + vy * vy;
      let t = len2 > 1e-12 ? ((p[0] - s.ax) * vx + (p[1] - s.ay) * vy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = p[0] - (s.ax + vx * t), dy = p[1] - (s.ay + vy * t);
      const d2 = dx * dx + dy * dy;
      if (d2 >= t2) continue;
      const depth = threshold - Math.sqrt(d2);
      if (depth > worst) worst = depth;
    }
    return worst;
  };
  return { dirtAt, threshold };
}
