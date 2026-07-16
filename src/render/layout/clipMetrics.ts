// Foreign-ink overlap detector for the FINAL painted ribbons. A clip is one
// line's ink running alongside ANOTHER line's ink closer than the lane pitch,
// nearly parallel, for a sustained arc: the line rides through a neighbouring
// bundle's paint instead of keeping clear of it (or joining it as a member).
// This happens when a bundle's painted width outgrows the clearance the
// zero-width layout gave its neighbours, and at junction pockets where corner
// sweeps cross a diverging corridor at a shallow angle. Honest steep crossings
// stay silent (their sub-pitch approach arc is shorter than the run
// threshold), and same-bundle members stay silent (member lanes sit a full
// pitch apart; nodal tapers dip closer only briefly).

import type { Pixel } from './types';

export type InkSeg = [Pixel, Pixel];

export interface InkRef {
  id: string;
  segs: InkSeg[];
}

export interface InkClip {
  idA: string;
  idB: string;
  run: number; // arc length of the sustained overlap, px
  at: Pixel; // midpoint of the overlap run
}

/** Uniform grid over one ink's segments for near-neighbour lookup. */
class SegGrid {
  private cell: number;
  private map = new Map<string, number[]>();
  constructor(private segs: InkSeg[], cell: number) {
    this.cell = cell;
    for (let i = 0; i < segs.length; i++) {
      const [p, q] = segs[i];
      const x0 = Math.floor(Math.min(p[0], q[0]) / cell);
      const x1 = Math.floor(Math.max(p[0], q[0]) / cell);
      const y0 = Math.floor(Math.min(p[1], q[1]) / cell);
      const y1 = Math.floor(Math.max(p[1], q[1]) / cell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = x + ',' + y;
          const b = this.map.get(k);
          if (b) b.push(i); else this.map.set(k, [i]);
        }
      }
    }
  }
  /** Nearest segment to x within one cell ring; returns squared distance and
   *  the segment's unit direction, or null when nothing is close. */
  nearest(x: Pixel): { d2: number; dir: Pixel } | null {
    const cx = Math.floor(x[0] / this.cell);
    const cy = Math.floor(x[1] / this.cell);
    let bd2 = Infinity;
    let bdir: Pixel | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.map.get((cx + dx) + ',' + (cy + dy));
        if (!bucket) continue;
        for (const i of bucket) {
          const [p, q] = this.segs[i];
          const vx = q[0] - p[0];
          const vy = q[1] - p[1];
          const len2 = vx * vx + vy * vy;
          if (len2 < 1e-12) continue;
          let t = ((x[0] - p[0]) * vx + (x[1] - p[1]) * vy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx2 = x[0] - (p[0] + vx * t);
          const dy2 = x[1] - (p[1] + vy * t);
          const d2 = dx2 * dx2 + dy2 * dy2;
          if (d2 < bd2) {
            bd2 = d2;
            const len = Math.sqrt(len2);
            bdir = [vx / len, vy / len];
          }
        }
      }
    }
    return bdir ? { d2: bd2, dir: bdir } : null;
  }
}

const bboxOf = (segs: InkSeg[]): [number, number, number, number] => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [p, q] of segs) {
    if (p[0] < x0) x0 = p[0];
    if (q[0] < x0) x0 = q[0];
    if (p[0] > x1) x1 = p[0];
    if (q[0] > x1) x1 = q[0];
    if (p[1] < y0) y0 = p[1];
    if (q[1] < y0) y0 = q[1];
    if (p[1] > y1) y1 = p[1];
    if (q[1] > y1) y1 = q[1];
  }
  return [x0, y0, x1, y1];
};

/** Sustained near-parallel sub-pitch overlaps between two inks' drawn
 *  segments. distMax: closer than this counts as riding the other's paint.
 *  runMin: a flagged stretch must persist at least this long, which also keeps
 *  steep honest crossings silent (their sub-distMax window is ~2*distMax/sin
 *  of the crossing angle). Deterministic: caller-supplied order, plain loops. */
export function findInkClips(
  inks: InkRef[],
  distMax: number,
  runMin: number,
  parallelCos = 0.866,
): InkClip[] {
  const out: InkClip[] = [];
  const boxes = inks.map((l) => bboxOf(l.segs));
  const grids = new Map<number, SegGrid>();
  const gridOf = (j: number): SegGrid => {
    let g = grids.get(j);
    if (!g) grids.set(j, (g = new SegGrid(inks[j].segs, Math.max(8, distMax * 2))));
    return g;
  };
  const step = Math.max(2, distMax / 2);
  for (let i = 0; i < inks.length; i++) {
    const A = inks[i];
    if (A.segs.length === 0) continue;
    for (let j = i + 1; j < inks.length; j++) {
      const B = inks[j];
      if (B.segs.length === 0) continue;
      const ba = boxes[i];
      const bb = boxes[j];
      if (
        ba[0] > bb[2] + distMax || bb[0] > ba[2] + distMax ||
        ba[1] > bb[3] + distMax || bb[1] > ba[3] + distMax
      ) continue;
      const grid = gridOf(j);
      // Walk ink A in draw order at fixed arc steps; flag samples that sit
      // sub-pitch from ink B while running near-parallel to it. Runs continue
      // across contiguous segments and close at draw-order jumps.
      let run = 0;
      let runStart: Pixel | null = null;
      let last: Pixel | null = null;
      let best: { run: number; at: Pixel } | null = null;
      const closeRun = (): void => {
        if (runStart && last && run >= runMin) {
          const at: Pixel = [(runStart[0] + last[0]) / 2, (runStart[1] + last[1]) / 2];
          const b = best as { run: number; at: Pixel } | null;
          if (!b || run > b.run) best = { run, at };
        }
        run = 0;
        runStart = null;
      };
      let prevEnd: Pixel | null = null;
      for (const [p, q] of A.segs) {
        if (prevEnd && (Math.abs(prevEnd[0] - p[0]) > 1e-6 || Math.abs(prevEnd[1] - p[1]) > 1e-6)) {
          closeRun();
          last = null;
        }
        prevEnd = q;
        const segLen = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2);
        if (segLen < 1e-9) continue;
        const da: Pixel = [(q[0] - p[0]) / segLen, (q[1] - p[1]) / segLen];
        for (let t = 0; t <= segLen; t += step) {
          const x: Pixel = [p[0] + da[0] * t, p[1] + da[1] * t];
          const near = grid.nearest(x);
          const hit = near !== null &&
            near.d2 <= distMax * distMax &&
            Math.abs(da[0] * near.dir[0] + da[1] * near.dir[1]) >= parallelCos;
          if (hit) {
            if (!runStart) runStart = x;
            else if (last) run += Math.sqrt((x[0] - last[0]) ** 2 + (x[1] - last[1]) ** 2);
            last = x;
          } else {
            closeRun();
            last = x;
          }
        }
      }
      closeRun();
      const b = best as { run: number; at: Pixel } | null;
      if (b) out.push({ idA: A.id, idB: B.id, run: b.run, at: b.at });
    }
  }
  return out;
}
