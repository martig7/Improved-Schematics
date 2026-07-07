/**
 * Placement: design-agnostic station geometry. Given the solved marks for a
 * node, produce a StopScene (dot data + capsule shape). No colors, no painting.
 * Ported from the geometry half of the former render/stops.ts.
 */

import type { Pixel, StopMark } from '../layout/types';
import { LINE_WIDTH, LINE_GAP, MEGA_BOXES, MARKER_SCALE } from '../constants';
import { rdpSimplify } from '../layout/chainPlace';
import { debugMegaBox } from '../debug/stops.debug';
import type { StopScene, StopLine, Capsule, Point } from './types';

const R0 = LINE_WIDTH * 0.7;
const RCAP = R0 * MARKER_SCALE;
const SPACING = LINE_WIDTH + LINE_GAP;

export interface PlacementCtx {
  megaFallback: 'box' | 'curve';
  members?: Map<string, number>;
  deg?: Map<string, number>;
}

const toLine = (mk: StopMark): StopLine => ({
  lineId: mk.lineId,
  color: mk.color,
  bullet: mk.name ?? '',
  textColor: mk.textColor ?? '',
  pos: [mk.pos[0], mk.pos[1]],
  chain: mk.chain ?? 0,
  seq: mk.seq,
});

const median = (vals: number[]): number => {
  const s = vals.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function buildScene(nodeId: string, marks: StopMark[], ctx: PlacementCtx): StopScene {
  const isCapsule = marks.length > 1;
  const dotRadius = isCapsule ? RCAP : R0;
  const lines = marks.map(toLine);

  // farthest pair: axis start (a) + max separation (best)
  let ai = 0;
  let best = 0;
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const d = Math.sqrt((marks[i].pos[0] - marks[j].pos[0]) ** 2 + (marks[i].pos[1] - marks[j].pos[1]) ** 2);
      if (d > best) { best = d; ai = i; }
    }
  }
  const a = marks[ai].pos;

  if (!isCapsule) {
    return { nodeId, lines, capsule: { kind: 'none' }, anchor: [a[0], a[1]], dotRadius };
  }

  const members = ctx.members?.get(nodeId);
  const megaEligible = members !== undefined ? members > 1 : marks.length > 1;
  const isMega = marks.some((m) => m.mega) || (MEGA_BOXES && megaEligible && (ctx.deg?.get(nodeId) ?? 0) >= 12);

  if (isMega) {
    const pad = R0 + 7;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const mk of marks) {
      x0 = Math.min(x0, mk.pos[0]); y0 = Math.min(y0, mk.pos[1]);
      x1 = Math.max(x1, mk.pos[0]); y1 = Math.max(y1, mk.pos[1]);
    }
    const cap = Math.max(2 * R0, marks.length * SPACING * 1.5);
    const mx = median(marks.map((m) => m.pos[0]));
    const my = median(marks.map((m) => m.pos[1]));
    x0 = Math.max(x0, mx - cap / 2); x1 = Math.min(x1, mx + cap / 2);
    y0 = Math.max(y0, my - cap / 2); y1 = Math.min(y1, my + cap / 2);
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const minSide = 2 * R0 + 3;
    if (x1 - x0 < minSide) { const c = (x0 + x1) / 2; x0 = c - minSide / 2; x1 = c + minSide / 2; }
    if (y1 - y0 < minSide) { const c = (y0 + y1) / 2; y0 = c - minSide / 2; y1 = c + minSide / 2; }
    debugMegaBox(nodeId, marks, x0, y0, x1, y1);

    if (ctx.megaFallback === 'curve') {
      let pi = 0, pj = 0, pbest = -1;
      for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) {
        const dx = marks[i].pos[0] - marks[j].pos[0], dy = marks[i].pos[1] - marks[j].pos[1];
        const dd = dx * dx + dy * dy;
        if (dd > pbest) { pbest = dd; pi = i; pj = j; }
      }
      const A = marks[pi].pos, B = marks[pj].pos;
      let axx = B[0] - A[0], axy = B[1] - A[1];
      const alen = Math.sqrt(axx * axx + axy * axy) || 1;
      axx /= alen; axy /= alen;
      const orderedPos = marks
        .map((m, i) => ({ p: m.pos as Point, t: (m.pos[0] - A[0]) * axx + (m.pos[1] - A[1]) * axy, i }))
        .sort((u, v) => (u.t - v.t) || (u.i - v.i))
        .map((u) => u.p);
      const spine = rdpSimplify(orderedPos, 0.75) as Point[];
      const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
      const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
      return { nodeId, lines, capsule: { kind: 'pill', points: spine, smooth: true }, anchor: [cx, cy], dotRadius };
    }
    // box: opaque cover, no per-line dots
    return { nodeId, lines: [], capsule: { kind: 'box', x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: R0 + 1.5 }, anchor: [(x0 + x1) / 2, (y0 + y1) / 2], dotRadius };
  }

  if (best < 1e-3) {
    return { nodeId, lines, capsule: { kind: 'ring', cx: a[0], cy: a[1], r: R0 + 3 }, anchor: [a[0], a[1]], dotRadius };
  }

  const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
  const vertices: Pixel[] = [];
  for (const mk of ordered) {
    vertices.push(mk.pos);
    if (mk.cornerAfter) vertices.push(mk.cornerAfter);
  }
  const spine = rdpSimplify(vertices, 0.75) as Point[];
  const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
  const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
  return { nodeId, lines, capsule: { kind: 'pill', points: spine, smooth: false }, anchor: [cx, cy], dotRadius };
}
