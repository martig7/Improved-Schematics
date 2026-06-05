// Trace closed coastline rings from a boolean water mask using directed boundary
// edges (water-on-left), stitched end-to-end. Orientation is irrelevant — the
// renderers fill with fill-rule="evenodd", so nested rings auto-hole.

import type { WaterGrid } from './grid';

export type Corner = [number, number]; // grid-corner coords (cx, cy)
export type Ring = Corner[]; // closed: first === last

const key = (x: number, y: number) => x + ',' + y;

export function traceRings(grid: WaterGrid): Ring[] {
  const { mask, W, H } = grid;
  const water = (c: number, r: number) =>
    c >= 0 && c < W && r >= 0 && r < H && mask[r * W + c] === 1;

  // Directed edges with water on the left. A corner may start more than one edge
  // (at pinch points), so map each start key to a list of end corners.
  const edges = new Map<string, Corner[]>();
  const starts: Corner[] = [];
  const add = (sx: number, sy: number, ex: number, ey: number) => {
    const k = key(sx, sy);
    let list = edges.get(k);
    if (!list) {
      list = [];
      edges.set(k, list);
    }
    list.push([ex, ey]);
    starts.push([sx, sy]);
  };

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!water(c, r)) continue;
      if (!water(c, r - 1)) add(c, r, c + 1, r); // bottom
      if (!water(c + 1, r)) add(c + 1, r, c + 1, r + 1); // right
      if (!water(c, r + 1)) add(c + 1, r + 1, c, r + 1); // top
      if (!water(c - 1, r)) add(c, r + 1, c, r); // left
    }
  }

  const used = new Set<string>();
  const edgeKey = (a: Corner, b: Corner) => key(a[0], a[1]) + '>' + key(b[0], b[1]);
  const rings: Ring[] = [];

  for (const s of starts) {
    const firstList = edges.get(key(s[0], s[1]));
    if (!firstList) continue;
    // pick an unused outgoing edge from s
    const firstEnd = firstList.find((e) => !used.has(edgeKey(s, e)));
    if (!firstEnd) continue;

    const ring: Ring = [s];
    let cur = s;
    let next: Corner | undefined = firstEnd;
    while (next) {
      used.add(edgeKey(cur, next));
      ring.push(next);
      if (next[0] === s[0] && next[1] === s[1]) break; // closed
      const list = edges.get(key(next[0], next[1]));
      cur = next;
      next = list?.find((e) => !used.has(edgeKey(cur, e)));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
