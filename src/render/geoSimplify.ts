// Simplified-landmass stylizer: turns projected water/park rings into the
// rounded, low-detail blobs real metro diagrams use. Three tunable primitives,
// applied per ring at DRAW time (pixel space, after projection and warp). It
// never touches the layout.
//
//   1. CULL    is where rings whose |area| is below `minAreaPx2` vanish
//                outright (ponds, islets, sliver parks that diagram maps omit).
//   2. SIMPLIFY runs Visvalingam–Whyatt: repeatedly drop the vertex whose
//                "effective triangle" (with its two neighbours) has the smallest
//                area, until every remaining vertex matters by at least
//                `simplifyPx²`. VW eats coastline wiggles while keeping the
//                blob's silhouette, blobbier than Douglas-Peucker at the same
//                vertex count. A cheap radial pre-filter bounds the O(n²)
//                min-scan on tile-resolution rings.
//   3. ROUND    turns every remaining corner into a quadratic fillet of radius
//                `roundPx` (clamped to half of each adjacent segment), so the
//                minimal polygon reads as a soft blob, not a shard.
//
// Optional `octi`: snap edge directions to 45° multiples before rounding. The
// greedy resnap accumulates a closure error; it is distributed linearly over
// the vertices (a slight shear invisible at fillet radii) so the ring stays
// closed.
//
// All arithmetic is + − × ÷ √ min max on plain numbers in fixed iteration
// order, deterministic across engines, same as the layout pipeline.

export type Pt = [number, number];

/** UI-level landmass style: 'faithful' = the raw projected polygons,
 *  'rounded' = culled + simplified + filleted blobs, 'diagram' = rounded with
 *  edges snapped to the octilinear grid. */
export type LandmassMode = 'faithful' | 'rounded' | 'diagram';

/** Landmass knobs in BASE-CANVAS units (px at a 2700-wide render). The draw
 *  layer rescales them by the actual canvas so a grown map keeps the same look. */
export interface LandmassParams {
  simplify: number;
  round: number;
  minArea: number;
  octi?: boolean;
  /** Water-only floor width for narrow features (base-canvas px). */
  minWidth: number;
}

/** Map the two UI knobs (mode + 0..1 detail slider) onto the px primitives.
 *  strength 0 is already visibly simplified; 1 is full metro-diagram blobs. */
export function landmassParams(mode: LandmassMode, strength: number): LandmassParams | undefined {
  if (mode === 'faithful') return undefined;
  const s = Math.max(0, Math.min(1, strength));
  const octi = mode === 'diagram';
  // The octi snap reads clean only on very generalized outlines, so diagram
  // mode simplifies ~1.7x harder at the same slider spot. No extra cull
  // multiplier: the morphological opening already erases peripheral slivers,
  // and an inflated floor can eat protected landmarks in diagram mode.
  const tol = (6 + 44 * s) * (octi ? 1.7 : 1);
  return {
    simplify: tol,
    round: 12 + 58 * s,
    minArea: (tol * 4) * (tol * 4),
    octi,
    // Constant across the slider: a channel is either legible or it is not, so
    // the floor must not shrink as the rest of the map generalizes. Sized to
    // read as a distinct channel at a base-canvas render.
    minWidth: 7,
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
  /** Local importance 0..1 at a render-px point. Where it's high (the warp's
   *  dense boxes, station clusters) the simplify/cull thresholds are divided by
   *  (1 + PROTECT·imp)². Heavily-used areas keep their geography while the
   *  periphery generalizes to blobs. Absent = the uniform thresholds
   *  everywhere. */
  importance?: (x: number, y: number) => number;
  /** Points that must stay OUTSIDE the styled polygons (station markers that
   *  are on land in the faithful geography). After the full pipeline, any of
   *  these caught inside gets a notch carved around it. Simplification may
   *  reshape a shoreline but may never move a station into the water. */
  dryPoints?: readonly Pt[];
  /** Water only: never CREATE lakes. Each originally-connected water body
   *  either survives connected (severed channels are reconnected by geodesic
   *  corridors along the real course) or is swallowed entirely. */
  keepConnected?: boolean;
  /** The harvested data region's outline in render px (rotated cities). Ring
   *  vertices near it are the DATA CUTOFF, not shapes to stylize. They get
   *  pinned exactly like the canvas rim, so the styled water always meets the
   *  drawn land hull instead of swinging across it. */
  hullPx?: readonly Pt[];
  /** Clearance around a repaired dry point, px (default 14). */
  dryMarginPx?: number;
  /** Water only: floor width (render px) for narrow features. Channels, cuts and
   *  canals thinner than this are restored after the generalizing opening and
   *  drawn at this width, so they cannot be dissolved at any simplification
   *  setting. 0 disables the guarantee. */
  minWidthPx?: number;
}

/** VW protection gain: importance scales the simplify threshold down by
 *  (1+PROTECT·imp)², capped at PROTECT_MAX_VW. The cap is load-bearing: the
 *  raster's staircase triangles have area cell²/2, and the weighted threshold
 *  must stay above them or protected regions expose raw raster stairs
 *  (cell <= tol/5 ⇒ stair area <= tol²/50; the cap keeps the threshold at
 *  tol²/6, far above). The CULL doesn't use this gain at all (see cullOk):
 *  protected regions trust the morphological opening instead of an area floor. */
const PROTECT = 3;
const PROTECT_MAX_VW = 6;

/** Signed shoelace area (px²): >0 counter-clockwise in SVG's y-down space is
 *  negative. Callers only use |area|, winding is preserved untouched. */
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
 *  remain. Linked-list + full min-scan per removal, O(k·n) for k removals,
 *  fine on union-traced rings. `weight` (>= 1) multiplies a vertex's effective
 *  area, so protected (important-area) vertices resist removal proportionally. */
export function simplifyVW(
  ring: readonly Pt[],
  areaThresh: number,
  minVerts = 4,
  weight?: (p: Pt) => number,
  /** Points that must never change sides: removing a vertex flips EXACTLY the
   *  triangle (prev, i, next) between inside and outside, so a removal whose
   *  triangle contains one of these is vetoed. This is what keeps a styled
   *  shoreline from flooding a land station, since a peninsula narrower than the
   *  tolerance is one removal away from becoming water. */
  avoidPoints?: readonly Pt[],
): Pt[] {
  const n = ring.length;
  if (n <= minVerts || areaThresh <= 0) return ring.slice();
  const prev = new Array<number>(n);
  const next = new Array<number>(n);
  const area = new Array<number>(n);
  const alive = new Array<boolean>(n).fill(true);
  const locked = new Array<boolean>(n).fill(false);
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
    w[i] = weight ? weight(ring[i]) : 1;
  }
  const ring2 = ring as readonly Pt[];
  const recompute = (i: number) => {
    area[i] = triArea(ring2[prev[i]], ring2[i], ring2[next[i]]) * w[i];
    locked[i] = false; // the triangle changed — re-evaluate the veto
  };
  for (let i = 0; i < n; i++) recompute(i);
  const triHasAvoid = (i: number): boolean => {
    if (!avoidPoints || avoidPoints.length === 0) return false;
    const a = ring2[prev[i]];
    const b = ring2[i];
    const c = ring2[next[i]];
    const mnX = Math.min(a[0], b[0], c[0]);
    const mxX = Math.max(a[0], b[0], c[0]);
    const mnY = Math.min(a[1], b[1], c[1]);
    const mxY = Math.max(a[1], b[1], c[1]);
    for (const s of avoidPoints) {
      if (s[0] < mnX || s[0] > mxX || s[1] < mnY || s[1] > mxY) continue;
      // sign tests with an on-edge cushion: boundary cases count as inside
      const d1 = (b[0] - a[0]) * (s[1] - a[1]) - (b[1] - a[1]) * (s[0] - a[0]);
      const d2 = (c[0] - b[0]) * (s[1] - b[1]) - (c[1] - b[1]) * (s[0] - b[0]);
      const d3 = (a[0] - c[0]) * (s[1] - c[1]) - (a[1] - c[1]) * (s[0] - c[0]);
      const EPS = 1e-6;
      const neg = d1 < EPS && d2 < EPS && d3 < EPS;
      const pos = d1 > -EPS && d2 > -EPS && d3 > -EPS;
      if (neg || pos) return true;
    }
    return false;
  };
  let count = n;
  while (count > minVerts) {
    let mi = -1;
    let ma = Infinity;
    for (let i = 0; i < n; i++) if (alive[i] && !locked[i] && area[i] < ma) { ma = area[i]; mi = i; }
    if (mi < 0 || ma >= areaThresh) break;
    if (triHasAvoid(mi)) { locked[mi] = true; continue; }
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

/** Drop near-degenerate edges and straight-through vertices (incoming and
 *  outgoing edges colinear, same direction) for fewer corners at the fillets. */
function cleanRing(pts: readonly Pt[]): Pt[] {
  const merged: Pt[] = [];
  for (const p of pts) {
    const q = merged[merged.length - 1];
    if (q) {
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      if (dx * dx + dy * dy < 1) continue;
    }
    merged.push(p);
  }
  if (merged.length < 3) return pts.slice();
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

/** Octilinearize a closed ring by ANCHORED LEAST SQUARES (curve
 *  schematization): each edge is assigned its nearest 45° direction, then
 *  vertex positions solve
 *      min Σ w_i·|p_i − v_i|²  +  λ Σ_edges ((p_{i+1} − p_i)·n_e)²
 *  where n_e is the assigned direction's normal. Edges become octilinear
 *  (their off-axis component is crushed) while every vertex stays pulled to
 *  its TRUE position. Unlike a walk-and-snap (dead reckoning), positional
 *  error CANNOT accumulate along the ring, which otherwise drifts coastlines
 *  far mid-ring and can put stations in the water.
 *  `anchor` adds per-vertex anchor weight on top of the base 1 (importance:
 *  dense-core shorelines barely move at all). Deterministic: fixed rounds of
 *  direction assignment, fixed Gauss–Seidel sweeps in index order. */
export function snapOcti(ring: readonly Pt[], anchor?: (p: Pt) => number, maxShift?: number): Pt[] {
  const n = ring.length;
  if (n < 3) return ring.slice();
  const SQ = Math.sqrt(0.5);
  const DIRS: Pt[] = [[1, 0], [SQ, SQ], [0, 1], [-SQ, SQ], [-1, 0], [-SQ, -SQ], [0, -1], [SQ, -SQ]];
  const LAMBDA = 25; // octilinearity stiffness vs the unit position anchor
  const p: Pt[] = ring.map((v) => [v[0], v[1]]);
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = anchor ? anchor(ring[i]) : 0;
    w[i] = 1 + (a > 0 ? a : 0);
  }
  const nx = new Array<number>(n);
  const ny = new Array<number>(n);
  const ex = new Array<number>(n);
  const ey = new Array<number>(n);
  for (let round = 0; round < 3; round++) {
    // (re)assign each edge's direction from the CURRENT geometry, with
    // NEIGHBOR SMOOTHING: each edge votes together with its neighbours
    // (1-2-1 window), so a gently curving chain — which per-edge assignment
    // would quantize into a fine 0°/45° zigzag — snaps to ONE consistent
    // direction and the solve fits a long straight run through the anchors.
    // Real corners (large direction changes) out-vote the window and stay.
    for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      ex[i] = b[0] - a[0];
      ey[i] = b[1] - a[1];
    }
    for (let i = 0; i < n; i++) {
      const ip = (i + n - 1) % n;
      const iq = (i + 1) % n;
      const vx = ex[ip] + 2 * ex[i] + ex[iq];
      const vy = ey[ip] + 2 * ey[i] + ey[iq];
      let best = 0;
      let bd = -Infinity;
      for (let k = 0; k < 8; k++) {
        const d = vx * DIRS[k][0] + vy * DIRS[k][1];
        if (d > bd) { bd = d; best = k; }
      }
      nx[i] = -DIRS[best][1];
      ny[i] = DIRS[best][0];
    }
    // Gauss–Seidel: each vertex minimizes its local quadratic (2x2 solve)
    for (let it = 0; it < 40; it++) {
      for (let i = 0; i < n; i++) {
        const v = ring[i];
        const ip = (i + n - 1) % n;
        const iq = (i + 1) % n;
        const px = nx[ip], py = ny[ip]; // normal of the incoming edge
        const qx = nx[i], qy = ny[i]; // normal of the outgoing edge
        const a11 = w[i] + LAMBDA * (px * px + qx * qx);
        const a12 = LAMBDA * (px * py + qx * qy);
        const a22 = w[i] + LAMBDA * (py * py + qy * qy);
        const dp = px * p[ip][0] + py * p[ip][1];
        const dq = qx * p[iq][0] + qy * p[iq][1];
        const b1 = w[i] * v[0] + LAMBDA * (px * dp + qx * dq);
        const b2 = w[i] * v[1] + LAMBDA * (py * dp + qy * dq);
        const det = a11 * a22 - a12 * a12;
        if (det > 1e-12) {
          p[i][0] = (b1 * a22 - b2 * a12) / det;
          p[i][1] = (b2 * a11 - b1 * a12) / det;
        }
      }
    }
  }
  // Hard displacement bound: the anchored solve keeps vertices NEAR their true
  // positions on average, but a chain of same-direction edges can still shift
  // laterally as a unit (the direction penalty grows with length², the anchors
  // only linearly) — at large tolerances that swept water across whole
  // neighbourhoods. Clamp every vertex to `maxShift` of its source position;
  // the fillet pass hides the slightly-off-axis kinks the clamp introduces.
  if (maxShift !== undefined && maxShift > 0) {
    for (let i = 0; i < n; i++) {
      const dx = p[i][0] - ring[i][0];
      const dy = p[i][1] - ring[i][1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxShift) {
        p[i][0] = ring[i][0] + (dx * maxShift) / d;
        p[i][1] = ring[i][1] + (dy * maxShift) / d;
      }
    }
  }
  return cleanRing(p);
}

/** Union a category's (overlapping, per-tile) rings into clean unified
 *  outlines: rasterize nonzero winding onto a coarse cell grid (scanline over
 *  row centers — cost ∝ total perimeter, not area), then walk the filled
 *  region's boundaries emitting a vertex only at turns. Tile fragments that
 *  abut or overlap become ONE blob, so downstream simplification can't open
 *  cracks along their shared edges. Output winding is consistent (outers and
 *  holes opposite), so nonzero fill renders holes correctly. */
export interface GeoRaster {
  grid: Uint8Array;
  W: number;
  H: number;
  gx0: number;
  gy0: number;
  cell: number;
}

export function unionRings(
  rings: readonly (readonly Pt[])[],
  extent: { w: number; h: number },
  cellPx: number,
): Pt[][] {
  const r = rasterizeRings(rings, extent, cellPx);
  return r ? traceRaster(r) : [];
}

/** Nonzero-winding scanline rasterization of a ring soup onto a cell grid. */
export function rasterizeRings(
  rings: readonly (readonly Pt[])[],
  extent: { w: number; h: number },
  cellPx: number,
): GeoRaster | null {
  if (rings.length === 0) return null;
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
  return { grid, W, H, gx0, gy0, cell };
}

/** Spatially-varying morphological OPENING on the raster (in place): erode by
 *  radius(x,y), then dilate the survivors back by the same local radius. This
 *  is the feature-scale generalization step. Anything thinner than 2·radius
 *  vanishes; everything else keeps its footprint. Because the radius
 *  shrinks where importance is high, a narrow-but-important channel
 *  survives while peripheral slivers are wiped. Chebyshev chamfer
 *  distance (two passes each way), deterministic. */
export function morphOpen(r: GeoRaster, radiusPx: (x: number, y: number) => number): void {
  const { grid, W, H, gx0, gy0, cell } = r;
  const N = W * H;
  const INF = 1 << 20;
  // distance (in cells, Chebyshev) to the nearest EMPTY cell
  const d = new Int32Array(N);
  for (let i = 0; i < N; i++) d[i] = grid[i] ? INF : 0;
  const relax = () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (d[i] === 0) continue;
        let m = d[i];
        if (x > 0 && d[i - 1] + 1 < m) m = d[i - 1] + 1;
        if (y > 0) {
          const j = i - W;
          if (d[j] + 1 < m) m = d[j] + 1;
          if (x > 0 && d[j - 1] + 1 < m) m = d[j - 1] + 1;
          if (x < W - 1 && d[j + 1] + 1 < m) m = d[j + 1] + 1;
        }
        d[i] = m;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (d[i] === 0) continue;
        let m = d[i];
        if (x < W - 1 && d[i + 1] + 1 < m) m = d[i + 1] + 1;
        if (y < H - 1) {
          const j = i + W;
          if (d[j] + 1 < m) m = d[j] + 1;
          if (x > 0 && d[j - 1] + 1 < m) m = d[j - 1] + 1;
          if (x < W - 1 && d[j + 1] + 1 < m) m = d[j + 1] + 1;
        }
        d[i] = m;
      }
    }
  };
  relax();
  // per-cell erosion radius in CELLS (evaluated at the cell centre)
  const kAt = (x: number, y: number): number => {
    const rad = radiusPx(gx0 + (x + 0.5) * cell, gy0 + (y + 0.5) * cell);
    return rad > 0 ? Math.round(rad / cell) : 0;
  };
  // erode: survivors are cells strictly deeper than their local radius
  const kept = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] && d[i] > kAt(x, y)) kept[i] = 1;
    }
  }
  // dilate back: distance to the nearest KEPT cell, refill within the radius
  for (let i = 0; i < N; i++) d[i] = kept[i] ? 0 : INF;
  relax();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      grid[i] = grid[i] && d[i] <= kAt(x, y) ? 1 : 0;
    }
  }
}

/** Chebyshev chamfer distance, two passes each way. Deterministic.
 *  `toFilled` picks the seed set: false = distance to the nearest EMPTY cell
 *  (what an erosion needs), true = distance to the nearest FILLED cell (what a
 *  dilation needs). Getting this backwards on a dilation is catastrophic: an
 *  empty seed set makes every cell distance 0, i.e. fills the whole raster. */
function chamfer(src: Uint8Array, W: number, H: number, toFilled = false): Int32Array {
  const N = W * H;
  const INF = 1 << 20;
  const d = new Int32Array(N);
  if (toFilled) for (let i = 0; i < N; i++) d[i] = src[i] ? 0 : INF;
  else for (let i = 0; i < N; i++) d[i] = src[i] ? INF : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0 && d[i - 1] + 1 < m) m = d[i - 1] + 1;
      if (y > 0) {
        const j = i - W;
        if (d[j] + 1 < m) m = d[j] + 1;
        if (x > 0 && d[j - 1] + 1 < m) m = d[j - 1] + 1;
        if (x < W - 1 && d[j + 1] + 1 < m) m = d[j + 1] + 1;
      }
      d[i] = m;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < W - 1 && d[i + 1] + 1 < m) m = d[i + 1] + 1;
      if (y < H - 1) {
        const j = i + W;
        if (d[j] + 1 < m) m = d[j] + 1;
        if (x > 0 && d[j - 1] + 1 < m) m = d[j - 1] + 1;
        if (x < W - 1 && d[j + 1] + 1 < m) m = d[j + 1] + 1;
      }
      d[i] = m;
    }
  }
  return d;
}

/**
 * Guarantee a minimum drawn width for narrow water (in place).
 *
 * The feature-scale opening removes anything thinner than twice its radius, which
 * is exactly the class a transit map must keep: the channels, cuts and canals that
 * make a coastline legible. Rather than weaken the opening (which would leave the
 * wide coastline un-generalized), restore the narrow parts afterwards at a floor
 * width, the way a printed map draws a river wider than scale.
 *
 * NARROW is defined against the ORIGINAL water: a cell is narrow when no disk of
 * radius minWidth/2 fits inside the water while covering it, i.e. it is outside
 * `open(original, minWidth/2)`. That excludes the rims of wide bodies (a rim cell
 * is covered by a disk seated further in), so this only ever re-adds genuine thin
 * structure and never undoes the generalization of a big shoreline.
 *
 * @param origGrid the water grid BEFORE the generalizing opening.
 * @param minWidthPx floor width in render px; <= one cell is a no-op.
 * @param openRadiusPx the generalizing opening's radius, i.e. the scale at which
 *        features were removed. Detection happens at THIS scale, not at the floor,
 *        or everything between the floor and the opening would still be lost.
 */
export function enforceMinWidth(r: GeoRaster, origGrid: Uint8Array, minWidthPx: number, openRadiusPx: number): Pt[] {
  const { grid, W, H, cell, gx0, gy0 } = r;
  const N = W * H;
  const kMin = Math.round(minWidthPx / 2 / cell);
  const kOpen = Math.round(openRadiusPx / cell);
  if (kMin < 1) return []; // finer than the raster can express
  // Regions of the ORIGINAL not covered by any disk of radius k seated inside it,
  // i.e. everything narrower than 2k. A wide body's rim IS covered (by a disk
  // seated further in), so this never re-adds a generalized shoreline.
  const d0 = chamfer(origGrid, W, H);
  const narrowerThan = (k: number): Uint8Array => {
    const eroded = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (origGrid[i] && d0[i] > k) eroded[i] = 1;
    const dOpen = chamfer(eroded, W, H, true); // dilation: distance TO the survivors
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (origGrid[i] && dOpen[i] > k) out[i] = 1;
    return out;
  };
  // Everything the opening dissolved: restore at true width, so a channel exists.
  const removed = narrowerThan(kOpen);
  for (let i = 0; i < N; i++) if (removed[i]) grid[i] = 1;
  // Of those, the ones below the floor are widened to it, so they stay legible.
  const subMin = narrowerThan(kMin);
  const dSub = chamfer(subMin, W, H, true); // dilation: distance TO the sub-floor regions
  for (let i = 0; i < N; i++) if (dSub[i] <= kMin) grid[i] = 1;
  // Sample the restored structure for the VW veto. The raster restore alone is
  // not enough: the vector pass that follows judges a vertex by its effective
  // triangle area, and every vertex of a thin channel is tiny by that measure, so
  // VW collapses the banks back together and re-closes what was just restored,
  // which is why the channel survives at low simplification and shuts at high.
  // Sparse (every 3rd cell, as the corridor sampler does) so a large restored
  // area cannot flood the veto list, which is scanned per candidate removal.
  // Subsample the HITS, not the grid: a restored channel is only a cell or two
  // across, so stepping over grid positions skips straight past the very features
  // this protects (it yielded zero points for an 8px channel).
  const pts: Pt[] = [];
  let hit = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!removed[y * W + x]) continue;
      if (hit++ % 3 === 0) pts.push([gx0 + (x + 0.5) * cell, gy0 + (y + 0.5) * cell]);
    }
  }
  return pts;
}

/** Boundary walk over a raster: for every unvisited boundary edge, follow the
 *  contour keeping the filled region on the RIGHT, emitting a vertex at each
 *  turn. Output winding is consistent (outers and holes opposite), so nonzero
 *  fill renders holes correctly.
 *  Directions: 0=+x, 1=+y, 2=-x, 3=-y (grid-corner space, y down). */
export function traceRaster(r: GeoRaster): Pt[][] {
  const { grid, W, H, gx0, gy0, cell } = r;
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

/** Nonzero winding of point (x,y) over a set of rings. */
export function windingAt(rings: readonly (readonly Pt[])[], x: number, y: number): number {
  let w = 0;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a[1] <= y) {
        if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) w++;
      } else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) w--;
    }
  }
  return w;
}

/** Final dry-point guarantee (mutates `rings`): for every dry point the styled
 *  polygons swallowed, carve a triangular notch around it in the nearest ring
 *  edge. With the fillet pass after, it reads as a small bay. Simplification
 *  and the octilinear solve keep positions CLOSE, but a long straight edge can
 *  still cut across a curving shore between anchored vertices; this pass turns
 *  "stations stay on land" from likely into guaranteed. Deterministic: points
 *  in input order, retry-bounded. */
export function repairDryPoints(rings: Pt[][], dryPoints: readonly Pt[], margin: number): void {
  // Global rounds: notches for NEARBY dry points can interact (a later carve
  // crossing an earlier one re-wets it), so re-verify every point until a
  // full pass is clean. Bounded; empirically converges in 1-2 rounds.
  for (let round = 0; round < 3; round++) {
    let dirty = false;
    for (const s of dryPoints) {
      if (windingAt(rings, s[0], s[1]) === 0) continue;
      dirty = true;
      repairOne(rings, s, margin, round);
    }
    if (!dirty) break;
  }
}

function repairOne(rings: Pt[][], s: Pt, margin: number, round: number): void {
  {
    for (let attempt = round; attempt < round + 3; attempt++) {
      if (windingAt(rings, s[0], s[1]) === 0) break;
      // nearest edge over all rings (foot of perpendicular, clamped to segment)
      let bRing = -1;
      let bEdge = -1;
      let bD2 = Infinity;
      let bFoot: Pt = [0, 0];
      for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri];
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          const ex = b[0] - a[0];
          const ey = b[1] - a[1];
          const ll = ex * ex + ey * ey;
          let t = ll > 1e-12 ? ((s[0] - a[0]) * ex + (s[1] - a[1]) * ey) / ll : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const fx = a[0] + t * ex;
          const fy = a[1] + t * ey;
          const dx = s[0] - fx;
          const dy = s[1] - fy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bD2) { bD2 = d2; bRing = ri; bEdge = i; bFoot = [fx, fy]; }
        }
      }
      if (bRing < 0) break;
      const ring = rings[bRing];
      const a = ring[bEdge];
      const b = ring[(bEdge + 1) % ring.length];
      const d = Math.sqrt(bD2);
      // direction from the boundary toward (and past) the point; when the
      // point sits ON the boundary, fall back to the edge normal. The retry
      // flips it via the winding re-test if the first side was wrong
      let ux: number;
      let uy: number;
      if (d > 0.5) {
        ux = (s[0] - bFoot[0]) / d;
        uy = (s[1] - bFoot[1]) / d;
      } else {
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const el = Math.sqrt(ex * ex + ey * ey) || 1;
        ux = attempt % 2 === 0 ? -ey / el : ey / el;
        uy = attempt % 2 === 0 ? ex / el : -ex / el;
      }
      const h = d + margin;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const el = Math.sqrt(ex * ex + ey * ey) || 1;
      const tx = ex / el;
      const ty = ey / el;
      // Shoulders CLAMPED to the segment: overshooting past its endpoints
      // makes the ring self-intersect (a bowtie), which corrupts the winding
      // instead of carving. Clamped-to-endpoint shoulders degenerate cleanly
      // (the whole edge detours via the apex).
      const tFoot = (bFoot[0] - a[0]) * tx + (bFoot[1] - a[1]) * ty;
      const s1 = Math.max(0, tFoot - h);
      const s2 = Math.min(el, tFoot + h);
      const p1: Pt = [a[0] + tx * s1, a[1] + ty * s1];
      const apex: Pt = [s[0] + ux * margin, s[1] + uy * margin];
      const p2: Pt = [a[0] + tx * s2, a[1] + ty * s2];
      ring.splice(bEdge + 1, 0, p1, apex, p2);
    }
  }
}

/** Insert evenly-spaced midpoints so no edge exceeds `maxLen` px. */
export function subdivideRing(ring: readonly Pt[], maxLen: number): Pt[] {
  const out: Pt[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    out.push([a[0], a[1]]);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const k = maxLen > 0 ? Math.floor(len / maxLen) : 0;
    for (let s = 1; s <= k; s++) out.push([a[0] + (dx * s) / (k + 1), a[1] + (dy * s) / (k + 1)]);
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

/** Continuity constraint (water): the stylizer must not CREATE lakes. A
 *  connected body of water either survives CONNECTED or vanishes entirely.
 *  The morphological opening severs channels narrower than its local radius,
 *  which would leave a river as a chain of disconnected "lakes". After the
 *  opening (mutates `post` in place):
 *    1. label the connected components of the ORIGINAL raster and of the
 *       survivor (4-connectivity);
 *    2. survivor pieces that couldn't justify themselves alone are dropped
 *       (pieceOk mirrors the ring cull);
 *    3. per original component, if >= 2 worthy pieces remain they are
 *       RECONNECTED by geodesic corridors: BFS shortest paths INSIDE the
 *       original water mask (so a corridor can never invent water where
 *       there was none), filled 3 cells wide.
 *  Zero worthy pieces = the whole component is swallowed; one = already
 *  continuous. Returns corridor midpoints for the downstream VW veto so
 *  simplification can't pinch a corridor shut. Deterministic: scan-order
 *  labelling, fixed BFS neighbour order. */
export function enforceContinuity(
  post: GeoRaster,
  origGrid: Uint8Array,
  pieceOk: (areaPx2: number, bestImp: number) => number | boolean,
  imp?: (x: number, y: number) => number,
): Pt[] {
  const { grid, W, H, gx0, gy0, cell } = post;
  const N = W * H;
  const label = (g: Uint8Array): { lab: Int32Array; count: number } => {
    const lab = new Int32Array(N).fill(-1);
    let count = 0;
    const stack: number[] = [];
    for (let i0 = 0; i0 < N; i0++) {
      if (!g[i0] || lab[i0] >= 0) continue;
      const id = count++;
      lab[i0] = id;
      stack.push(i0);
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % W;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
        for (const j of nb) {
          if (j < 0 || j >= N || !g[j] || lab[j] >= 0) continue;
          lab[j] = id;
          stack.push(j);
        }
      }
    }
    return { lab, count };
  };
  const orig = label(origGrid);
  const surv = label(grid);
  if (surv.count === 0) return [];
  // per survivor piece: cell count, best importance, parent original component
  const cells = new Int32Array(surv.count);
  const best = new Float32Array(surv.count);
  const parent = new Int32Array(surv.count).fill(-1);
  for (let i = 0; i < N; i++) {
    const s = surv.lab[i];
    if (s < 0) continue;
    cells[s]++;
    if (parent[s] < 0) parent[s] = orig.lab[i];
    if (imp) {
      const v = imp(gx0 + ((i % W) + 0.5) * cell, gy0 + (Math.floor(i / W) + 0.5) * cell);
      const c = v > 1 ? 1 : v < 0 ? 0 : v;
      if (c > best[s]) best[s] = c;
    }
  }
  // drop pieces that can't stand alone; group the keepers by original component
  const keep = new Array<boolean>(surv.count);
  const groups = new Map<number, number[]>();
  for (let s = 0; s < surv.count; s++) {
    keep[s] = !!pieceOk(cells[s] * cell * cell, best[s]);
    if (keep[s]) {
      const g = groups.get(parent[s]) ?? [];
      g.push(s);
      groups.set(parent[s], g);
    }
  }
  for (let i = 0; i < N; i++) if (surv.lab[i] >= 0 && !keep[surv.lab[i]]) grid[i] = 0;
  // reconnect: per original component with >= 2 kept pieces, BFS through the
  // ORIGINAL mask from the union of connected-so-far to the nearest other piece
  const corridorPts: Pt[] = [];
  const bfsParent = new Int32Array(N);
  const dist = new Int32Array(N);
  for (const [og, pieces] of groups) {
    if (pieces.length < 2) continue;
    const connected = new Set<number>([pieces[0]]);
    for (let round = 0; round < pieces.length - 1; round++) {
      bfsParent.fill(-1);
      dist.fill(-1);
      const queue: number[] = [];
      for (let i = 0; i < N; i++) {
        const s = surv.lab[i];
        if (s >= 0 && connected.has(s) && grid[i]) { dist[i] = 0; bfsParent[i] = i; queue.push(i); }
      }
      let hit = -1;
      let hitPiece = -1;
      for (let qi = 0; qi < queue.length && hit < 0; qi++) {
        const i = queue[qi];
        const x = i % W;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
        for (const j of nb) {
          if (j < 0 || j >= N || dist[j] >= 0 || orig.lab[j] !== og) continue;
          dist[j] = dist[i] + 1;
          bfsParent[j] = i;
          const sj = surv.lab[j];
          if (sj >= 0 && keep[sj] && !connected.has(sj) && grid[j]) { hit = j; hitPiece = sj; break; }
          queue.push(j);
        }
      }
      if (hit < 0) break; // unreachable (shouldn't happen: all pieces ⊆ one orig component)
      connected.add(hitPiece);
      // backtrack: fill a 3-wide corridor along the path, CLAMPED to the
      // original water so reconnection never floods faithful land. Veto
      // keep-points are emitted ONLY for genuinely re-filled (throat) cells.
      // Most of a path runs through wide surviving water, and blanketing it
      // with veto points would freeze VW along every river system.
      const path: number[] = [];
      const wasEmpty: boolean[] = [];
      for (let i = hit; bfsParent[i] !== i; i = bfsParent[i]) {
        path.push(i);
        wasEmpty.push(grid[i] === 0); // pristine state, BEFORE any corridor fill
      }
      let step = 0;
      for (let k = 0; k < path.length; k++) {
        const i = path[k];
        const x = i % W;
        const y = Math.floor(i / W);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (origGrid[j]) grid[j] = 1;
          }
        }
        if (wasEmpty[k]) {
          if (step % 3 === 0) corridorPts.push([gx0 + (x + 0.5) * cell, gy0 + (y + 0.5) * cell]);
          step++;
        }
      }
    }
  }
  return corridorPts;
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
  const imp = style.importance;
  // Raster resolution: fine enough that the morphological opening's SMALL radii
  // (protected regions) are resolvable. cell ≈ tol/5, floor 3, cap 8.
  // ...and fine enough to express the minimum-width floor, which is measured in
  // cells (a floor below one cell would silently vanish).
  // ...and fine enough to RESOLVE the features the floor promises to keep. The
  // cell must be sized against the channel as it really is, not against the floor
  // we intend to widen it to: a cut is routinely thinner than the floor, and the
  // rasterizer samples cell centres, so a band needs roughly three cells across it
  // before a sample reliably lands inside. At minW/2 a channel just under the
  // floor falls between samples and is lost HERE, before any simplification runs,
  // which no later restore can undo. That also made the loss depend on the slider,
  // since the cell grew with it: present at low simplification, gone at high.
  const minW = style.minWidthPx ?? 0;
  const cell = Math.min(
    minW > 0 ? Math.max(1, minW / 3) : Infinity,
    Math.min(8, Math.max(3, style.simplifyPx / 5)),
  );
  const raster = rasterizeRings(rings, extent, cell);
  if (!raster) return '';
  // Feature-scale generalization: opening with radius tol/2, scaled DOWN by
  // importance to ZERO at full importance. Thin peripheral slivers vanish,
  // while inside the dense core the geography's true shape stands (the VW pass
  // still smooths its outline). QUADRATIC falloff: station kernels peak on the
  // shores, so the middle of an important body of water sees only moderate
  // importance. A linear falloff still erodes its arms at strong sliders, and
  // losing the arms fragments (then loses) the body. (1-imp)² keeps
  // mid-importance water intact and concentrates the full radius on the true
  // periphery. This (not the cull) is what preserves landmark-scale water
  // through the diagram modes.
  const sf0 = Math.min(extent.w, extent.h) / 2700;
  const dust0 = Math.max(9 * cell * cell, Math.min(0.36 * areaThresh, 2600 * sf0 * sf0));
  const pieceOk = (areaPx2: number, bestImp: number): boolean => {
    if (areaPx2 >= style.minAreaPx2) return true;
    if (!imp) return false;
    const u = 1 - (bestImp > 1 ? 1 : bestImp < 0 ? 0 : bestImp);
    return areaPx2 >= Math.max(dust0, style.minAreaPx2 * u * u);
  };
  const origGrid = style.keepConnected ? raster.grid.slice() : null;
  morphOpen(raster, (x, y) => {
    const v = imp ? imp(x, y) : 0;
    const u = 1 - (v > 1 ? 1 : v < 0 ? 0 : v);
    return (style.simplifyPx / 2) * u * u;
  });
  // Narrow water survives the generalization at a floor width, so a channel is
  // never dissolved. Uses the pre-opening grid to decide what counts as narrow.
  const narrowPts = minW > 0 && origGrid ? enforceMinWidth(raster, origGrid, minW, style.simplifyPx / 2) : [];
  // No created lakes: reconnect severed channels (or swallow whole bodies).
  // Corridor midpoints join the VW veto so simplification can't pinch them.
  const corridorPts = origGrid ? enforceContinuity(raster, origGrid, pieceOk, imp) : [];
  const unified = traceRaster(raster);
  // Canvas-edge pin: the geography's outer boundary at the canvas rim is the
  // DATA cutoff (the harvest region's edge), not a shape to stylize. When the
  // map is rotated into a bearing that cutoff crosses the canvas as an
  // off-axis diagonal. The octi snap quantizing it to 45° (and VW cutting its
  // corners) would swing the water's edge across the canvas, painting fake
  // land wedges in the water and paint past the canvas. Vertices in the rim
  // band are pinned hard in both passes; the band is invisible (the viewBox
  // ends at the canvas), so nothing octilinear is lost.
  const edgeM = cell * 2;
  const hullPts = style.hullPx;
  const hullNear = (x: number, y: number): boolean => {
    if (!hullPts || hullPts.length < 3) return false;
    const m2 = 6.25 * cell * cell; // within 2.5 cells of a hull edge
    const n = hullPts.length;
    for (let i = 0; i < n; i++) {
      const a = hullPts[i];
      const b = hullPts[(i + 1) % n];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const ll = ex * ex + ey * ey;
      let t = ll > 1e-12 ? ((x - a[0]) * ex + (y - a[1]) * ey) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (a[0] + t * ex);
      const dy = y - (a[1] + t * ey);
      if (dx * dx + dy * dy < m2) return true;
    }
    return false;
  };
  const pinned = (x: number, y: number): boolean =>
    x < edgeM || y < edgeM || x > extent.w - edgeM || y > extent.h - edgeM || hullNear(x, y);
  // VW protection factor >= 1 multiplying a vertex's effective significance:
  // (1 + PROTECT·imp)², capped (see PROTECT_MAX_VW). Pinned rim vertices are
  // effectively unremovable (straight-run vertices still merge: zero area).
  const protect = (x: number, y: number): number => {
    if (pinned(x, y)) return 1e9;
    if (!imp) return 1;
    const v = imp(x, y);
    const g = 1 + PROTECT * (v > 1 ? 1 : v < 0 ? 0 : v);
    return Math.min(PROTECT_MAX_VW, g * g);
  };
  // Cull floor, importance-aware: at imp 0 the full minArea floor (isolated
  // small blobs are noise); as the BEST importance along the ring rises the
  // floor falls off quadratically to a dust floor. Whatever the opening kept
  // in the dense core IS the landmark set, and a water system the opening
  // fragmented at its channels must not lose its pieces one by one to an area
  // test. One shore in the core keeps the body. The dust floor scales with the
  // tolerance ((0.6·tol)², so sub-landmark specks don't ride along) but is
  // CAPPED at a canvas-relative landmark size. Full importance must keep a
  // landmark-scale feature at EVERY slider position, or the strength slider
  // quietly erases the exact landmarks the field exists to protect.
  const sf = Math.min(extent.w, extent.h) / 2700;
  const dust = Math.max(9 * cell * cell, Math.min(0.36 * areaThresh, 2600 * sf * sf));
  const cullOk = (ring: readonly Pt[], areaAbs: number): boolean => {
    if (areaAbs >= style.minAreaPx2) return true;
    if (!imp) return false;
    let best = 0;
    for (const p of ring) {
      const v = imp(p[0], p[1]);
      if (v > best) best = v;
      if (best >= 1) break;
    }
    const u = 1 - (best > 1 ? 1 : best < 0 ? 0 : best);
    return areaAbs >= Math.max(dust, style.minAreaPx2 * u * u);
  };
  // Restored channels join the veto, or the vector pass undoes the raster restore.
  const avoid = corridorPts.length || narrowPts.length
    ? [...(style.dryPoints ?? []), ...corridorPts, ...narrowPts]
    : style.dryPoints;
  const finals: Pt[][] = [];
  for (const ring of unified) {
    const a = ringArea(ring);
    const aAbs = a < 0 ? -a : a;
    if (!cullOk(ring, aAbs)) continue;
    let r = simplifyVW(ring, areaThresh, 4, (p) => protect(p[0], p[1]), avoid);
    if (r.length < 3) continue;
    // a ring can shrivel below the cull floor once its wiggles are gone
    const a2 = ringArea(r);
    if (!cullOk(r, a2 < 0 ? -a2 : a2)) continue;
    // Anchor weight rides importance: dense-core shorelines (where stations
    // sit near the water) get an 8x pull to their true position, so the
    // octilinear solve reshapes them without MOVING them. Rim vertices (the
    // harvest-boundary cutoff) are pinned outright; see `pinned` above.
    // Long edges are SUBDIVIDED first: the solve's direction penalty grows
    // with edge length², so a single long off-axis edge rotates wholesale and
    // sweeps water across hundreds of px of land (or vice versa). Sub-vertices
    // anchor to the simplified line, so a long coast becomes an octilinear
    // STAIRCASE with deviation bounded by ~half the subdivision length.
    if (style.octi) {
      r = snapOcti(
        subdivideRing(r, 2.2 * style.simplifyPx),
        (p) => (pinned(p[0], p[1]) ? 1e9 : imp ? 8 * Math.min(1, Math.max(0, imp(p[0], p[1]))) : 0),
        0.9 * style.simplifyPx,
      );
    }
    if (r.length < 3) continue;
    finals.push(r);
  }
  // LAST, so nothing downstream can undo it: no dry point may end up inside.
  // The fillet pass still runs after and rounds a notch apex back toward the
  // water by ~0.35·radius, so that is baked into the clearance.
  if (style.dryPoints && style.dryPoints.length > 0) {
    repairDryPoints(finals, style.dryPoints, (style.dryMarginPx ?? 14) + style.roundPx * 0.35);
  }
  let d = '';
  for (const r of finals) d += filletPathD(r, style.roundPx);
  return d.trim();
}
