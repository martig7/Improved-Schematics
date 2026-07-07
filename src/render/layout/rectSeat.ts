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
// member's home to its placed box center) plus a per-extra-row penalty. A
// separate row plus connector is preferred exactly when forcing its members into
// one shared row would cost more slide than the penalty. The penalty
//   K = 0.5 * maxSlideForcedRow
// where maxSlideForcedRow is the largest single-member slide incurred by forcing
// ALL members into one packed row (the worse of the two single-axis layouts).
// This is the "half of the max slide of merging into the main row" crossover.
//
// Search: for small member counts the set partitions are enumerable (Bell
// numbers stay tiny), and per part the axis is chosen from {H, V}; box order and
// row placement within a part are closed-form (sort by along-axis home, center on
// the median home), so no continuous search is needed. Large hubs fall back to a
// single best-axis row (the opaque mega box handles the truly huge ones upstream).
//
// Fully deterministic: no Math.random / Date; every tie-break resolves by a fixed
// index or lineId order, so offline output equals in-game output.

import type { Point } from '../stations/types';
import { octiConnect, type Rect } from './octiConnect';

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

// Above this member count the enumeration is skipped and a single best-axis row
// is used; real interchanges below this, larger hubs fall back to the mega box.
const ENUM_MAX = 6;

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
    const slide = Math.hypot(c[0] - m.home[0], c[1] - m.home[1]);
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

/** Axis-aligned bounding rect of a set of box centers (box side = `box`). */
function rowRect(centers: Iterable<Point>, box: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of centers) {
    if (c[0] < x0) x0 = c[0];
    if (c[0] > x1) x1 = c[0];
    if (c[1] < y0) y0 = c[1];
    if (c[1] > y1) y1 = c[1];
  }
  const h = box / 2;
  return { x0: x0 - h, y0: y0 - h, x1: x1 + h, y1: y1 + h };
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
    const cost = slide + (parts.length - 1) * K;
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
    // Large hub: one best-axis row (the mega box handles the huge cases upstream).
    consider([members.map((_, i) => i)], 0);
  }

  const chosen = best!;

  // Collect box centers and per-row group rounded-rects.
  const centers = new Map<string, Point>();
  const groups: RectSeatOut['groups'] = [];
  const rects: Rect[] = [];
  chosen.rows.forEach((row) => {
    for (const [id, c] of row.centers) centers.set(id, c);
    const bb = rowRect(row.centers.values(), box);
    const gx = bb.x0 - pad, gy = bb.y0 - pad;
    const gw = bb.x1 - bb.x0 + 2 * pad, gh = bb.y1 - bb.y0 + 2 * pad;
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
        const w = Math.hypot(cx[i] - cx[j], cy[i] - cy[j]);
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
