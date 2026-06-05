// Octilinear Hanan grid construction.
//
// Inspired by Bast/Brosi/Storandt's "Metro Maps on Flexible Base Grids" (SSTD '21,
// section 4.3). Build a sparse grid whose lines pass only through the projected
// station positions: four line families (horizontal, vertical, both 45° diagonals),
// intersected pairwise. Each grid node has up to 8 octilinear neighbours.
//
// Stations are first snapped to a regular base grid of cell size `snapCell` so
// nearby stations collapse to the same grid node and the grid size stays modest.
// Visual displacement is at most snapCell/√2.

import type { Pixel } from './types';

export interface HananOptions {
  /** Base-grid cell size in pixels. Stations within √2·snapCell collapse. */
  snapCell: number;
  /** Bounding-box padding for the grid (in pixels). */
  padding: number;
}

export interface HananNeighbour {
  /** Neighbour grid-node key. */
  to: string;
  /**
   * Direction index 0..7, math convention with +y as up:
   *   0=E(+x,0), 1=NE(+x,+y), 2=N(0,+y), 3=NW(-x,+y),
   *   4=W(-x,0), 5=SW(-x,-y), 6=S(0,-y), 7=SE(+x,-y).
   * The SVG renderer's y is flipped, but the convention here is consistent.
   */
  dir: number;
  /** Euclidean length of this grid edge. */
  len: number;
}

export interface HananGrid {
  /** key "x,y" → pixel position. */
  positions: Map<string, Pixel>;
  /** Per-node adjacency list (up to 8 neighbours). */
  adj: Map<string, HananNeighbour[]>;
  /** Per-input-station key → its grid-node key. */
  stationNodeKeys: Map<string, string>;
}

const key = (x: number, y: number) => x + ',' + y;

function snap1D(v: number, cell: number): number {
  return Math.round(v / cell) * cell;
}

function snap(p: Pixel, cell: number): Pixel {
  return [snap1D(p[0], cell), snap1D(p[1], cell)];
}

export function buildHananGrid(
  stationPositions: Map<string, Pixel>,
  opts: HananOptions,
): HananGrid {
  const { snapCell, padding } = opts;

  // 1. Snap each station to base grid.
  const snapped = new Map<string, Pixel>();
  for (const [id, p] of stationPositions) snapped.set(id, snap(p, snapCell));

  // 2. Collect the four line families' unique values + bounding box.
  const xs = new Set<number>();
  const ys = new Set<number>();
  const sums = new Set<number>(); // x + y = const (slope -1 diagonal)
  const diffs = new Set<number>(); // x - y = const (slope +1 diagonal)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of snapped.values()) {
    xs.add(p[0]);
    ys.add(p[1]);
    sums.add(p[0] + p[1]);
    diffs.add(p[0] - p[1]);
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const bMinX = minX - padding;
  const bMaxX = maxX + padding;
  const bMinY = minY - padding;
  const bMaxY = maxY + padding;

  const xArr = [...xs];
  const yArr = [...ys];
  const sumArr = [...sums];
  const diffArr = [...diffs];

  // 3. Pairwise line intersections within bbox become grid nodes.
  const positions = new Map<string, Pixel>();
  const tryInsert = (x: number, y: number) => {
    if (x < bMinX || x > bMaxX || y < bMinY || y > bMaxY) return;
    // Round to nearest 0.5 to absorb floating-point chatter from diag intersections.
    const rx = Math.round(x * 2) / 2;
    const ry = Math.round(y * 2) / 2;
    const k = key(rx, ry);
    if (!positions.has(k)) positions.set(k, [rx, ry]);
  };
  // H × V
  for (const x of xArr) for (const y of yArr) tryInsert(x, y);
  // H × diag(slope -1): y fixed, x = s - y
  for (const y of yArr) for (const s of sumArr) tryInsert(s - y, y);
  // H × diag(slope +1): y fixed, x = t + y
  for (const y of yArr) for (const t of diffArr) tryInsert(t + y, y);
  // V × diag(slope -1): x fixed, y = s - x
  for (const x of xArr) for (const s of sumArr) tryInsert(x, s - x);
  // V × diag(slope +1): x fixed, y = x - t
  for (const x of xArr) for (const t of diffArr) tryInsert(x, x - t);
  // diag × diag: x = (s + t) / 2, y = (s - t) / 2
  for (const s of sumArr) for (const t of diffArr) tryInsert((s + t) / 2, (s - t) / 2);

  // 4. Build per-line sorted-position indices for fast neighbour lookup.
  //    For each line value, store a sorted array of (along-axis position, node key)
  //    and a map (node key → index in that sorted array).
  const linePositions = (entries: Array<[number, string]>) => {
    const sorted = entries.slice().sort((a, b) => a[0] - b[0]);
    const indexMap = new Map<string, number>();
    sorted.forEach(([, k], i) => indexMap.set(k, i));
    return { sorted, indexMap };
  };

  const onX = new Map<number, Array<[number, string]>>(); // x → [(y, key)]
  const onY = new Map<number, Array<[number, string]>>(); // y → [(x, key)]
  const onSum = new Map<number, Array<[number, string]>>(); // s = x+y → [(x, key)]
  const onDiff = new Map<number, Array<[number, string]>>(); // t = x-y → [(x, key)]
  for (const [k, [x, y]] of positions) {
    if (!onX.has(x)) onX.set(x, []);
    if (!onY.has(y)) onY.set(y, []);
    const s = x + y;
    const t = x - y;
    if (!onSum.has(s)) onSum.set(s, []);
    if (!onDiff.has(t)) onDiff.set(t, []);
    onX.get(x)!.push([y, k]);
    onY.get(y)!.push([x, k]);
    onSum.get(s)!.push([x, k]);
    onDiff.get(t)!.push([x, k]);
  }
  const xLines = new Map<number, ReturnType<typeof linePositions>>();
  const yLines = new Map<number, ReturnType<typeof linePositions>>();
  const sumLines = new Map<number, ReturnType<typeof linePositions>>();
  const diffLines = new Map<number, ReturnType<typeof linePositions>>();
  for (const [v, arr] of onX) xLines.set(v, linePositions(arr));
  for (const [v, arr] of onY) yLines.set(v, linePositions(arr));
  for (const [v, arr] of onSum) sumLines.set(v, linePositions(arr));
  for (const [v, arr] of onDiff) diffLines.set(v, linePositions(arr));

  // 5. For each grid node, gather its 8 octilinear neighbours.
  const adj = new Map<string, HananNeighbour[]>();
  for (const [k, [x, y]] of positions) {
    const here: HananNeighbour[] = [];
    const add = (nx: number, ny: number, dir: number) => {
      const nk = key(nx, ny);
      if (!positions.has(nk)) return;
      here.push({ to: nk, dir, len: Math.hypot(nx - x, ny - y) });
    };
    // Vertical line at x: prev (smaller y) is dir 6 (S); next (larger y) is dir 2 (N)
    const xLine = xLines.get(x);
    if (xLine) {
      const idx = xLine.indexMap.get(k)!;
      if (idx > 0) {
        const [py] = xLine.sorted[idx - 1];
        add(x, py, 6);
      }
      if (idx + 1 < xLine.sorted.length) {
        const [ny] = xLine.sorted[idx + 1];
        add(x, ny, 2);
      }
    }
    // Horizontal line at y: prev x → W (dir 4), next x → E (dir 0)
    const yLine = yLines.get(y);
    if (yLine) {
      const idx = yLine.indexMap.get(k)!;
      if (idx > 0) {
        const [px] = yLine.sorted[idx - 1];
        add(px, y, 4);
      }
      if (idx + 1 < yLine.sorted.length) {
        const [nx] = yLine.sorted[idx + 1];
        add(nx, y, 0);
      }
    }
    // Diagonal slope -1 (x + y = s): prev (smaller x → larger y) → dir 3 (NW);
    //                                next (larger x → smaller y) → dir 7 (SE)
    const sLine = sumLines.get(x + y);
    if (sLine) {
      const idx = sLine.indexMap.get(k)!;
      if (idx > 0) {
        const [px] = sLine.sorted[idx - 1];
        add(px, x + y - px, 3);
      }
      if (idx + 1 < sLine.sorted.length) {
        const [nx] = sLine.sorted[idx + 1];
        add(nx, x + y - nx, 7);
      }
    }
    // Diagonal slope +1 (x - y = t): prev (smaller x → smaller y) → dir 5 (SW);
    //                                next (larger x → larger y) → dir 1 (NE)
    const tLine = diffLines.get(x - y);
    if (tLine) {
      const idx = tLine.indexMap.get(k)!;
      if (idx > 0) {
        const [px] = tLine.sorted[idx - 1];
        add(px, px - (x - y), 5);
      }
      if (idx + 1 < tLine.sorted.length) {
        const [nx] = tLine.sorted[idx + 1];
        add(nx, nx - (x - y), 1);
      }
    }
    adj.set(k, here);
  }

  // 6. Map each original station to its grid-node key.
  const stationNodeKeys = new Map<string, string>();
  for (const [id, p] of snapped) {
    const rx = Math.round(p[0] * 2) / 2;
    const ry = Math.round(p[1] * 2) / 2;
    stationNodeKeys.set(id, key(rx, ry));
  }

  return { positions, adj, stationNodeKeys };
}
