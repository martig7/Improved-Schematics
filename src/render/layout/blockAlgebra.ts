// Recursive block algebra for bundle-blocks line ordering (spec
// 2026-07-04-bundle-blocks-rebuild §2). A corridor's lateral order is a
// BLOCK: an ordered list whose items are line ids or nested blocks. The only
// operations are join (nest two blocks, binary side), mirror (flip
// end-over-end at every level), and split helpers (contiguity + minimal
// adjacent transpositions). In-bundle reorders on open track are
// UNREPRESENTABLE by design. Pure data structures — no Layout imports, no
// floating point, fully deterministic.

export type Block = Array<string | Block>;

/** Depth-first leaf order — the drawn lateral order. */
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
 *  INTACT — their internal order is the joined bundle's memory. */
export function joinBlocks(a: Block, b: Block, bFirst: boolean): Block {
  return bFirst ? [b, a] : [a, b];
}

/** All leaf line ids of a block. */
export function blockLines(b: Block): Set<string> {
  return new Set(flattenBlock(b));
}
