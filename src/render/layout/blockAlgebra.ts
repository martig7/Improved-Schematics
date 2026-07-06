// Recursive block algebra for bundle-blocks line ordering (spec
// 2026-07-04-bundle-blocks-rebuild §2). A corridor's lateral order is a
// BLOCK: an ordered list whose items are line ids or nested blocks. The only
// operations are join (nest two blocks, binary side), mirror (flip
// end-over-end at every level), and split helpers (contiguity + minimal
// adjacent transpositions). In-bundle reorders on open track are
// UNREPRESENTABLE by design. Pure data structures with no Layout imports, no
// floating point, fully deterministic.

export type Block = Array<string | Block>;

/** Depth-first leaf order, i.e. the drawn lateral order. */
export function flattenBlock(b: Block): string[] {
  const out: string[] = [];
  const walk = (x: string | Block): void => {
    if (typeof x === 'string') out.push(x);
    else for (const item of x) walk(item);
  };
  walk(b);
  return out;
}

/** Flip end-over-end at every nesting level (orientation change). */
export function mirrorBlock(b: Block): Block {
  const out: Block = [];
  for (let i = b.length - 1; i >= 0; i--) {
    const item = b[i];
    out.push(typeof item === 'string' ? item : mirrorBlock(item));
  }
  return out;
}

/** Merge two corridors' blocks; `bFirst` picks the side. Operands nest
 *  INTACT so their internal order is the joined bundle's memory. */
export function joinBlocks(a: Block, b: Block, bFirst: boolean): Block {
  return bFirst ? [b, a] : [a, b];
}

/** All leaf line ids of a block. */
export function blockLines(b: Block): Set<string> {
  return new Set(flattenBlock(b));
}

export interface SplitPlanResult {
  /** the exit-contiguous order (stable within groups) */
  order: string[];
  /** adjacent-transposition (bubble) distance from the input order. Counts
   *  the crossings this split forces, drawn AT the split node */
  swaps: number;
}

/** Kendall-tau distance between `from` and `to` (same multiset): the number
 *  of pairwise inversions = minimal adjacent transpositions. O(n²), n ≤
 *  bundle width (≤ ~16 in practice). */
function bubbleDistance(from: string[], to: string[]): number {
  const rank = new Map<string, number>();
  for (let i = 0; i < to.length; i++) rank.set(to[i], i);
  let inv = 0;
  for (let i = 0; i < from.length; i++) {
    for (let j = i + 1; j < from.length; j++) {
      if (rank.get(from[i])! > rank.get(from[j])!) inv++;
    }
  }
  return inv;
}

/** Reorder `order` so lines sharing a group are contiguous, groups appearing
 *  in `groupRank` order, STABLE within each group. Returns the new order and
 *  the forced-crossing count. */
export function reorderToGroups(
  order: string[],
  groupOf: Map<string, number>,
  groupRank: number[],
): SplitPlanResult {
  const rankOf = new Map<number, number>();
  for (let i = 0; i < groupRank.length; i++) rankOf.set(groupRank[i], i);
  const idx = new Map<string, number>();
  for (let i = 0; i < order.length; i++) idx.set(order[i], i);
  const target = [...order].sort((a, b) => {
    const ga = rankOf.get(groupOf.get(a)!)!;
    const gb = rankOf.get(groupOf.get(b)!)!;
    if (ga !== gb) return ga - gb;
    return idx.get(a)! - idx.get(b)!; // stable within group
  });
  return { order: target, swaps: bubbleDistance(order, target) };
}

/** Split planning: make each exit-group contiguous with minimal crossings.
 *  Group order = first appearance in the current order (the least-motion
 *  choice: groups keep their current center of mass ordering). Callers with
 *  geometric exit ranks use reorderToGroups directly. */
export function splitPlan(
  order: string[],
  groupOf: Map<string, number>,
): SplitPlanResult {
  const seen: number[] = [];
  for (const l of order) {
    const g = groupOf.get(l)!;
    if (!seen.includes(g)) seen.push(g);
  }
  return reorderToGroups(order, groupOf, seen);
}
