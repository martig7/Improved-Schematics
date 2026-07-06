// Taxicab transfer connectors between the platform-split units of one
// station group (spec escalation-ladder-rewrite §2.4). When a far-apart
// group cannot be one capsule and far-attach fails, it is platform split;
// thin axis-aligned connectors join its capsules so the complex still reads
// as one station. Pure geometry: MST over unit centroids, nearest-dot
// endpoints, single-elbow L paths whose corner grazes foreign markers least.
// Deterministic (sorted inputs, total tie-breaks, sqrt-only arithmetic), so
// offline==in-game holds.

import type { Pixel } from './types';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface SplitUnit {
  id: string;      // placement-unit nodeId (used only for deterministic order)
  dots: Pixel[];   // the unit's FINAL mark positions (post all slide passes)
}

export interface SplitConnector {
  a: Pixel;              // endpoint on the first unit (a dot center)
  b: Pixel;              // endpoint on the second unit
  corner: Pixel | null;  // elbow vertex, or null when a/b are axis-aligned
}

/** Plan the connectors for ONE group's split units. `foreign` = final mark
 *  positions of every OTHER station near the group (elbow-avoidance). */
export function planSplitConnectors(
  units: SplitUnit[],
  foreign: Pixel[],
): SplitConnector[] {
  const us = units
    .filter((u) => u.dots.length > 0)
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (us.length < 2) return [];
  const cents: Pixel[] = us.map((u) => {
    let x = 0, y = 0;
    for (const d of u.dots) { x += d[0]; y += d[1]; }
    return [x / u.dots.length, y / u.dots.length];
  });
  // Prim's MST over centroids (unit counts are tiny); tie-break smallest j
  const inTree = new Set<number>([0]);
  const edges: Array<[number, number]> = [];
  while (inTree.size < us.length) {
    let bi = -1, bj = -1, bd = Infinity;
    for (const i of inTree) {
      for (let j = 0; j < us.length; j++) {
        if (inTree.has(j)) continue;
        const d = hyp(cents[i][0] - cents[j][0], cents[i][1] - cents[j][1]);
        if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && (bj === -1 || j < bj || (j === bj && i < bi)))) {
          bd = d; bi = i; bj = j;
        }
      }
    }
    inTree.add(bj);
    edges.push([bi, bj]);
  }
  const out: SplitConnector[] = [];
  for (const [i, j] of edges) {
    // nearest dot pair between the two units (total tie-break by index order)
    let a = us[i].dots[0], b = us[j].dots[0], best = Infinity;
    for (const pa of us[i].dots) {
      for (const pb of us[j].dots) {
        const d = hyp(pa[0] - pb[0], pa[1] - pb[1]);
        if (d < best - 1e-9) { best = d; a = pa; b = pb; }
      }
    }
    if (Math.abs(a[0] - b[0]) < 0.5 || Math.abs(a[1] - b[1]) < 0.5) {
      out.push({ a, b, corner: null }); // already axis-aligned (within jitter)
      continue;
    }
    // two taxicab elbows; pick the corner farther from every foreign marker
    const c1: Pixel = [b[0], a[1]];
    const c2: Pixel = [a[0], b[1]];
    const clearOf = (c: Pixel): number => {
      let md = Infinity;
      for (const f of foreign) {
        const d = hyp(c[0] - f[0], c[1] - f[1]);
        if (d < md) md = d;
      }
      return md;
    };
    const d1 = clearOf(c1);
    const d2 = clearOf(c2);
    const corner =
      d1 > d2 + 1e-9 ? c1 :
      d2 > d1 + 1e-9 ? c2 :
      c1[0] < c2[0] || (c1[0] === c2[0] && c1[1] <= c2[1]) ? c1 : c2; // total tie-break
    out.push({ a, b, corner });
  }
  return out;
}
