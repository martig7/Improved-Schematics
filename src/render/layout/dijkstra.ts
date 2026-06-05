// Tiny binary-heap priority queue + generic Dijkstra / A* shortest path.
// Used by the Hanan-grid router for smoothed mode.

/** Min-heap of (priority, value); lower priority pops first. */
class MinHeap<T> {
  private a: { p: number; v: T }[] = [];

  push(p: number, v: T): void {
    this.a.push({ p, v });
    let i = this.a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.a[parent].p <= this.a[i].p) break;
      [this.a[parent], this.a[i]] = [this.a[i], this.a[parent]];
      i = parent;
    }
  }

  pop(): { p: number; v: T } | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < n && this.a[l].p < this.a[best].p) best = l;
        if (r < n && this.a[r].p < this.a[best].p) best = r;
        if (best === i) break;
        [this.a[best], this.a[i]] = [this.a[i], this.a[best]];
        i = best;
      }
    }
    return top;
  }

  get size(): number {
    return this.a.length;
  }
}

export interface DijkstraEdge<NodeId> {
  to: NodeId;
  w: number;
}

export interface DijkstraResult<NodeId> {
  path: NodeId[];
  cost: number;
}

/**
 * Generic Dijkstra / A*.
 *
 * - `neighbors(n, prev)` returns outgoing edges from `n`; the previous node is
 *   supplied so the cost function can include bend penalties.
 * - `heuristic(n)` is an admissible distance estimate to the goal. Pass
 *   `() => 0` for plain Dijkstra; pass an octilinear distance for A*.
 * - `expansionBudget` caps the search (returns null if exceeded).
 */
export function dijkstra<NodeId>(
  start: NodeId,
  goal: NodeId,
  neighbors: (n: NodeId, prev: NodeId | null) => Iterable<DijkstraEdge<NodeId>>,
  heuristic: (n: NodeId) => number,
  expansionBudget = 200_000,
): DijkstraResult<NodeId> | null {
  const keyFn = (n: NodeId) => String(n);
  if (keyFn(start) === keyFn(goal)) return { path: [start], cost: 0 };

  const best = new Map<string, number>();
  const parent = new Map<string, NodeId | null>();
  const open = new MinHeap<NodeId>();

  best.set(keyFn(start), 0);
  parent.set(keyFn(start), null);
  open.push(heuristic(start), start);

  let expanded = 0;
  while (open.size > 0) {
    const top = open.pop()!;
    const cur = top.v;
    const curKey = keyFn(cur);
    const curBest = best.get(curKey) ?? Infinity;
    // Stale heap entry (we've already found a cheaper path to this node).
    if (top.p - heuristic(cur) > curBest + 1e-9) continue;

    if (curKey === keyFn(goal)) {
      const path: NodeId[] = [];
      let n: NodeId | null = cur;
      while (n !== null) {
        path.push(n);
        const p = parent.get(keyFn(n));
        n = p === undefined ? null : p;
      }
      path.reverse();
      return { path, cost: curBest };
    }

    if (++expanded > expansionBudget) return null;

    const prev = parent.get(curKey) ?? null;
    for (const edge of neighbors(cur, prev)) {
      const g = curBest + edge.w;
      const k = keyFn(edge.to);
      if (g < (best.get(k) ?? Infinity)) {
        best.set(k, g);
        parent.set(k, cur);
        open.push(g + heuristic(edge.to), edge.to);
      }
    }
  }
  return null;
}
