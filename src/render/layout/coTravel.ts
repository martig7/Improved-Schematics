// Co-travel grouping for the bundle-blocks seed order. Two lines co-travel to
// the extent they traverse the same corridors; keeping strong co-travelers
// contiguous at the seed stops a foreign line from wedging into a bundle that
// forks and reconverges downstream. Pure and deterministic: integer set
// intersections, union-find, total tie-breaks. No floating point.

import type { Layout } from './types';
import type { CorridorSet } from './bundleOrder';

/** Per line, the set of corridor ids its traversal rides. Built once. */
export function buildLineCorridorSets(
  layout: Layout,
  cs: CorridorSet,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [lineId, steps] of layout.lineTraversals) {
    const s = new Set<number>();
    for (const step of steps) {
      const c = cs.byEdge.get(step.edgeId);
      if (c) s.add(c.id);
    }
    out.set(lineId, s);
  }
  return out;
}

/** |corridors(a) ∩ corridors(b)|, the co-travel strength. */
export function sharedCorridorCount(
  sets: Map<string, Set<number>>,
): (a: string, b: string) => number {
  return (a: string, b: string): number => {
    const sa = sets.get(a);
    const sb = sets.get(b);
    if (!sa || !sb) return 0;
    const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    let n = 0;
    for (const c of small) if (large.has(c)) n++;
    return n;
  };
}

/** Partition `lines` into co-travel components: connected components of the
 *  graph whose edges are line pairs with strength >= threshold. Union by a
 *  total order (tie) so ids are a pure function of inputs, independent of the
 *  `lines` argument order. Returns line id -> small integer component id, ids
 *  assigned by first appearance in tie order. */
export function coTravelComponents(
  lines: string[],
  strength: (a: string, b: string) => number,
  tie: (l: string) => number,
  threshold: number,
): Map<string, number> {
  const ls = [...lines].sort((a, b) => tie(a) - tie(b) || (a < b ? -1 : a > b ? 1 : 0));
  const parent = new Map<string, string>();
  for (const l of ls) parent.set(l, l);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const p = parent.get(x)!; parent.set(x, r); x = p; }
    return r;
  };
  const before = (a: string, b: string): boolean => tie(a) < tie(b) || (tie(a) === tie(b) && a < b);
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // attach the tie-larger root under the tie-smaller, for a stable forest
    const [lo, hi] = before(ra, rb) ? [ra, rb] : [rb, ra];
    parent.set(hi, lo);
  };
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 1; j < ls.length; j++) {
      if (strength(ls[i], ls[j]) >= threshold) union(ls[i], ls[j]);
    }
  }
  const idOf = new Map<string, number>();
  const out = new Map<string, number>();
  for (const l of ls) {
    const r = find(l);
    let id = idOf.get(r);
    if (id === undefined) { id = idOf.size; idOf.set(r, id); }
    out.set(l, id);
  }
  return out;
}
