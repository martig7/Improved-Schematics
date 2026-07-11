// Cross-station overlap rescue for the fallback rectangle ("rectRows") capsules.
//
// rectSeat prevents box overlap WITHIN a single interchange, but two DIFFERENT
// nearby fallback capsules can still overlap when their nodes sit close together.
// This compute-time rescue slides the overlapping capsules apart: the bigger
// interchange claims space first and each later capsule is nudged out of whatever
// it collides with, along its corridor axis.
//
// It runs once over the fallback capsules at compute time, mutating each capsule
// in place, and reports each single stop's marker position unchanged. A single
// reaching this rescue carries no drawn lane to slide along, so it holds its
// place; the along-lane deconfliction of lane-true stops runs in the lane seater.
// Designs that never emit rectRows never read the result, so their output is
// byte-identical.
//
// Fully deterministic: fixed placement order, fixed tie-breaks, no Math.random
// / Date, and any distance uses Math.sqrt (Math.hypot is not correctly rounded
// across V8 versions).

import type { RectCapsule } from './rectSeat';

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
// nodeId, marker position, and the single-stop box side the paint draws (side
// 3*R0, so the footprint here equals the box the design renders at mark.pos). A
// single reaching this rescue carries no drawn lane to slide along, so it holds
// its position; the box side sizes the stop's footprint for the caller.
export interface SingleStop {
  nodeId: string;
  pos: [number, number];
  box: number;
}

/**
 * Compute-time cross-station rescue over the fallback rectangle capsules. The
 * capsules deconflict through the greedy footprint core (biggest first, sliding
 * along their corridor axis), mutating each capsule in place. Each single stop's
 * marker position is returned unchanged: a single reaching this rescue has no
 * drawn lane to slide along, so it holds its place and its box acts only as a
 * fixed footprint for the downstream lane seater.
 *
 * Returns each single's marker position keyed by nodeId. Fully deterministic:
 * fixed scan order, fixed index tie-breaks, sqrt-based distance.
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

  const pos = new Map<string, [number, number]>();
  for (const s of singles) pos.set(s.nodeId, [s.pos[0], s.pos[1]]);
  return pos;
}
