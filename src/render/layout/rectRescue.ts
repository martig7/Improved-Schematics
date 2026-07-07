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
// applies the resolved net shift to the underlying object.
interface RescueItem {
  id: string;
  memberCount: number;
  box: AABB;
  margin: number;
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

  for (const { box, margin, translate } of order) {
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
      // Push along the axis that clears with the smaller move (tie -> X), away
      // from the overlapping mass' center on that axis.
      if (maxOx <= maxOy) {
        const dir = curCx >= sumHitCx / hitCount ? 1 : -1;
        dx += dir * (maxOx + margin);
      } else {
        const dir = curCy >= sumHitCy / hitCount ? 1 : -1;
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
// 3*R0, so the footprint here equals the box the design renders at mark.pos).
export interface SingleStop {
  nodeId: string;
  pos: [number, number];
  box: number;
}

/**
 * Compute-time cross-station rescue over the FULL Tokyu stop set: the multi-line
 * capsules in `byNode` AND the single stops in `singles`. Both feed one shared
 * placement queue so a single box and an interchange capsule deconflict against
 * each other exactly as the former draw-time rescue did (biggest-first: member
 * count then nodeId; interchanges anchor, singles yield). Interchange capsules
 * are mutated in place; each single's rescued marker position is returned keyed
 * by nodeId.
 *
 * The single footprint mirrors the scene path's `kind: 'none'` case: a box of
 * side `box` centered at `pos`, with margin `box * MARGIN_FRAC`. Fully
 * deterministic (fixed order, fixed tie-breaks, sqrt-based distance in the core).
 */
export function rescueRectAndSingles(
  byNode: Map<string, RectCapsule>,
  singles: SingleStop[],
): Map<string, [number, number]> {
  const items: RescueItem[] = [];

  for (const [nodeId, cap] of byNode) {
    const fp = capsuleFootprint(cap);
    if (fp) items.push({
      id: nodeId,
      memberCount: cap.centers.length,
      box: fp.box,
      margin: fp.margin,
      translate: (dx, dy) => translateCapsule(cap, dx, dy),
    });
  }

  // Every single is recorded and returned (deterministic and small), so the
  // paint can look up any Tokyu single by nodeId; those the rescue leaves in
  // place simply return their input position.
  const pos = new Map<string, [number, number]>();
  for (const s of singles) {
    const half = s.box / 2;
    const cur: [number, number] = [s.pos[0], s.pos[1]];
    pos.set(s.nodeId, cur);
    items.push({
      id: s.nodeId,
      memberCount: 1,
      box: { x0: cur[0] - half, y0: cur[1] - half, x1: cur[0] + half, y1: cur[1] + half },
      margin: s.box * MARGIN_FRAC,
      translate: (dx, dy) => { cur[0] += dx; cur[1] += dy; },
    });
  }

  rescueFootprints(items);
  return pos;
}
