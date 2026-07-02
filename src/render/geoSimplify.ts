// Simplified-landmass stylizer: turns projected water/park rings into the
// rounded, low-detail blobs real metro diagrams use (MTA / TfL / Sound Transit
// style). Three tunable primitives, applied per ring at DRAW time (pixel space,
// after projection+warp — never touches the layout):
//
//   1. CULL    — rings whose |area| is below `minAreaPx2` vanish outright
//                (ponds, islets, sliver parks — diagram maps don't show them).
//   2. SIMPLIFY— Visvalingam–Whyatt: repeatedly drop the vertex whose "effective
//                triangle" (with its two neighbours) has the smallest area,
//                until every remaining vertex matters by at least
//                `simplifyPx²`. VW eats coastline wiggles while keeping the
//                blob's silhouette — much blobbier than Douglas-Peucker at the
//                same vertex count. A cheap radial pre-filter bounds the O(n²)
//                min-scan on tile-resolution rings.
//   3. ROUND   — every remaining corner becomes a quadratic fillet of radius
//                `roundPx` (clamped to half of each adjacent segment), so the
//                minimal polygon reads as a soft blob, not a shard.
//
// Optional `octi`: snap edge directions to 45° multiples before rounding (the
// TfL/Sound-Transit signature). The greedy resnap accumulates a closure error;
// it is distributed linearly over the vertices (a slight shear nobody sees at
// fillet radii) so the ring stays closed.
//
// All arithmetic is + − × ÷ √ min max on plain numbers in fixed iteration
// order — deterministic across engines, same as the layout pipeline.

export type Pt = [number, number];

/** UI-level landmass style: 'faithful' = the raw projected polygons,
 *  'rounded' = culled + simplified + filleted blobs, 'diagram' = rounded with
 *  edges snapped to the octilinear grid (the TfL/Sound-Transit look). */
export type LandmassMode = 'faithful' | 'rounded' | 'diagram';

/** Landmass knobs in BASE-CANVAS units (px at a 2700-wide render) — the draw
 *  layer rescales them by the actual canvas so a grown map keeps the same look. */
export interface LandmassParams {
  simplify: number;
  round: number;
  minArea: number;
  octi?: boolean;
}

/** Map the two UI knobs (mode + 0..1 detail slider) onto the px primitives.
 *  strength 0 is already visibly simplified; 1 is full metro-diagram blobs. */
export function landmassParams(mode: LandmassMode, strength: number): LandmassParams | undefined {
  if (mode === 'faithful') return undefined;
  const s = Math.max(0, Math.min(1, strength));
  const octi = mode === 'diagram';
  // The octi snap reads clean only on very generalized outlines — the diagram
  // mode simplifies ~1.7x harder and culls ~2.5x more at the same slider spot.
  const tol = (6 + 44 * s) * (octi ? 1.7 : 1);
  return {
    simplify: tol,
    round: 12 + 58 * s,
    minArea: (tol * 4) * (tol * 4) * (octi ? 2.5 : 1),
    octi,
  };
}

export interface LandmassStyle {
  /** Wiggle scale to erase, px: vertices whose effective triangle area is below
   *  simplifyPx² are dropped. 0 disables simplification. */
  simplifyPx: number;
  /** Corner fillet radius, px. 0 disables rounding. */
  roundPx: number;
  /** Rings with |area| < this (px²) are culled entirely. */
  minAreaPx2: number;
  /** Snap edges to octilinear directions before rounding. */
  octi?: boolean;
}

/** Signed shoelace area (px²): >0 counter-clockwise in SVG's y-down space is
 *  negative — callers only use |area|, winding is preserved untouched. */
export function ringArea(ring: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

const triArea = (a: Pt, b: Pt, c: Pt): number => {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  return (v < 0 ? -v : v) / 2;
};

/** Visvalingam–Whyatt on a CLOSED ring: drop the globally-least-significant
 *  vertex until every survivor's effective area >= areaThresh, or `minVerts`
 *  remain. Linked-list + full min-scan per removal — O(k·n) for k removals,
 *  fine after decimate(). */
export function simplifyVW(ring: readonly Pt[], areaThresh: number, minVerts = 4): Pt[] {
  const n = ring.length;
  if (n <= minVerts || areaThresh <= 0) return ring.slice();
  const prev = new Array<number>(n);
  const next = new Array<number>(n);
  const area = new Array<number>(n);
  const alive = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  const recompute = (i: number) => { area[i] = triArea(ring2[prev[i]], ring2[i], ring2[next[i]]); };
  const ring2 = ring as readonly Pt[];
  for (let i = 0; i < n; i++) recompute(i);
  let count = n;
  while (count > minVerts) {
    let mi = -1;
    let ma = Infinity;
    for (let i = 0; i < n; i++) if (alive[i] && area[i] < ma) { ma = area[i]; mi = i; }
    if (mi < 0 || ma >= areaThresh) break;
    alive[mi] = false;
    count--;
    const p = prev[mi];
    const q = next[mi];
    next[p] = q;
    prev[q] = p;
    recompute(p);
    recompute(q);
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (alive[i]) out.push(ring2[i]);
  return out;
}

/** Snap a closed ring's edges to the 8 octilinear directions: each edge keeps
 *  its length projected onto the nearest 45° direction, then the accumulated
 *  closure error is spread linearly across the vertices so the ring closes.
 *  Near-degenerate edges (< 1px after snapping) merge into their successor. */
export function snapOcti(ring: readonly Pt[]): Pt[] {
  const n = ring.length;
  if (n < 3) return ring.slice();
  const SQ = Math.sqrt(0.5);
  const DIRS: Pt[] = [[1, 0], [SQ, SQ], [0, 1], [-SQ, SQ], [-1, 0], [-SQ, -SQ], [0, -1], [SQ, -SQ]];
  const pts: Pt[] = [ring[0]];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    // nearest direction by max dot product (fully tiebroken: first wins)
    let best = 0;
    let bd = -Infinity;
    for (let k = 0; k < 8; k++) {
      const d = ex * DIRS[k][0] + ey * DIRS[k][1];
      if (d > bd) { bd = d; best = k; }
    }
    const len = bd < 0 ? 0 : bd; // projection of the edge onto the snapped dir
    const q = pts[pts.length - 1];
    pts.push([q[0] + DIRS[best][0] * len, q[1] + DIRS[best][1] * len]);
  }
  // pts has n+1 points; the last SHOULD equal the first. Spread the closure
  // error linearly (vertex i gets i/n of it) and drop the duplicate end.
  const last = pts[pts.length - 1];
  const errX = last[0] - pts[0][0];
  const errY = last[1] - pts[0][1];
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    out.push([pts[i][0] - (errX * i) / n, pts[i][1] - (errY * i) / n]);
  }
  // merge near-degenerate edges left by zero-projection snaps
  const merged: Pt[] = [];
  for (const p of out) {
    const q = merged[merged.length - 1];
    if (q) {
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      if (dx * dx + dy * dy < 1) continue;
    }
    merged.push(p);
  }
  if (merged.length < 3) return out;
  // drop vertices whose incoming and outgoing edges run the same direction
  // (consecutive same-snap edges) — fewer corners for the fillet pass
  const clean: Pt[] = [];
  const m = merged.length;
  for (let i = 0; i < m; i++) {
    const a = merged[(i + m - 1) % m];
    const b = merged[i];
    const c = merged[(i + 1) % m];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (cross < 1e-6 && cross > -1e-6 && dot > 0) continue; // straight-through
    clean.push(b);
  }
  return clean.length >= 3 ? clean : merged;
}

/** Union a category's (overlapping, per-tile) rings into clean unified
 *  outlines: rasterize nonzero winding onto a coarse cell grid (scanline over
 *  row centers — cost ∝ total perimeter, not area), then walk the filled
 *  region's boundaries emitting a vertex only at turns. Tile fragments that
 *  abut or overlap become ONE blob, so downstream simplification can't open
 *  cracks along their shared edges. Output winding is consistent (outers and
 *  holes opposite), so nonzero fill renders holes correctly. */
export function unionRings(
  rings: readonly (readonly Pt[])[],
  extent: { w: number; h: number },
  cellPx: number,
): Pt[][] {
  if (rings.length === 0) return [];
  const cell = Math.max(2, cellPx);
  const PAD = 2; // cells beyond the canvas so edge-touching blobs keep their rim
  const gx0 = -PAD * cell;
  const gy0 = -PAD * cell;
  const W = Math.ceil(extent.w / cell) + 2 * PAD;
  const H = Math.ceil(extent.h / cell) + 2 * PAD;
  const grid = new Uint8Array(W * H);

  // 1) scanline winding fill at each row's centre line
  const rows: { x: number; s: number }[][] = Array.from({ length: H }, () => []);
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a[1] === b[1]) continue;
      const s = a[1] < b[1] ? 1 : -1;
      const yLo = s > 0 ? a[1] : b[1];
      const yHi = s > 0 ? b[1] : a[1];
      // rows whose centre yc = gy0 + (r + 0.5)·cell lies in [yLo, yHi)
      let r0 = Math.ceil((yLo - gy0) / cell - 0.5);
      let r1 = Math.floor((yHi - gy0) / cell - 0.5 - 1e-9);
      if (r0 < 0) r0 = 0;
      if (r1 >= H) r1 = H - 1;
      for (let rr = r0; rr <= r1; rr++) {
        const yc = gy0 + (rr + 0.5) * cell;
        const t = (yc - a[1]) / (b[1] - a[1]);
        if (t < 0 || t > 1) continue;
        rows[rr].push({ x: a[0] + t * (b[0] - a[0]), s });
      }
    }
  }
  for (let rr = 0; rr < H; rr++) {
    const xs = rows[rr];
    if (xs.length === 0) continue;
    xs.sort((p, q) => p.x - q.x || p.s - q.s);
    let w = 0;
    for (let k = 0; k < xs.length; k++) {
      const wPrev = w;
      w += xs[k].s;
      if (wPrev === 0 && w !== 0) {
        // span opens at xs[k].x, closes where winding returns to 0
        let close = extent.w + PAD * cell;
        let w2 = w;
        let k2 = k;
        for (k2 = k + 1; k2 < xs.length; k2++) {
          w2 += xs[k2].s;
          if (w2 === 0) { close = xs[k2].x; break; }
        }
        let c0 = Math.ceil((xs[k].x - gx0) / cell - 0.5);
        let c1 = Math.floor((close - gx0) / cell - 0.5 - 1e-9);
        if (c0 < 0) c0 = 0;
        if (c1 >= W) c1 = W - 1;
        for (let cc = c0; cc <= c1; cc++) grid[rr * W + cc] = 1;
        w = 0;
        k = k2;
      }
    }
  }

  // 2) boundary walk: for every unvisited boundary edge, follow the contour
  // keeping the filled region on the RIGHT, emitting a vertex at each turn.
  // Directions: 0=+x, 1=+y, 2=-x, 3=-y (grid-corner space, y down).
  const at = (cx: number, cy: number): number => (cx < 0 || cy < 0 || cx >= W || cy >= H ? 0 : grid[cy * W + cx]);
  const visited = new Set<number>();
  const ekey = (cx: number, cy: number, dir: number): number => (cy * (W + 1) + cx) * 4 + dir;
  const out: Pt[][] = [];
  const px = (cx: number, cy: number): Pt => [gx0 + cx * cell, gy0 + cy * cell];
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      if (!at(cx, cy) || at(cx, cy - 1)) continue; // top boundary edge of a filled cell
      if (visited.has(ekey(cx, cy, 0))) continue;
      // walk from corner (cx,cy) heading +x, filled below-right
      const ring: Pt[] = [];
      let x = cx;
      let y = cy;
      let dir = 0;
      let prevDir = -1;
      for (let guard = 0; guard < W * H * 4 + 8; guard++) {
        if (dir === 0) visited.add(ekey(x, y, 0));
        else if (dir === 1) visited.add(ekey(x, y, 1));
        else if (dir === 2) visited.add(ekey(x - 1, y, 0));
        else visited.add(ekey(x, y - 1, 1));
        if (dir !== prevDir) { ring.push(px(x, y)); prevDir = dir; }
        // advance one corner
        if (dir === 0) x++;
        else if (dir === 1) y++;
        else if (dir === 2) x--;
        else y--;
        if (x === cx && y === cy && ring.length >= 3) break;
        // choose the next direction: keep filled on the right (left-hand rule
        // on the empty side). Candidate cells around the corner (x,y):
        //   dir 0 (+x): right cell = (x, y), left = (x, y-1)
        // turn preference: right turn, straight, left turn (traces tight
        // corners correctly and never crosses the region).
        const rightOf = (d: number): number => (d === 0 ? at(x, y) : d === 1 ? at(x - 1, y) : d === 2 ? at(x - 1, y - 1) : at(x, y - 1));
        const leftOf = (d: number): number => (d === 0 ? at(x, y - 1) : d === 1 ? at(x, y) : d === 2 ? at(x - 1, y) : at(x - 1, y - 1));
        const turnRight = (d: number): number => (d + 1) % 4;
        const turnLeft = (d: number): number => (d + 3) % 4;
        if (rightOf(turnRight(dir)) && !leftOf(turnRight(dir))) dir = turnRight(dir);
        else if (rightOf(dir) && !leftOf(dir)) { /* straight */ }
        else dir = turnLeft(dir);
      }
      if (ring.length >= 4) out.push(ring);
    }
  }
  return out;
}

const fmt = (v: number): number => Math.round(v * 10) / 10;

/** SVG path for a closed ring with every corner rounded by a quadratic fillet
 *  of radius `r` (clamped per corner to half of each adjacent segment). r <= 0
 *  emits the plain polygon. */
export function filletPathD(ring: readonly Pt[], r: number): string {
  const n = ring.length;
  if (n < 3) return '';
  if (r <= 0) {
    let d = '';
    for (let i = 0; i < n; i++) d += (i === 0 ? 'M' : 'L') + fmt(ring[i][0]) + ' ' + fmt(ring[i][1]) + ' ';
    return d + 'Z ';
  }
  // entry/exit points per corner
  let d = '';
  const pt = (i: number): Pt => ring[((i % n) + n) % n];
  for (let i = 0; i <= n; i++) {
    const cur = pt(i);
    const prv = pt(i - 1);
    const nxt = pt(i + 1);
    const inx = cur[0] - prv[0];
    const iny = cur[1] - prv[1];
    const outx = nxt[0] - cur[0];
    const outy = nxt[1] - cur[1];
    const inLen = Math.sqrt(inx * inx + iny * iny);
    const outLen = Math.sqrt(outx * outx + outy * outy);
    if (inLen < 1e-9 || outLen < 1e-9) continue;
    const ri = Math.min(r, inLen / 2, outLen / 2);
    const ax = cur[0] - (inx / inLen) * ri;
    const ay = cur[1] - (iny / inLen) * ri;
    const bx = cur[0] + (outx / outLen) * ri;
    const by = cur[1] + (outy / outLen) * ri;
    if (i === 0) {
      d += 'M' + fmt(bx) + ' ' + fmt(by) + ' ';
    } else {
      d += 'L' + fmt(ax) + ' ' + fmt(ay) + ' Q' + fmt(cur[0]) + ' ' + fmt(cur[1]) + ' ' + fmt(bx) + ' ' + fmt(by) + ' ';
    }
  }
  return d + 'Z ';
}

/** Full stylize pass over a category's rings: UNION (tile fragments → clean
 *  unified outlines; prevents cracks along shared tile edges) → cull → VW →
 *  (octi) → fillet. Returns one combined SVG path `d` ('' when nothing
 *  survives). `extent` is the render canvas the rings live on. */
export function stylizeRingsPathD(
  rings: readonly (readonly Pt[])[],
  style: LandmassStyle,
  extent: { w: number; h: number },
): string {
  const areaThresh = style.simplifyPx * style.simplifyPx;
  const cell = Math.min(14, Math.max(3, style.simplifyPx / 2));
  const unified = unionRings(rings, extent, cell);
  let d = '';
  for (const ring of unified) {
    const a = ringArea(ring);
    if ((a < 0 ? -a : a) < style.minAreaPx2) continue;
    let r = simplifyVW(ring, areaThresh);
    if (r.length < 3) continue;
    // a ring can shrivel below the cull floor once its wiggles are gone
    const a2 = ringArea(r);
    if ((a2 < 0 ? -a2 : a2) < style.minAreaPx2) continue;
    if (style.octi) r = snapOcti(r);
    if (r.length < 3) continue;
    d += filletPathD(r, style.roundPx);
  }
  return d.trim();
}
