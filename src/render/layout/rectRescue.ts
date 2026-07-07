// Cross-station overlap rescue for the rectangle ("rectRows") capsule.
//
// rectSeat prevents box overlap WITHIN a single interchange, but two DIFFERENT
// nearby stations' rect clusters can still overlap. This paint-time rescue
// slides overlapping rect clusters apart, mirroring the pill mode's mutual
// slide for adjacent stations: the bigger interchange claims space first and
// each later cluster is nudged out of whatever it collides with.
//
// The rescue mutates the scenes in place. Only rectRows scenes are considered
// or moved; pill / box / ring / none scenes are ignored and left untouched, so
// designs that never emit rectRows render byte-identically.
//
// Fully deterministic: fixed placement order, fixed tie-breaks, no Math.random
// / Date, and any distance uses Math.sqrt (Math.hypot is not correctly rounded
// across V8 versions).

import type { StopScene, Point } from '../stations/types';

// Clearance kept between clusters and applied when a cluster is pushed out,
// scaled to the box side so it reads the same at every zoom.
const MARGIN_FRAC = 0.12;

// Cap on the push iterations per cluster. Each iteration resolves the single
// worst overlap; a handful suffices for the small cluster counts in one node
// neighborhood, and the cap keeps the routine bounded and deterministic.
const MAX_ITERS = 8;

interface AABB {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Axis-aligned bounds of a scene's rectRows groups, expanded by `margin`. */
function sceneBounds(scene: StopScene, margin: number): AABB {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (scene.capsule.kind !== 'rectRows') return { x0, y0, x1, y1 };
  for (const g of scene.capsule.groups) {
    if (g.x < x0) x0 = g.x;
    if (g.y < y0) y0 = g.y;
    if (g.x + g.w > x1) x1 = g.x + g.w;
    if (g.y + g.h > y1) y1 = g.y + g.h;
  }
  return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
}

/** Overlap width on each axis of two AABBs; <= 0 on an axis means no overlap. */
function overlap(a: AABB, b: AABB): { ox: number; oy: number } {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return { ox, oy };
}

/** Shift every geometry field of a rectRows scene by (dx, dy) in place. */
function translateScene(scene: StopScene, dx: number, dy: number): void {
  if (scene.capsule.kind !== 'rectRows') return;
  for (const ln of scene.lines) {
    ln.pos = [ln.pos[0] + dx, ln.pos[1] + dy];
  }
  for (const g of scene.capsule.groups) {
    g.x += dx;
    g.y += dy;
  }
  for (const c of scene.capsule.connectors) {
    c.points = c.points.map((p): Point => [p[0] + dx, p[1] + dy]);
  }
  scene.anchor = [scene.anchor[0] + dx, scene.anchor[1] + dy];
}

/**
 * Slide overlapping rectRows clusters apart. Non-rectRows scenes are ignored
 * and unmoved. Mutates `scenes` in place.
 *
 * Placement queue: rect scenes ordered by member count (scene.lines.length)
 * descending, then nodeId ascending, so the biggest interchange claims space
 * first. Each cluster is then pushed out of already-placed clusters greedily:
 * up to MAX_ITERS times, resolve the single largest-area overlap by pushing
 * along the axis of smaller penetration (tie -> X), away from that cluster's
 * center, by penetration + margin. The net translation is applied once, and
 * the shifted bounds join the placed list.
 */
export function rescueRectCapsules(scenes: StopScene[]): void {
  const rects = scenes.filter((s) => s.capsule.kind === 'rectRows');
  if (rects.length < 2) return;

  const order = rects.slice().sort((a, b) =>
    (b.lines.length - a.lines.length) ||
    (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

  const placed: AABB[] = [];

  for (const scene of order) {
    const box = scene.capsule.kind === 'rectRows' ? scene.capsule.box : 0;
    const margin = box * MARGIN_FRAC;
    const base = sceneBounds(scene, margin);

    let dx = 0, dy = 0;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const cur: AABB = {
        x0: base.x0 + dx, y0: base.y0 + dy,
        x1: base.x1 + dx, y1: base.y1 + dy,
      };

      // Worst offender: the placed AABB with the largest overlap AREA against
      // the current (shifted) bounds; tie-break by placement index (first wins).
      let hitArea = 0;
      let hit: AABB | null = null;
      let hitOx = 0, hitOy = 0;
      for (const p of placed) {
        const { ox, oy } = overlap(cur, p);
        if (ox <= 0 || oy <= 0) continue;
        const area = ox * oy;
        if (area > hitArea) {
          hitArea = area;
          hit = p;
          hitOx = ox;
          hitOy = oy;
        }
      }
      if (!hit) break;

      // Push along the axis of smaller penetration (tie -> X), away from the
      // placed cluster's center, by penetration + margin.
      if (hitOx <= hitOy) {
        const curCx = (cur.x0 + cur.x1) / 2;
        const hitCx = (hit.x0 + hit.x1) / 2;
        const dir = curCx >= hitCx ? 1 : -1;
        dx += dir * (hitOx + margin);
      } else {
        const curCy = (cur.y0 + cur.y1) / 2;
        const hitCy = (hit.y0 + hit.y1) / 2;
        const dir = curCy >= hitCy ? 1 : -1;
        dy += dir * (hitOy + margin);
      }
    }

    if (dx !== 0 || dy !== 0) translateScene(scene, dx, dy);
    placed.push({
      x0: base.x0 + dx, y0: base.y0 + dy,
      x1: base.x1 + dx, y1: base.y1 + dy,
    });
  }
}
