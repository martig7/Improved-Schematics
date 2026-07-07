// Cross-station overlap rescue for the rectangle ("rectRows") Tokyu design.
//
// rectSeat prevents box overlap WITHIN a single interchange, but two DIFFERENT
// nearby stations can still overlap: adjacent single boxes touch, and a single
// box can sit on top of an interchange capsule. This paint-time rescue slides
// overlapping stops apart, mirroring the pill mode's mutual slide for adjacent
// stations: the bigger interchange claims space first and each later stop is
// nudged out of whatever it collides with.
//
// The rescue mutates the scenes in place. It is called only for the Tokyu
// design (the caller gates on design.capsule === 'rectRows'), so it processes
// EVERY scene it receives and computes each stop's full painted footprint by
// capsule kind. Designs that never emit rectRows never reach here, so their
// output is byte-identical.
//
// Fully deterministic: fixed placement order, fixed tie-breaks, no Math.random
// / Date, and any distance uses Math.sqrt (Math.hypot is not correctly rounded
// across V8 versions).

import type { StopScene, Point } from '../stations/types';

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

/** The stop's full painted footprint (unexpanded), by capsule kind, plus the
 *  per-kind clearance margin. Returns null for a footprint we cannot place. */
function footprintOf(scene: StopScene): { box: AABB; margin: number } | null {
  const cap = scene.capsule;
  const r = scene.dotRadius;
  if (cap.kind === 'rectRows') {
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

  const margin = 3 * r * MARGIN_FRAC;

  if (cap.kind === 'none') {
    // The single-stop box the paint draws: side 3*dotRadius centered at anchor.
    const half = (3 * r) / 2;
    return { box: { x0: scene.anchor[0] - half, y0: scene.anchor[1] - half, x1: scene.anchor[0] + half, y1: scene.anchor[1] + half }, margin };
  }
  if (cap.kind === 'box') {
    return { box: { x0: cap.x, y0: cap.y, x1: cap.x + cap.w, y1: cap.y + cap.h }, margin };
  }
  if (cap.kind === 'ring') {
    return { box: { x0: cap.cx - cap.r, y0: cap.cy - cap.r, x1: cap.cx + cap.r, y1: cap.cy + cap.r }, margin };
  }
  if (cap.kind === 'pill') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of cap.points) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    if (x0 === Infinity) return null;
    // Expand by the dot radius so the footprint covers the rounded pill caps.
    return { box: { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r }, margin };
  }
  return null;
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

/** Shift every positional field of a scene by (dx, dy) in place, per its kind. */
function translateScene(scene: StopScene, dx: number, dy: number): void {
  scene.anchor = [scene.anchor[0] + dx, scene.anchor[1] + dy];
  for (const ln of scene.lines) {
    ln.pos = [ln.pos[0] + dx, ln.pos[1] + dy];
  }
  const cap = scene.capsule;
  if (cap.kind === 'rectRows') {
    for (const g of cap.groups) {
      g.x += dx;
      g.y += dy;
    }
    for (const c of cap.connectors) {
      c.points = c.points.map((p): Point => [p[0] + dx, p[1] + dy]);
    }
  } else if (cap.kind === 'box') {
    cap.x += dx;
    cap.y += dy;
  } else if (cap.kind === 'ring') {
    cap.cx += dx;
    cap.cy += dy;
  } else if (cap.kind === 'pill') {
    cap.points = cap.points.map((p): Point => [p[0] + dx, p[1] + dy]);
  }
}

/**
 * Slide overlapping Tokyu stops apart. Every scene is processed (the caller
 * gates the whole rescue on the Tokyu design). Mutates `scenes` in place.
 *
 * Placement queue: scenes ordered by member count (scene.lines.length)
 * descending, then nodeId ascending, so the biggest interchange claims space
 * first and single boxes yield. Each stop is then pushed out of already-placed
 * stops greedily: up to MAX_ITERS times, against ALL currently-overlapping
 * placed footprints, take the max X-penetration and max Y-penetration, and push
 * along whichever axis clears with the smaller move (tie -> X) by
 * penetration + margin, away from the overlapping mass' center. This clears a
 * stop wedged between two neighbors without oscillating. The net translation is
 * applied once, and the shifted (expanded) footprint joins the placed list.
 */
export function rescueRectCapsules(scenes: StopScene[]): void {
  if (scenes.length < 2) return;

  const items: Array<{ scene: StopScene; box: AABB; margin: number }> = [];
  for (const scene of scenes) {
    const fp = footprintOf(scene);
    if (fp) items.push({ scene, box: fp.box, margin: fp.margin });
  }
  if (items.length < 2) return;

  const order = items.slice().sort((a, b) =>
    (b.scene.lines.length - a.scene.lines.length) ||
    (a.scene.nodeId < b.scene.nodeId ? -1 : a.scene.nodeId > b.scene.nodeId ? 1 : 0));

  const placed: AABB[] = [];

  for (const { scene, box, margin } of order) {
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

    if (dx !== 0 || dy !== 0) translateScene(scene, dx, dy);
    placed.push({
      x0: base.x0 + dx, y0: base.y0 + dy,
      x1: base.x1 + dx, y1: base.y1 + dy,
    });
  }
}
