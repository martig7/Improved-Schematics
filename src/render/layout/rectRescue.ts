// Cross-station overlap rescue for the rectangle ("rectRows") Tokyu design.
//
// rectSeat prevents box overlap WITHIN a single interchange, but two DIFFERENT
// nearby stations can still overlap: adjacent single boxes touch, and a single
// box can sit on top of an interchange capsule. This compute-time rescue slides
// overlapping stops apart, mirroring the pill mode's mutual slide for adjacent
// stations: the bigger interchange claims space first and each later stop is
// nudged out of whatever it collides with.
//
// It runs once over the full Tokyu stop set (the interchange capsules and the
// single boxes together) at compute time, mutating each capsule in place and
// returning each single's rescued marker position. Designs that never emit
// rectRows never read the result, so their output is byte-identical.
//
// Fully deterministic: fixed placement order, fixed tie-breaks, no Math.random
// / Date, and any distance uses Math.sqrt (Math.hypot is not correctly rounded
// across V8 versions).

import type { RectCapsule } from './rectSeat';
import type { LaneCurve } from './chainPlace';
import { curvePoint, curveTangent } from './chainPlace';

// Clearance kept between footprints and applied when a stop is pushed out,
// scaled so it reads the same at every zoom. Cleared stops keep this gap, so
// they never touch corners.
const MARGIN_FRAC = 0.12;

// Cap on the push iterations per stop. Each iteration clears the current worst
// overlap along its cheaper axis; the cap keeps the routine bounded and
// deterministic even when a stop is wedged between several neighbors.
const MAX_ITERS = 64;

interface AABB {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Expand an AABB by a uniform margin on every side. */
function expand(b: AABB, m: number): AABB {
  return { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m };
}

/** Overlap width on each axis of two AABBs; <= 0 on an axis means no overlap. */
function overlap(a: AABB, b: AABB): { ox: number; oy: number } {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return { ox, oy };
}

// One item the placement core deconflicts: its member count and nodeId set the
// biggest-first order, its footprint AABB + margin drive the push, and `translate`
// applies the resolved net shift to the underlying object. `slide`, when set,
// constrains the push to that unit direction (a single stop slides ALONG its line
// so its box stays on the line instead of floating off perpendicular).
interface RescueItem {
  id: string;
  memberCount: number;
  box: AABB;
  margin: number;
  slide?: [number, number];
  translate: (dx: number, dy: number) => void;
}

/**
 * Slide overlapping footprints apart, mutating each item's object through its
 * `translate` callback.
 *
 * Placement queue: items ordered by member count descending, then id ascending,
 * so the biggest interchange claims space first and single boxes yield. Each
 * item is then pushed out of already-placed items greedily: up to MAX_ITERS
 * times, against ALL currently-overlapping placed footprints, take the max
 * X-penetration and max Y-penetration, and push along whichever axis clears with
 * the smaller move (tie -> X) by penetration + margin, away from the overlapping
 * mass' center. This clears a stop wedged between two neighbors without
 * oscillating. The net translation is applied once, and the shifted (expanded)
 * footprint joins the placed list. Fully deterministic: fixed order, fixed
 * tie-breaks, no Math.random / Date.
 */
function rescueFootprints(items: RescueItem[]): void {
  if (items.length < 2) return;

  const order = items.slice().sort((a, b) =>
    (b.memberCount - a.memberCount) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const placed: AABB[] = [];

  for (const { box, margin, slide, translate } of order) {
    const base = expand(box, margin);

    let dx = 0, dy = 0;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const cur: AABB = {
        x0: base.x0 + dx, y0: base.y0 + dy,
        x1: base.x1 + dx, y1: base.y1 + dy,
      };

      // Worst X- and Y-penetration across ALL currently-overlapping placed
      // footprints, and the center of that overlapping mass on each axis.
      let maxOx = 0, maxOy = 0;
      let sumHitCx = 0, sumHitCy = 0, hitCount = 0;
      for (const p of placed) {
        const { ox, oy } = overlap(cur, p);
        if (ox <= 0 || oy <= 0) continue;
        if (ox > maxOx) maxOx = ox;
        if (oy > maxOy) maxOy = oy;
        sumHitCx += (p.x0 + p.x1) / 2;
        sumHitCy += (p.y0 + p.y1) / 2;
        hitCount++;
      }
      if (hitCount === 0) break;

      const curCx = (cur.x0 + cur.x1) / 2;
      const curCy = (cur.y0 + cur.y1) / 2;
      const massCx = sumHitCx / hitCount, massCy = sumHitCy / hitCount;
      if (slide) {
        // Constrained: slide ALONG the line direction only. Moving a distance t
        // along the unit line clears an axis when t * |component| covers that
        // axis' penetration; the box separates as soon as EITHER axis clears, so
        // take the shorter of the two, in the sign that moves away from the mass.
        const [ux, uy] = slide;
        const au = Math.abs(ux), av = Math.abs(uy);
        const tX = au > 1e-9 ? (maxOx + margin) / au : Infinity;
        const tY = av > 1e-9 ? (maxOy + margin) / av : Infinity;
        const t = Math.min(tX, tY);
        if (!Number.isFinite(t)) break; // the line cannot clear this overlap
        const sign = (curCx - massCx) * ux + (curCy - massCy) * uy >= 0 ? 1 : -1;
        dx += sign * t * ux;
        dy += sign * t * uy;
      } else if (maxOx <= maxOy) {
        // Push along the axis that clears with the smaller move (tie -> X), away
        // from the overlapping mass' center on that axis.
        const dir = curCx >= massCx ? 1 : -1;
        dx += dir * (maxOx + margin);
      } else {
        const dir = curCy >= massCy ? 1 : -1;
        dy += dir * (maxOy + margin);
      }
    }

    if (dx !== 0 || dy !== 0) translate(dx, dy);
    placed.push({
      x0: base.x0 + dx, y0: base.y0 + dy,
      x1: base.x1 + dx, y1: base.y1 + dy,
    });
  }
}

/** The stop's full painted footprint for a cached rect capsule (the union of its
 *  group rects), plus the per-box clearance margin. Null when the capsule has no
 *  group rect to place. */
function capsuleFootprint(cap: RectCapsule): { box: AABB; margin: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of cap.groups) {
    if (g.x < x0) x0 = g.x;
    if (g.y < y0) y0 = g.y;
    if (g.x + g.w > x1) x1 = g.x + g.w;
    if (g.y + g.h > y1) y1 = g.y + g.h;
  }
  if (x0 === Infinity) return null;
  return { box: { x0, y0, x1, y1 }, margin: cap.box * MARGIN_FRAC };
}

/** Shift every positional field of a rect capsule by (dx, dy) in place. */
function translateCapsule(cap: RectCapsule, dx: number, dy: number): void {
  for (const c of cap.centers) { c.x += dx; c.y += dy; }
  for (const g of cap.groups) { g.x += dx; g.y += dy; }
  for (const cn of cap.connectors) {
    cn.points = cn.points.map((p): [number, number] => [p[0] + dx, p[1] + dy]);
  }
}

// A single (non-interchange) Tokyu stop feeding the compute-time rescue: its
// nodeId, marker position, the single-stop box side the paint draws (side 3*R0,
// so the footprint here equals the box the design renders at mark.pos), and the
// stop's drawn lane curve with the arc position of the marker on it.
export interface SingleStop {
  nodeId: string;
  pos: [number, number];
  box: number;
  /** The stop's drawn lane and the marker's arc position on it. A rescued single
   *  slides ALONG this curve (following bends, clamped to the drawn extent), so
   *  its box can never leave the line or run past the line's end. Absent when
   *  the stop has no drawn lane; the box then stays put and acts as an obstacle. */
  curve?: LaneCurve;
  t0?: number;
}

// Per-single slide bound: how far (arc px) a rescued box may travel from its
// marker. Escaping from under a wide capsule can need several box widths; the
// mutual relaxation (no box ever hops over a neighbour) and the lane-extent
// clamp are the real anti-marching protections, so the cap is generous and only
// backstops a pathological cascade.
const SINGLE_SLIDE_CAP_FRAC = 8;
const SINGLE_ITERS = 96;

/**
 * Compute-time cross-station rescue over the FULL Tokyu stop set. Two phases:
 *
 * 1. CAPSULES deconflict through the greedy footprint core (biggest first,
 *    sliding along their corridor axis), exactly as before.
 * 2. SINGLES then relax MUTUALLY along their own lane curves: every overlapping
 *    pair steps apart along each box's own lane (both move, so a dense chain
 *    spreads in place instead of one box hopping over its neighbours), and a
 *    box overlapping a placed capsule steps away along its lane. Arc positions
 *    are clamped to the drawn lane extent and to a per-box slide cap, so a box
 *    stays ON its line, inside its own stretch of it, and never slides past a
 *    line ending.
 *
 * Capsules are mutated in place; each single's rescued marker position is
 * returned keyed by nodeId. Fully deterministic: fixed scan orders, fixed index
 * tie-breaks, sqrt-based distance, and lane evaluation via curvePoint /
 * curveTangent.
 */
export function rescueRectAndSingles(
  byNode: Map<string, RectCapsule>,
  singles: SingleStop[],
  capDir?: Map<string, [number, number] | undefined>,
): Map<string, [number, number]> {
  const items: RescueItem[] = [];

  for (const [nodeId, cap] of byNode) {
    const fp = capsuleFootprint(cap);
    if (fp) items.push({
      id: nodeId,
      memberCount: cap.centers.length,
      box: fp.box,
      margin: fp.margin,
      slide: capDir?.get(nodeId),
      translate: (dx, dy) => translateCapsule(cap, dx, dy),
    });
  }
  rescueFootprints(items);

  // Phase 2: mutual along-lane relaxation of the singles. Capsule rects are
  // static obstacles; curveless singles are static too.
  const pos = new Map<string, [number, number]>();
  const movable: Array<{ s: SingleStop; t: number; lo: number; hi: number; cur: [number, number] }> = [];
  const staticBoxes: AABB[] = [];
  for (const [, cap] of byNode) {
    const fp = capsuleFootprint(cap);
    if (fp) staticBoxes.push(expand(fp.box, fp.margin));
  }
  for (const s of singles) {
    const cur: [number, number] = [s.pos[0], s.pos[1]];
    pos.set(s.nodeId, cur);
    if (s.curve && s.t0 !== undefined) {
      const total = s.curve.cum[s.curve.cum.length - 1];
      const cap = s.box * SINGLE_SLIDE_CAP_FRAC;
      movable.push({
        s, t: Math.max(0, Math.min(total, s.t0)), cur,
        lo: Math.max(0, s.t0 - cap), hi: Math.min(total, s.t0 + cap),
      });
    } else {
      const half = s.box / 2 + s.box * MARGIN_FRAC;
      staticBoxes.push({ x0: cur[0] - half, y0: cur[1] - half, x1: cur[0] + half, y1: cur[1] + half });
    }
  }
  const step = (movable.length ? movable[0].s.box : 1) * 0.3;
  const posOf = (m: { s: SingleStop; t: number }): [number, number] => {
    const p = curvePoint(m.s.curve!, m.t);
    return [p[0], p[1]];
  };
  for (let iter = 0; iter < SINGLE_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < movable.length; i++) {
      const mi = movable[i];
      const pi = posOf(mi);
      const halfI = mi.s.box / 2 + mi.s.box * MARGIN_FRAC;
      const clampI = (tt: number) => Math.max(mi.lo, Math.min(mi.hi, tt));
      // vs static obstacles: step away along own lane.
      for (const b of staticBoxes) {
        if (pi[0] + halfI <= b.x0 || b.x1 <= pi[0] - halfI || pi[1] + halfI <= b.y0 || b.y1 <= pi[1] - halfI) continue;
        const tg = curveTangent(mi.s.curve!, mi.t);
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        const proj = (pi[0] - cx) * tg[0] + (pi[1] - cy) * tg[1];
        const nt = clampI(mi.t + (proj >= 0 ? 1 : -1) * step);
        if (nt !== mi.t) { mi.t = nt; moved = true; }
      }
      // vs other movable singles: BOTH step apart along their own lanes.
      for (let j = i + 1; j < movable.length; j++) {
        const mj = movable[j];
        const pj = posOf(mj);
        const halfJ = mj.s.box / 2 + mj.s.box * MARGIN_FRAC;
        const lim = halfI + halfJ;
        if (Math.abs(pi[0] - pj[0]) >= lim || Math.abs(pi[1] - pj[1]) >= lim) continue;
        const tgi = curveTangent(mi.s.curve!, mi.t);
        const tgj = curveTangent(mj.s.curve!, mj.t);
        const si = (pi[0] - pj[0]) * tgi[0] + (pi[1] - pj[1]) * tgi[1];
        const sj = (pj[0] - pi[0]) * tgj[0] + (pj[1] - pi[1]) * tgj[1];
        // zero projections break the tie by index (opposite directions)
        const sgnI = si > 1e-9 ? 1 : si < -1e-9 ? -1 : -1;
        const sgnJ = sj > 1e-9 ? 1 : sj < -1e-9 ? -1 : 1;
        const ni = clampI(mi.t + sgnI * step);
        const nj = Math.max(mj.lo, Math.min(mj.hi, mj.t + sgnJ * step));
        if (ni !== mi.t) { mi.t = ni; moved = true; }
        if (nj !== mj.t) { mj.t = nj; moved = true; }
      }
    }
    if (!moved) break;
  }
  for (const m of movable) {
    const p = posOf(m);
    m.cur[0] = p[0];
    m.cur[1] = p[1];
  }
  return pos;
}
