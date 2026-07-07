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

// Axis-aligned square boundary from center + side.
interface Box {
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

// Intersect the ray from `origin` in direction `u` (need not be unit) with the box
// boundary, returning the nearest strictly-positive-t hit. Same fixed wall scan
// order. Used to EXTEND a lane that stopped short of the box.
function nearestRayHit(origin: Vec2, u: Vec2, box: Box): Vec2 | null {
  let bestT = Infinity;
  let bestP: Vec2 | null = null;
  const consider = (t: number, p: Vec2) => {
    if (t > EPS && t < bestT) {
      bestT = t;
      bestP = p;
    }
  };
  for (const wx of [box.x0, box.x1]) {
    if (Math.abs(u[0]) < EPS) continue;
    const t = (wx - origin[0]) / u[0];
    const y = origin[1] + t * u[1];
    if (y >= box.y0 - EPS && y <= box.y1 + EPS) consider(t, [wx, y]);
  }
  for (const wy of [box.y0, box.y1]) {
    if (Math.abs(u[1]) < EPS) continue;
    const t = (wy - origin[1]) / u[1];
    const x = origin[0] + t * u[0];
    if (x >= box.x0 - EPS && x <= box.x1 + EPS) consider(t, [x, wy]);
  }
  if (!bestP) return null;
  return bestP;
}

/**
 * Crop or extend a node-end-first lane polyline so its node end lands on the box
 * boundary. `boxCenter` is the box center, `boxSide` its side length.
 *
 * - poly[0] INSIDE the box: drop leading inside vertices, cut at the first exit
 *   crossing (the exit becomes the new node end).
 * - poly[0] OUTSIDE and the polyline reaches the box: CUT to the first boundary
 *   crossing walking from the node end outward (keep the crossing and every
 *   vertex beyond it).
 * - poly[0] OUTSIDE and the polyline never reaches the box: EXTEND. Cast a ray
 *   from the node end along the node-end direction unit(poly[0]-poly[1]) and
 *   prepend the nearest boundary hit.
 *
 * The input is never mutated. A polyline shorter than two points is returned
 * as a shallow copy unchanged (nothing to crop).
 */
export function cropLaneToBox(poly: Vec2[], boxCenter: Vec2, boxSide: number): Vec2[] {
  if (poly.length < 2) return poly.map((p) => [p[0], p[1]] as Vec2);
  const h = boxSide / 2;
  const box: Box = {
    x0: boxCenter[0] - h,
    x1: boxCenter[0] + h,
    y0: boxCenter[1] - h,
    y1: boxCenter[1] + h,
  };

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

  // Case C: the whole lane is outside and never reaches the box -> EXTEND. The
  // node-end direction points from poly[1] toward poly[0] (outward past the node
  // end); casting a ray that way toward the box gives the near wall.
  const u: Vec2 = [poly[0][0] - poly[1][0], poly[0][1] - poly[1][1]];
  const hit = nearestRayHit(poly[0], u, box);
  if (hit) {
    return [hit, ...poly.map((p) => [p[0], p[1]] as Vec2)];
  }

  // No reachable box in either direction (the lane points away from the box):
  // leave it unchanged rather than fabricate geometry.
  return poly.map((p) => [p[0], p[1]] as Vec2);
}
