// Upright-box interchange seating solver for the rectangle ("rectRows") capsule.
//
// Each member line arrives with a pre-solve "home" (the point where the line
// passes the node) and an octilinear run axis. The solver seats a fixed-size
// upright box per member, packs boxes edge-to-edge into aligned rows or columns,
// and joins rows that cannot share an axis with a short octilinear connector.
//
// Boxes never rotate to the line direction (letters and numbers read upright);
// "on its line" means seated where the line passes, slid the minimum distance
// into a shared row. A group of boxes aligns along one axis, horizontal or
// vertical, whichever the cost model prefers given the members' homes.
//
// Objective (minimized): the sum of per-member slide (world-px distance from a
// member's home to its placed box center) plus a per-extra-row penalty, plus a
// hard penalty per pair of DIFFERENT groups whose padded capsule rects overlap or
// touch, so no two drawn capsules ever kiss. A single packed row (pitch =
// box + gap) is one capsule with no pair to test, so a touch-free layout always
// exists and any touch-free option beats any touching one. A separate row plus
// connector is preferred exactly when forcing its members into one shared row
// would cost more slide than the penalty. The penalty
//   K = 0.5 * maxSlideForcedRow
// where maxSlideForcedRow is the largest single-member slide incurred by forcing
// ALL members into one packed row (the worse of the two single-axis layouts).
// This is the "half of the max slide of merging into the main row" crossover.
//
// Search: for small member counts the set partitions are enumerable (Bell
// numbers stay tiny), and per part the axis is chosen from {H, V}; box order and
// row placement within a part are closed-form (sort by along-axis home, center on
// the median home), so no continuous search is needed. Large hubs skip the
// enumeration and seat as a single near-square stacked-row grid (ceil(sqrt(n))
// boxes per row, ceil(n/R) rows) so a many-line interchange reads as a compact
// block of numbered boxes rather than one illegibly wide row.
//
// Fully deterministic: no Math.random / Date; every tie-break resolves by a fixed
// index or lineId order, so offline output equals in-game output.

import type { Point } from '../stations/types';
import { octiConnect, type Rect } from './octiConnect';

// sqrt(a*a+b*b) is correctly-rounded across V8 versions; Math.hypot is not, so
// using it on the emitted-SVG path would render differently offline vs in-game.
const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface RectMember {
  lineId: string;
  home: Point;   // pre-solve lane position, world px
  axis: number;  // octilinear run axis index 0..3
}

export interface RectSeatOut {
  centers: Map<string, Point>;                                   // lineId -> placed box center
  groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>; // one rounded-rect per aligned row
  connectors: Array<{ points: Point[] }>;                        // octilinear polylines between rows
}

// Serialization-safe form of a seated rect capsule, cached on RibbonGeometry so
// the seating runs once at compute time instead of on every repaint. It holds
// ONLY plain arrays and objects (no nested Maps): the map-cache codec wraps a
// top-level Map but does not reliably round-trip a Map nested inside another
// Map's value, so `centers` is flattened to an array here.
export interface RectCapsule {
  box: number;                                                   // box side length, world px
  centers: Array<{ lineId: string; x: number; y: number }>;      // seated box center per line
  groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>; // one rounded-rect per aligned row
  connectors: Array<{ points: Array<[number, number]> }>;        // octilinear polylines between rows
}

/**
 * Convert a solver `RectSeatOut` into the serialization-safe `RectCapsule`:
 * flatten the `centers` Map into an array and round connector points to one
 * decimal (matching the emitted-SVG coordinate precision). `RectSeatOut` stays
 * the solver's native shape; this converts at the compute/cache boundary.
 */
export function rectSeatToCapsule(out: RectSeatOut, box: number): RectCapsule {
  const centers: RectCapsule['centers'] = [];
  for (const [lineId, c] of out.centers) centers.push({ lineId, x: c[0], y: c[1] });
  const groups = out.groups.map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, rx: g.rx }));
  const connectors = out.connectors.map((cn) => ({
    points: cn.points.map((p): [number, number] => [+p[0].toFixed(1), +p[1].toFixed(1)]),
  }));
  return { box, centers, groups, connectors };
}

// Above this member count the set-partition enumeration is skipped and the hub is
// seated as a stacked-row grid instead; at or below it, partitions are enumerated.
const ENUM_MAX = 6;

// Per overlapping-or-touching capsule-pair penalty. Large enough that any layout
// with a clear-of-touch alternative always wins on the objective; a single packed
// row is always such an alternative (its members share ONE capsule, so there is no
// pair to test), so coincident or convergent homes spread into one legible row
// instead of splitting into singleton capsules whose padded rects would touch.
const OVERLAP_PEN = 1e6;

// Minimum clear gap required between the padded rects of two DIFFERENT groups.
// Two capsules closer than this along both axes count as touching and are
// penalized so the solver prefers merging them into one row over a split whose
// capsules kiss at the corner.
const CAP_GAP_FRAC = 0.12;

/**
 * Count pairs of DIFFERENT groups whose padded capsule rects overlap or sit
 * within `capGap` of each other. Each group's rect is the rendered capsule rect
 * (bbox of its box centers expanded by box/2 + pad); two rects "touch" when they
 * intersect after each is grown by capGap/2, i.e. their AABBs are within capGap
 * on both axes. Deterministic O(g^2) scan over the small group count.
 */
function capsuleTouchPairs(rects: Array<{ x0: number; y0: number; x1: number; y1: number }>, capGap: number): number {
  const eps = 1e-6;
  let count = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const touch =
        a.x0 - capGap < b.x1 - eps &&
        b.x0 - capGap < a.x1 - eps &&
        a.y0 - capGap < b.y1 - eps &&
        b.y0 - capGap < a.y1 - eps;
      if (touch) count++;
    }
  }
  return count;
}

/** Median of a list of numbers. Even counts use the average of the two central
 *  values so a rigid packed row centers on the members' central home. */
function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// One aligned row: its member box centers, the total and max per-member slide.
interface Placed {
  centers: Map<string, Point>;
  total: number;
  max: number;
}

/**
 * Place a set of members as one packed row along a single axis.
 * `horiz` true packs left to right (a horizontal row); false packs top to bottom
 * (a vertical column). Members are ordered by their along-axis home (tie-break
 * lineId), placed edge-to-edge at `pitch`, centered on the median along-axis home
 * and at the median cross-axis home.
 */
function placeRow(part: RectMember[], horiz: boolean, pitch: number): Placed {
  const along = (m: RectMember) => (horiz ? m.home[0] : m.home[1]);
  const cross = (m: RectMember) => (horiz ? m.home[1] : m.home[0]);
  const ordered = [...part].sort(
    (a, b) => along(a) - along(b) || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0),
  );
  const medAlong = median(ordered.map(along));
  const medCross = median(ordered.map(cross));
  const n = ordered.length;
  const centers = new Map<string, Point>();
  let total = 0;
  let max = 0;
  ordered.forEach((m, i) => {
    const a = medAlong + (i - (n - 1) / 2) * pitch;
    const c: Point = horiz ? [a, medCross] : [medCross, a];
    centers.set(m.lineId, c);
    const slide = hyp(c[0] - m.home[0], c[1] - m.home[1]);
    total += slide;
    if (slide > max) max = slide;
  });
  return { centers, total, max };
}

/** The lower-total-slide of the two single-axis rows (tie: horizontal). */
function bestRow(part: RectMember[], pitch: number): Placed {
  const h = placeRow(part, true, pitch);
  const v = placeRow(part, false, pitch);
  return h.total <= v.total ? h : v;
}

/**
 * Enumerate every set partition of `[0..n)` as arrays of index groups.
 * Bell(6) = 203, so this stays tiny for the enumerated regime.
 */
function* setPartitions(n: number): Generator<number[][]> {
  function* rec(i: number, groups: number[][]): Generator<number[][]> {
    if (i === n) {
      yield groups.map((g) => [...g]);
      return;
    }
    for (let g = 0; g < groups.length; g++) {
      groups[g].push(i);
      yield* rec(i + 1, groups);
      groups[g].pop();
    }
    groups.push([i]);
    yield* rec(i + 1, groups);
    groups.pop();
  }
  yield* rec(0, []);
}

/**
 * Rendered capsule rect for a group: the bbox of its box centers expanded by
 * box/2 + pad on every side. This is exactly the rect drawn as the group's
 * rounded rectangle and used for connector attachment, so measuring capsule
 * overlap against this rect measures overlap against the drawn capsule.
 */
function padRect(centers: Iterable<Point>, box: number, pad: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of centers) {
    if (c[0] < x0) x0 = c[0];
    if (c[0] > x1) x1 = c[0];
    if (c[1] < y0) y0 = c[1];
    if (c[1] > y1) y1 = c[1];
  }
  const h = box / 2 + pad;
  return { x0: x0 - h, y0: y0 - h, x1: x1 + h, y1: y1 + h };
}

/**
 * Seat a large hub's members as a near-square stacked-row grid. The members are
 * ordered along their dominant home axis (the axis of larger home spread, tie ->
 * horizontal) and cut into contiguous rows of R = ceil(sqrt(n)) boxes each, so
 * there are ceil(n/R) rows. Row k packs its boxes edge-to-edge along the dominant
 * axis and is offset by k * pitch on the cross axis, and the whole grid is
 * centered on the members' mean home. This stacks the rows with a guaranteed full
 * pitch of separation on the cross axis (so no two boxes overlap regardless of how
 * the homes cluster) while keeping the footprint compact, rather than one
 * illegibly wide row.
 *
 * Returns one Placed row per grid row (matching the enumerated path's shape), so
 * the group rects and octilinear connectors are built by the shared downstream
 * code. Fully deterministic: the sort tie-breaks by lineId, the chunk size and
 * cross offsets are fixed, and slide uses sqrt-based distance.
 */
function gridRows(members: RectMember[], pitch: number): Placed[] {
  const n = members.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0;
  for (const m of members) {
    if (m.home[0] < minX) minX = m.home[0];
    if (m.home[0] > maxX) maxX = m.home[0];
    if (m.home[1] < minY) minY = m.home[1];
    if (m.home[1] > maxY) maxY = m.home[1];
    sumX += m.home[0];
    sumY += m.home[1];
  }
  const horiz = (maxX - minX) >= (maxY - minY); // dominant axis, tie -> horizontal
  const along = (m: RectMember) => (horiz ? m.home[0] : m.home[1]);
  const ordered = [...members].sort(
    (a, b) => along(a) - along(b) || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0),
  );
  const R = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / R);
  const meanAlong = horiz ? sumX / n : sumY / n;
  const meanCross = horiz ? sumY / n : sumX / n;
  // Cross-axis coordinate of row k, centered so the whole stack straddles the
  // members' mean cross-home.
  const crossOf = (k: number) => meanCross + (k - (rows - 1) / 2) * pitch;

  const out: Placed[] = [];
  for (let k = 0; k < rows; k++) {
    const part = ordered.slice(k * R, (k + 1) * R);
    const m = part.length;
    const cross = crossOf(k);
    const centers = new Map<string, Point>();
    let total = 0, max = 0;
    part.forEach((mem, i) => {
      const a = meanAlong + (i - (m - 1) / 2) * pitch;
      const c: Point = horiz ? [a, cross] : [cross, a];
      centers.set(mem.lineId, c);
      const slide = hyp(c[0] - mem.home[0], c[1] - mem.home[1]);
      total += slide;
      if (slide > max) max = slide;
    });
    out.push({ centers, total, max });
  }
  return out;
}

/**
 * Seat interchange members into upright-box rows joined by octilinear connectors.
 * `box` is the fixed box side length; `gap` is the edge-to-edge spacing within a
 * row (pitch = box + gap).
 */
export function rectSeat(members: RectMember[], box: number, gap: number): RectSeatOut {
  const pitch = box + gap;
  const pad = box * 0.16;
  const rx = (box + 2 * pad) * 0.16;
  // Minimum clear gap two split capsules must keep between their padded rects.
  const capGap = box * CAP_GAP_FRAC;

  // Trivial cases: 0 or 1 member is one row, no connector.
  if (members.length <= 1) {
    const centers = new Map<string, Point>();
    const groups: RectSeatOut['groups'] = [];
    if (members.length === 1) {
      const m = members[0];
      centers.set(m.lineId, [m.home[0], m.home[1]]);
      groups.push({
        x: m.home[0] - box / 2 - pad,
        y: m.home[1] - box / 2 - pad,
        w: box + 2 * pad,
        h: box + 2 * pad,
        rx,
      });
    }
    return { centers, groups, connectors: [] };
  }

  // Crossover penalty: half the largest per-member slide of forcing every member
  // into a single packed row (the worse of the two axes is the true "merge into
  // the main row" cost). Computed once from the full member set.
  const forcedH = placeRow(members, true, pitch);
  const forcedV = placeRow(members, false, pitch);
  const K = 0.5 * Math.max(forcedH.max, forcedV.max);

  // Choose the partition (and per-part axis, inside bestRow) that minimizes
  // total slide plus (parts - 1) * K. Deterministic tie-breaks: fewer parts,
  // then lower enumeration index (H<V is already baked into bestRow).
  let best: { parts: number[][]; rows: Placed[] } | null = null;
  let bestCost = Infinity;
  let bestParts = Infinity;
  let bestIdx = Infinity;

  const consider = (parts: number[][], idx: number) => {
    const rows = parts.map((g) => bestRow(g.map((i) => members[i]), pitch));
    const slide = rows.reduce((s, r) => s + r.total, 0);
    // One padded capsule rect per group (exactly the rendered rect); pairs of
    // DIFFERENT groups whose capsules overlap or sit within capGap are penalized
    // hard so a split whose capsules would touch never beats merging them into
    // one row. Boxes packed edge-to-edge within a row share ONE capsule, so there
    // is no intra-group pair to test, and group-rect separation implies the boxes
    // themselves are separated too.
    const capRects = rows.map((r) => padRect(r.centers.values(), box, pad));
    const cost = slide + (parts.length - 1) * K + OVERLAP_PEN * capsuleTouchPairs(capRects, capGap);
    const better =
      cost < bestCost - 1e-9 ||
      (Math.abs(cost - bestCost) <= 1e-9 &&
        (parts.length < bestParts ||
          (parts.length === bestParts && idx < bestIdx)));
    if (better) {
      best = { parts, rows };
      bestCost = cost;
      bestParts = parts.length;
      bestIdx = idx;
    }
  };

  if (members.length <= ENUM_MAX) {
    let idx = 0;
    for (const parts of setPartitions(members.length)) {
      consider(parts, idx);
      idx++;
    }
  } else {
    // Large hub: a single stacked-row grid. Enumerating partitions is infeasible
    // (Bell numbers explode), and one long row is illegibly wide, so the members
    // are ordered along their dominant home axis and cut into contiguous rows of
    // R = ceil(sqrt(n)) boxes, giving ceil(n/R) rows (a near square) stacked on the
    // cross axis. A twelve-line hub becomes about three rows of four numbered boxes
    // rather than one row of twelve. This is the sole candidate, so it is taken
    // directly (no cost comparison), and its rows flow through the same group-rect
    // and connector code below.
    const rows = gridRows(members, pitch);
    best = { parts: rows.map((_, i) => [i]), rows };
  }

  const chosen = best!;

  // Collect box centers and per-row group rounded-rects.
  const centers = new Map<string, Point>();
  const groups: RectSeatOut['groups'] = [];
  const rects: Rect[] = [];
  chosen.rows.forEach((row) => {
    for (const [id, c] of row.centers) centers.set(id, c);
    const bb = padRect(row.centers.values(), box, pad);
    const gx = bb.x0, gy = bb.y0;
    const gw = bb.x1 - bb.x0, gh = bb.y1 - bb.y0;
    groups.push({ x: gx, y: gy, w: gw, h: gh, rx });
    rects.push({ x: gx, y: gy, w: gw, h: gh });
  });

  // Connectors: a minimum spanning tree (Prim) over the group rects by centroid
  // distance; each tree edge is an octilinear polyline between the two rects.
  const connectors = mstConnectors(rects);

  return { centers, groups, connectors };
}

/**
 * Minimum spanning tree over rects by centroid Euclidean distance (Prim), then
 * one octilinear connector per tree edge. Deterministic: ties in edge weight
 * break by the lower candidate index.
 */
function mstConnectors(rects: Rect[]): Array<{ points: Point[] }> {
  const n = rects.length;
  if (n <= 1) return [];
  const cx = rects.map((r) => r.x + r.w / 2);
  const cy = rects.map((r) => r.y + r.h / 2);
  const inTree = new Array<boolean>(n).fill(false);
  inTree[0] = true;
  const connectors: Array<{ points: Point[] }> = [];
  for (let added = 1; added < n; added++) {
    let bestW = Infinity;
    let bestI = -1;
    let bestJ = -1;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const w = hyp(cx[i] - cx[j], cy[i] - cy[j]);
        // Fixed tie-break by (i, j) index keeps the tree deterministic.
        if (w < bestW - 1e-9) {
          bestW = w;
          bestI = i;
          bestJ = j;
        }
      }
    }
    inTree[bestJ] = true;
    connectors.push(octiConnect(rects[bestI], rects[bestJ]));
  }
  return connectors;
}
