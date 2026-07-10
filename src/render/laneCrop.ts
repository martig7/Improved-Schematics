// Crop or extend a drawn lane polyline so its NODE end terminates exactly on an
// axis-aligned square box boundary (the rectangle-capsule seat). The polyline is
// oriented node-end-first: poly[0] is the end at the support node (the dot), and
// the rest runs outward along the corridor. Depending on where the box sits
// relative to the lane, the node end is either CUT back to the wall (the lane
// overshoots into or through the box) or EXTENDED out to the wall (the lane fell
// short). Both keep the result octilinear when the input is: a cut only trims an
// existing straight run, and an extension grows straight along the node-end
// direction.
//
// Determinism (offline output must equal in-game): Math.sqrt only (never
// Math.hypot, which is not correctly-rounded across V8 versions), a fixed
// box-edge scan order (left, right, top, bottom), and no Date / Math.random. The
// input polyline is never mutated; a fresh array is returned.

export type Vec2 = [number, number];

// Axis-aligned rectangle boundary.
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const EPS = 1e-9;

const isInside = (p: Vec2, b: Box): boolean =>
  p[0] >= b.x0 - EPS && p[0] <= b.x1 + EPS && p[1] >= b.y0 - EPS && p[1] <= b.y1 + EPS;

// Intersect the segment a->b with the box boundary. Returns the crossing with the
// SMALLEST along-segment parameter s in (EPS, 1], scanning box edges in the fixed
// order left, right, top, bottom so a corner hit resolves deterministically.
// s must be strictly positive so a segment starting exactly ON a wall does not
// re-report its own start as the crossing. Returns null when the segment does not
// reach the boundary.
function firstBoundaryHit(a: Vec2, b: Vec2, box: Box): { s: number; p: Vec2 } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let bestS = Infinity;
  let bestP: Vec2 | null = null;
  const consider = (s: number, p: Vec2) => {
    if (s > EPS && s <= 1 + EPS && s < bestS) {
      bestS = s;
      bestP = p;
    }
  };
  // left / right walls: constant x, y within [y0,y1].
  for (const wx of [box.x0, box.x1]) {
    if (Math.abs(dx) < EPS) continue;
    const s = (wx - a[0]) / dx;
    const y = a[1] + s * dy;
    if (y >= box.y0 - EPS && y <= box.y1 + EPS) consider(s, [wx, y]);
  }
  // top / bottom walls: constant y, x within [x0,x1].
  for (const wy of [box.y0, box.y1]) {
    if (Math.abs(dy) < EPS) continue;
    const s = (wy - a[1]) / dy;
    const x = a[0] + s * dx;
    if (x >= box.x0 - EPS && x <= box.x1 + EPS) consider(s, [x, wy]);
  }
  if (!bestP) return null;
  return { s: bestS, p: bestP };
}

/**
 * Crop (CUT ONLY) a node-end-first lane polyline so its node end lands on the box
 * boundary. `boxCenter` is the box center, `boxSide` its side length.
 *
 * - poly[0] INSIDE the box: drop leading inside vertices, cut at the first exit.
 * - poly[0] OUTSIDE and the polyline reaches the box: CUT to the first crossing.
 * - the lane never reaches the box: left UNCHANGED. The crop only trims a lane
 *   back to the capsule; it never fabricates geometry to reach it, so no stray
 *   segments are ever drawn.
 *
 * The input is never mutated; a polyline shorter than two points is copied
 * unchanged.
 */
export function cropLaneToBox(poly: Vec2[], boxCenter: Vec2, boxSide: number): Vec2[] {
  const h = boxSide / 2;
  return cropLaneToRect(poly, {
    x0: boxCenter[0] - h,
    x1: boxCenter[0] + h,
    y0: boxCenter[1] - h,
    y1: boxCenter[1] + h,
  });
}

/**
 * Crop a node-end-first lane polyline so its node end lands exactly on the
 * boundary of an arbitrary axis-aligned rectangle `box`. This is the capsule-
 * aware crop: pass the drawn CAPSULE rect (the group rounded-rect the line's box
 * belongs to) so the lane ends precisely at the shape that is painted.
 *
 * A lane that reaches the box is CUT at the boundary. A lane that stops short
 * of it is EXTENDED straight along its own end direction to the near wall, but
 * only when `maxExt` allows it: the extension must hit the box within `maxExt`
 * px or the lane is left unchanged. The default `maxExt` of 0 disables
 * extension entirely (pure cut). Extension never bends the lane and never
 * exceeds the cap, so it closes a short terminus gap without fabricating
 * branches toward distant geometry.
 */
export function cropLaneToRect(poly: Vec2[], box: Box, maxExt = 0): Vec2[] {
  if (poly.length < 2) return poly.map((p) => [p[0], p[1]] as Vec2);

  // Case A: node end already inside the box -> walk outward to the first exit.
  if (isInside(poly[0], box)) {
    for (let i = 1; i < poly.length; i++) {
      const hit = firstBoundaryHit(poly[i - 1], poly[i], box);
      if (hit) {
        const rest = poly.slice(i).map((p) => [p[0], p[1]] as Vec2);
        return [hit.p, ...rest];
      }
      // segment stayed inside; keep walking
    }
    // whole polyline lies inside the box (degenerate): return a copy unchanged.
    return poly.map((p) => [p[0], p[1]] as Vec2);
  }

  // Case B: node end outside -> the first boundary crossing walking outward is a
  // CUT (lane enters or passes through the box). Keep from that crossing on.
  for (let i = 1; i < poly.length; i++) {
    const hit = firstBoundaryHit(poly[i - 1], poly[i], box);
    if (hit) {
      const rest = poly.slice(i).map((p) => [p[0], p[1]] as Vec2);
      return [hit.p, ...rest];
    }
  }

  // The lane never reaches the box. With a positive maxExt, extend the node end
  // straight along its own direction (poly[1] -> poly[0], i.e. outward past the
  // node end) to the near wall, accepting the hit only within maxExt px. The
  // scan order is fixed (left, right, top, bottom) and the direction is the
  // lane's own, so nothing bends and nothing reaches far geometry.
  if (maxExt > 0) {
    const ux = poly[0][0] - poly[1][0];
    const uy = poly[0][1] - poly[1][1];
    const ulen = Math.sqrt(ux * ux + uy * uy);
    if (ulen > EPS) {
      let bestT = Infinity;
      let bestP: Vec2 | null = null;
      const consider = (t: number, p: Vec2) => {
        if (t > EPS && t < bestT) { bestT = t; bestP = p; }
      };
      for (const wx of [box.x0, box.x1]) {
        if (Math.abs(ux) < EPS) continue;
        const t = (wx - poly[0][0]) / ux;
        const y = poly[0][1] + t * uy;
        if (y >= box.y0 - EPS && y <= box.y1 + EPS) consider(t, [wx, y]);
      }
      for (const wy of [box.y0, box.y1]) {
        if (Math.abs(uy) < EPS) continue;
        const t = (wy - poly[0][1]) / uy;
        const x = poly[0][0] + t * ux;
        if (x >= box.x0 - EPS && x <= box.x1 + EPS) consider(t, [x, wy]);
      }
      if (bestP && bestT * ulen <= maxExt) {
        return [bestP, ...poly.map((p) => [p[0], p[1]] as Vec2)];
      }
    }
  }

  // Unreachable within the extension cap: leave the lane unchanged rather than
  // fabricate geometry.
  return poly.map((p) => [p[0], p[1]] as Vec2);
}
