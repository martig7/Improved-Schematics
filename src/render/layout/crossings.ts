import type { Layout } from './types';

export interface CrossingReport {
  /** Crossings on open track (Σ endpoint-order inversions over edges). */
  onEdges: number;
  /** Residual crossings forced at nodes (one per non-planar node, lower bound). */
  atNodes: number;
  /** Number of non-planar nodes. */
  nonPlanar: number;
}

/** Inversions between two equal-set permutations (number of adjacent swaps). */
export function inversions(from: string[], to: string[]): number {
  const rank = new Map<string, number>();
  to.forEach((l, i) => rank.set(l, i));
  const a = from.filter((l) => rank.has(l)).map((l) => rank.get(l)!);
  let inv = 0;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) inv++;
  return inv;
}

/** Total edge-internal crossings across the layout (Σ endpoint-order inversions). */
export function totalEdgeCrossings(layout: Layout): number {
  let n = 0;
  for (const e of layout.edges) n += inversions(e.orderFrom ?? e.lineOrder, e.orderTo ?? e.lineOrder);
  return n;
}

/** Count line crossings by location: on edges (bends) vs forced at nodes. */
export function countCrossings(layout: Layout): CrossingReport {
  const onEdges = totalEdgeCrossings(layout);
  const nonPlanar = layout.nonPlanarNodes?.size ?? 0;
  return { onEdges, atNodes: nonPlanar, nonPlanar };
}
