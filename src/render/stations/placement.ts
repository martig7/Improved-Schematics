/**
 * Placement: design-agnostic station geometry. Given the solved marks for a
 * node, produce a StopScene (dot data + capsule shape). No colors, no painting.
 * Ported from the geometry half of the former render/stops.ts.
 */

import type { Pixel, StopMark } from '../layout/types';
import { LINE_WIDTH, LINE_GAP, MARKER_SCALE, MARK_R0 } from '../constants';
import { rdpSimplify } from '../layout/chainPlace';
import { type RectCapsule } from '../layout/rectSeat';
import { type LondonCapsule } from '../layout/londonBubbles';
import { debugMegaBox } from '../debug/stops.debug';
import type { StopScene, StopLine, Capsule, Point } from './types';

const R0 = MARK_R0;
const RCAP = R0 * MARKER_SCALE;
const SPACING = LINE_WIDTH + LINE_GAP;

export interface PlacementCtx {
  megaFallback: 'box' | 'curve';
  /** Interchange capsule regime the active design wants. 'rectRows' triggers the
   *  upright-box rectangle seating for multi-line, non-mega stations;
   *  'londonBubbles' the paired ticket-hall bubbles; 'toronto' the crossing
   *  collapse (perfect intersections become one dot, else a pill). */
  capsuleMode?: 'pill' | 'rectRows' | 'londonBubbles' | 'toronto';
  /** Precomputed rectangle-capsule geometry per node (seated + cross-station
   *  deconflicted at compute time). Read only in the 'rectRows' branch; when a
   *  node has an entry the scene is built from it with no draw-time seating. */
  rectByNode?: Map<string, RectCapsule>;
  /** Precomputed rescued marker position of each single Tokyu stop. Read only in
   *  the 'rectRows' branch; when set for a single stop the box is placed there. */
  tokyuStopPos?: Map<string, [number, number]>;
  /** Precomputed London bubble-chain geometry per node. Read only in the
   *  'londonBubbles' branch; when a node has an entry the scene is built from it. */
  bubbleByNode?: Map<string, LondonCapsule>;
  /** Precomputed Toronto direct-intersection centers per node. Read only in the
   *  'toronto' branch; a node with an entry collapses to one crossing dot. */
  torontoByNode?: Map<string, { cx: number; cy: number }>;
}

const toLine = (mk: StopMark): StopLine => ({
  lineId: mk.lineId,
  color: mk.color,
  bullet: mk.name ?? '',
  textColor: mk.textColor ?? '',
  pos: [mk.pos[0], mk.pos[1]],
  chain: mk.chain ?? 0,
  seq: mk.seq,
  axis: mk.axis,
  dir: mk.dir ? [mk.dir[0], mk.dir[1]] : undefined,
  terminus: mk.terminus,
  outward: mk.outward ? [mk.outward[0], mk.outward[1]] : undefined,
});

const median = (vals: number[]): number => {
  const s = vals.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Repaint memo of the pure mark-geometry pieces of a scene. Marks are final
// when paint starts and the cached geometry reuses the SAME array objects
// across repaints, so the array identity keys everything that depends only on
// mark positions: the farthest-pair axis, the pill spine, and both mega
// variants. The scene assembly itself stays live because it reads the
// draw-time toggles (megaFallback, capsuleMode). A deserialized cache has
// fresh array identities and simply refills the memo on its first paint.
interface SceneGeom {
  ai: number;    // farthest-pair axis start index
  best: number;  // farthest-pair separation
  pill?: { points: Point[]; anchor: Point };
  megaBB?: { x0: number; y0: number; x1: number; y1: number };
  megaSpine?: { points: Point[]; anchor: Point };
}
const sceneGeomMemo = new WeakMap<StopMark[], SceneGeom>();

export function buildScene(nodeId: string, marks: StopMark[], ctx: PlacementCtx): StopScene {
  const isCapsule = marks.length > 1;
  const dotRadius = isCapsule ? RCAP : R0;
  const lines = marks.map(toLine);

  // Rectangle ("Tokyu") seating: a multi-line station uses its compute-time
  // seated, cross-station-deconflicted rect capsule when one is cached, mega
  // interchanges included (they get a compact grid of numbered boxes rather than
  // an opaque cover). Seating is never done at draw time, so a cache miss falls
  // through to the normal pill / mega / ring / none paths. Single stops fall
  // through to the none path below.
  const cachedRect = ctx.capsuleMode === 'rectRows' && isCapsule
    ? ctx.rectByNode?.get(nodeId)
    : undefined;
  if (cachedRect) {
    const byLine = new Map(cachedRect.centers.map((c) => [c.lineId, [c.x, c.y] as Point]));
    const rlines = lines.map((ln) => ({ ...ln, pos: byLine.get(ln.lineId) ?? ln.pos }));
    let cx = 0, cy = 0;
    for (const c of cachedRect.centers) { cx += c.x; cy += c.y; }
    const n = cachedRect.centers.length || 1;
    const groups = cachedRect.groups.map((g) => ({ ...g }));
    const connectors = cachedRect.connectors.map((cn) => ({ points: cn.points.map((p): Point => [p[0], p[1]]) }));
    return { nodeId, lines: rlines, capsule: { kind: 'rectRows', box: cachedRect.box, groups, connectors, necks: cachedRect.necks }, anchor: [cx / n, cy / n], dotRadius };
  }

  // London bubbles: a multi-line station uses its compute-time bubble chain when
  // one is cached. Mega interchanges have no entry and fall through to the mega
  // box below; single stops fall through to the none path (a tick).
  const cachedBubble = ctx.capsuleMode === 'londonBubbles' && isCapsule
    ? ctx.bubbleByNode?.get(nodeId)
    : undefined;
  if (cachedBubble) {
    const bubbles = cachedBubble.bubbles.map((b) => ({ ...b }));
    const necks = cachedBubble.necks.map((n) => ({ ...n }));
    let cx = 0, cy = 0;
    for (const b of bubbles) { cx += b.x; cy += b.y; }
    const n = bubbles.length || 1;
    return { nodeId, lines, capsule: { kind: 'londonBubbles', bubbles, necks }, anchor: [cx / n, cy / n], dotRadius };
  }

  // Toronto direct intersection: a node whose lines truly cross at a point
  // collapses to one crossing dot; every other multi-line node falls through to
  // the pill below (a capsule with a dot per station).
  const cross = ctx.capsuleMode === 'toronto' && isCapsule ? ctx.torontoByNode?.get(nodeId) : undefined;
  if (cross) {
    return { nodeId, lines: [], capsule: { kind: 'ring', cx: cross.cx, cy: cross.cy, r: R0 + 3 }, anchor: [cross.cx, cross.cy], dotRadius };
  }

  // farthest pair: axis start (a) + max separation (best); memoized on the
  // marks array (positions are final for the life of the cached geometry)
  let gm = sceneGeomMemo.get(marks);
  if (!gm) {
    let ai = 0;
    let best = 0;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const d = Math.sqrt((marks[i].pos[0] - marks[j].pos[0]) ** 2 + (marks[i].pos[1] - marks[j].pos[1]) ** 2);
        if (d > best) { best = d; ai = i; }
      }
    }
    gm = { ai, best };
    sceneGeomMemo.set(marks, gm);
  }
  const best = gm.best;
  const a = marks[gm.ai].pos;

  if (!isCapsule) {
    // A single Tokyu stop uses its compute-time rescued position (deconflicted
    // against interchange capsules and other singles) when one is cached; the box
    // draws at the line's pos, so override both. Other designs never reach here
    // with a rectRows capsuleMode, so their singles keep the raw mark position.
    const rescued = ctx.capsuleMode === 'rectRows' ? ctx.tokyuStopPos?.get(nodeId) : undefined;
    const p: Point = rescued ? [rescued[0], rescued[1]] : [a[0], a[1]];
    const slines = rescued ? lines.map((ln) => ({ ...ln, pos: [p[0], p[1]] as Point })) : lines;
    return { nodeId, lines: slines, capsule: { kind: 'none' }, anchor: p, dotRadius };
  }

  // A station renders as a box only when the rigid-row solver could not seat its
  // marks and flagged them (mega fallback). There is no structural degree box.
  const isMega = marks.some((m) => m.mega);

  if (isMega) {
    // Both mega variants are pure mark geometry; the megaFallback CHOICE between
    // them is the only draw-time part, so each variant computes once per marks
    // array and repaints only pick.
    if (!gm.megaBB) {
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
      gm.megaBB = { x0, y0, x1, y1 };
    }
    const { x0, y0, x1, y1 } = gm.megaBB;
    debugMegaBox(nodeId, marks, x0, y0, x1, y1);

    if (ctx.megaFallback === 'curve') {
      if (!gm.megaSpine) {
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
        gm.megaSpine = { points: spine, anchor: [cx, cy] };
      }
      const ms = gm.megaSpine;
      // Defensive copies, mirroring the cachedRect branch: a consumer that
      // mutated a shared memoized array would corrupt every later repaint.
      return { nodeId, lines, capsule: { kind: 'pill', points: ms.points.map((p): Point => [p[0], p[1]]), smooth: true }, anchor: [ms.anchor[0], ms.anchor[1]], dotRadius };
    }
    // box: opaque cover, no per-line dots
    return { nodeId, lines: [], capsule: { kind: 'box', x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: R0 + 1.5 }, anchor: [(x0 + x1) / 2, (y0 + y1) / 2], dotRadius };
  }

  if (best < 1e-3) {
    return { nodeId, lines, capsule: { kind: 'ring', cx: a[0], cy: a[1], r: R0 + 3 }, anchor: [a[0], a[1]], dotRadius };
  }

  if (!gm.pill) {
    const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
    // The spine is the solver's exact chain: every dot, plus each elbow vertex
    // it emitted at a bundle bend. No simplification, so every dot sits on the
    // capsule centerline (and on the connector) and the solver's octilinear
    // bends are preserved. (RDP would flatten a shallow-but-real bend and float
    // its dot off-centre.)
    const spine: Point[] = [];
    for (const mk of ordered) {
      spine.push([mk.pos[0], mk.pos[1]]);
      if (mk.cornerAfter) spine.push([mk.cornerAfter[0], mk.cornerAfter[1]]);
    }
    const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
    const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
    gm.pill = { points: spine, anchor: [cx, cy] };
  }
  // Defensive copies, mirroring the cachedRect branch (see the mega variant).
  return { nodeId, lines, capsule: { kind: 'pill', points: gm.pill.points.map((p): Point => [p[0], p[1]]), smooth: false }, anchor: [gm.pill.anchor[0], gm.pill.anchor[1]], dotRadius };
}
