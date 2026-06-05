// Grid primitives + A* edge routing, ported from the game
// (dev/reference/octilinearDistance.js, routeEdge.js, preferredDirIdx.js).

import type { Cell } from './types';
import { OCT_DIRS } from '../constants';

const DIRS = OCT_DIRS;

export const cellKey = (c: Cell): string => c[0] + ',' + c[1];
export const cellKeyOf = cellKey;

export const edgeKey = (a: Cell, b: Cell): string => {
  const ka = cellKey(a);
  const kb = cellKey(b);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
};

/** Octilinear (Chebyshev-with-SQRT2) distance between two cells. */
export function octilinearDistance(a: Cell, b: Cell): number {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  const diag = Math.min(dx, dy);
  const straight = Math.abs(dx - dy);
  return diag * Math.SQRT2 + straight;
}

/** Index in DIRS of the unit step toward `goal`, or -1 if none. */
function preferredDirIdx(from: Cell, goal: Cell): number {
  const sx = Math.sign(goal[0] - from[0]);
  const sy = Math.sign(goal[1] - from[1]);
  return DIRS.findIndex((d) => d[0] === sx && d[1] === sy);
}

interface AStarNode {
  cell: Cell;
  dirIdx: number;
  g: number;
  f: number;
  parent: AStarNode | null;
}

/**
 * A* grid route between two cells over the 8 octilinear directions.
 * Costs prefer straight runs, penalize turns, avoid other stations' cells, and
 * bundle co-running lines onto shared segments.
 *
 * @param from       start cell
 * @param to         goal cell
 * @param lineIds    line ids traversing this edge (for bundling preference)
 * @param occupied   cell keys used by other nodes (soft-avoided)
 * @param sharedSegs edgeKey -> set of lineIds already routed on that segment
 */
export function routeEdge(
  from: Cell,
  to: Cell,
  lineIds: Set<string>,
  occupied: Set<string>,
  sharedSegs: Map<string, Set<string>>,
): Cell[] {
  const startKey = cellKey(from);
  const goalKey = cellKey(to);
  const open: AStarNode[] = [];
  const best = new Map<string, number>();
  open.push({ cell: from, dirIdx: -1, g: 0, f: octilinearDistance(from, to), parent: null });
  best.set(startKey + '|-1', 0);

  while (open.length > 0) {
    // pop lowest-f node
    let lo = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[lo].f) lo = i;
    const cur = open.splice(lo, 1)[0];

    if (cellKey(cur.cell) === goalKey) {
      const path: Cell[] = [];
      let n: AStarNode | null = cur;
      while (n) {
        path.push(n.cell);
        n = n.parent;
      }
      path.reverse();
      return path;
    }

    for (let d = 0; d < 8; d++) {
      const dir = DIRS[d];
      const next: Cell = [cur.cell[0] + dir[0], cur.cell[1] + dir[1]];
      const nextKey = cellKey(next);
      let cost = d % 2 === 0 ? 1 : Math.SQRT2;

      // avoid passing through another station's cell (unless it is the goal)
      if (occupied.has(nextKey) && nextKey !== goalKey) cost += 1.5;

      // penalize turning away from the current heading
      if (cur.dirIdx >= 0) {
        const turn = Math.min(Math.abs(d - cur.dirIdx), 8 - Math.abs(d - cur.dirIdx));
        cost += turn * 2.5;
      }

      // bundle with co-running lines; avoid merging with different lines
      const segKey = edgeKey(cur.cell, next);
      const seg = sharedSegs.get(segKey);
      if (seg && seg.size > 0) {
        let same = 0;
        let diff = 0;
        for (const id of seg) {
          if (lineIds.has(id)) same++;
          else diff++;
        }
        cost -= same * 2;
        cost += diff * 1.5;
      }
      if (cost < 0.1) cost = 0.1;

      const g = cur.g + cost;
      const stateKey = nextKey + '|' + d;
      if (g >= (best.get(stateKey) ?? Infinity)) continue;
      best.set(stateKey, g);
      open.push({ cell: next, dirIdx: d, g, f: g + octilinearDistance(next, to), parent: cur });
    }

    if (best.size > 5e4) break;
  }

  // Fallback: greedy straight-ish walk toward the goal.
  const path: Cell[] = [from];
  let cur = from;
  let guard = 0;
  while (cellKey(cur) !== goalKey && guard++ < 1e3) {
    const d = preferredDirIdx(cur, to);
    if (d < 0) break;
    const dir = DIRS[d];
    cur = [cur[0] + dir[0], cur[1] + dir[1]];
    path.push(cur);
  }
  return path;
}
