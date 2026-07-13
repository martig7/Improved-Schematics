/**
 * London interchange geometry. The lines that stop at a node are partitioned
 * into CLUSTERS, each of which fits under one white ticket-hall bubble: a lone
 * line, an adjacent same-direction pair, or a crossing of different-direction
 * lines (found with the same slide-to-intersection test in every case). The
 * partition is chosen by scoring every option -- fewer bubbles win, a pixel of
 * slide is a light cost, and two bubbles touching is near-infinite -- so a
 * crossing resolves to one dot, a wide bundle to a spread chain, and a tight
 * knot to a single dot, all from one solve. Bubbles are then joined by a minimum
 * spanning tree of connectors. Every bubble is the same size, large enough to
 * cover a wide diagonal pair. Design-agnostic geometry computed once at compute
 * time; the London design paints from it (no draw-time geometry).
 */

export interface LondonBubble { x: number; y: number; r: number }
export interface LondonNeck { x0: number; y0: number; x1: number; y1: number; w: number }
export interface LondonCapsule { bubbles: LondonBubble[]; necks: LondonNeck[] }

/** The mark fields the solve needs: bundle axis, position, mega flag. */
interface BubbleMark { axis?: number; pos: [number, number]; mega?: boolean }
/** A line to cover: unit run-axis direction, stop position, and axis key (-1 = none). */
interface Line { ux: number; uy: number; px: number; py: number; axisKey: number }

const R_FACTOR = 1.5;
const COVER_MARGIN = 0.5;   // half the stroke may poke past a covering bubble
const OVERLAP_COST = 1e6;   // base cost for a touching/overlapping pair of bubbles
const OVERLAP_SLOPE = 1e3;  // added per px a pair falls short of clearance
const SLIDE_WEIGHT = 1;     // cost per px a bubble slides from its cluster center
const BUBBLE_COST = 40;     // cost per bubble, so fewer (larger) clusters win
const NECK_GAP = 2;         // desired clear gap between bead edges
const TOUCH_TOL = 1;        // extra clearance demanded, so a bare graze still counts as touching
const CLUSTER_MAX = 3;      // most lines one bubble is allowed to cover
const NODE_MAX = 7;         // above this, skip the full search (rare mega crossings)
const SNAP_OCTI = true;     // snap connectors onto octilinear directions after placement
const S = 0.7071067811865476; // sqrt(1/2), a literal for cross-V8 byte-identity

/** Unit run-axis direction (0=-, 1=\, 2=|, 3=/); an absent axis is horizontal. */
function axisUnit(axis: number): [number, number] {
  switch (((axis % 4) + 4) % 4) {
    case 1: return [S, S];
    case 2: return [0, 1];
    case 3: return [-S, S];
    default: return [1, 0];
  }
}

/**
 * The point one bubble can slide to so it covers every given line, or null when
 * no single bubble suffices. Each line runs through its stop along its run-axis,
 * so a bubble covers it when the center is within `cover` of the line
 * PERPENDICULAR. Parallel lines share a normal; we center each such group
 * between its outermost lines (min-max), then intersect the two most-constrained
 * groups for the point, and accept it only when it covers every line and stays
 * within the footprint. Uses only arithmetic, so it is byte-identical across V8.
 */
function coverCenter(lines: Line[], cover: number, reach: number): { x: number; y: number } | null {
  const groups = new Map<string, { nx: number; ny: number; min: number; max: number }>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of lines) {
    const nx = -L.uy, ny = L.ux;
    const c = nx * L.px + ny * L.py;
    const key = nx + ',' + ny;
    const g = groups.get(key);
    if (g) { g.min = Math.min(g.min, c); g.max = Math.max(g.max, c); }
    else groups.set(key, { nx, ny, min: c, max: c });
    minX = Math.min(minX, L.px); maxX = Math.max(maxX, L.px);
    minY = Math.min(minY, L.py); maxY = Math.max(maxY, L.py);
  }
  const gs = [...groups.values()];
  for (const g of gs) if (g.max - g.min > 2 * cover + 1e-7) return null;
  gs.sort((a, b) => (b.max - b.min) - (a.max - a.min));
  const mid = (g: { min: number; max: number }) => (g.min + g.max) / 2;
  let x: number, y: number;
  if (gs.length === 1) {
    const g = gs[0];
    let sx = 0, sy = 0;
    for (const L of lines) { sx += L.px; sy += L.py; }
    const along = (sx / lines.length) * g.ny + (sy / lines.length) * -g.nx;
    x = mid(g) * g.nx + along * g.ny;
    y = mid(g) * g.ny + along * -g.nx;
  } else {
    const g1 = gs[0], g2 = gs[1];
    const det = g1.nx * g2.ny - g1.ny * g2.nx;
    if (Math.abs(det) < 1e-9) return null;
    const m1 = mid(g1), m2 = mid(g2);
    x = (m1 * g2.ny - g1.ny * m2) / det;
    y = (g1.nx * m2 - m1 * g2.nx) / det;
  }
  if (x < minX - reach || x > maxX + reach || y < minY - reach || y > maxY + reach) return null;
  for (const L of lines) {
    const perp = Math.abs(-L.uy * (x - L.px) + L.ux * (y - L.py));
    if (perp > cover + 1e-7) return null;
  }
  return { x, y };
}

const popcount = (m: number): number => { let c = 0; for (; m; m &= m - 1) c++; return c; };
const bitsOf = (m: number): number[] => { const o: number[] = []; for (let i = 0; m; i++, m >>= 1) if (m & 1) o.push(i); return o; };

interface Cluster { mask: number; cx: number; cy: number; axis: number; slide: number }

/** Every partition of the lines in `remaining` into the given coverable clusters. */
function partitionsInto(remaining: number, clusters: Cluster[]): Cluster[][] {
  if (remaining === 0) return [[]];
  const lowest = remaining & -remaining; // an uncovered line every part-list must start by covering
  const out: Cluster[][] = [];
  for (const cl of clusters) {
    if (!(cl.mask & lowest) || (cl.mask & remaining) !== cl.mask) continue;
    for (const rest of partitionsInto(remaining ^ cl.mask, clusters)) out.push([cl, ...rest]);
  }
  return out;
}

function overlapPen(ax: number, ay: number, bx: number, by: number, minSep: number): number {
  const dist = Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
  const shortfall = minSep - dist;
  return shortfall > 1e-7 ? OVERLAP_COST + shortfall * OVERLAP_SLOPE : 0;
}

/** Place one partition's bubbles: crossing (mixed-axis) clusters anchor at their
 *  center; a same-axis cluster slides along its run-axis to the position that
 *  best clears the already-placed bubbles for the least slide. */
function placePartition(part: Cluster[], r: number, minSep: number): Array<{ x: number; y: number; slide: number; axis: number }> {
  const STEP = r * 0.35, K = 10;
  const order = part.map((cl, i) => ({ cl, i }))
    .sort((a, b) => (a.cl.axis === -1 ? 0 : 1) - (b.cl.axis === -1 ? 0 : 1)
      || popcount(b.cl.mask) - popcount(a.cl.mask) || a.cl.mask - b.cl.mask);
  const placed: Array<{ x: number; y: number; slide: number; i: number; axis: number }> = [];
  for (const { cl, i } of order) {
    const cands: Array<{ x: number; y: number; slide: number }> = [];
    if (cl.axis === -1) cands.push({ x: cl.cx, y: cl.cy, slide: 0 });
    else {
      const [ux, uy] = axisUnit(cl.axis);
      for (let k = -K; k <= K; k++) cands.push({ x: cl.cx + k * STEP * ux, y: cl.cy + k * STEP * uy, slide: Math.abs(k * STEP) });
    }
    let best = cands[0], bestCost = Infinity;
    for (const cand of cands) {
      let cost = cand.slide * SLIDE_WEIGHT;
      for (const p of placed) cost += overlapPen(cand.x, cand.y, p.x, p.y, minSep);
      if (cost < bestCost) { bestCost = cost; best = cand; }
    }
    placed.push({ ...best, i, axis: cl.axis });
  }
  placed.sort((a, b) => a.i - b.i);
  return placed.map((p) => ({ x: p.x, y: p.y, slide: p.slide, axis: p.axis }));
}

/** Minimum spanning tree of the bubbles as parent->child edges, in Prim add
 *  order (so every parent precedes its children). Index-stable. */
function mstEdges(bubbles: LondonBubble[]): Array<[number, number]> {
  const n = bubbles.length;
  const edges: Array<[number, number]> = [];
  if (n <= 1) return edges;
  const inTree = new Array<boolean>(n).fill(false);
  inTree[0] = true;
  for (let added = 1; added < n; added++) {
    let bu = -1, bv = -1, bd = Infinity;
    for (let u = 0; u < n; u++) {
      if (!inTree[u]) continue;
      for (let v = 0; v < n; v++) {
        if (inTree[v]) continue;
        const d = Math.sqrt((bubbles[u].x - bubbles[v].x) ** 2 + (bubbles[u].y - bubbles[v].y) ** 2);
        if (d < bd) { bd = d; bu = u; bv = v; }
      }
    }
    inTree[bv] = true;
    edges.push([bu, bv]);
  }
  return edges;
}

const OCTI_DIRS: Array<[number, number]> = [[1, 0], [0, 1], [S, S], [-S, S]];

/** Constraint pass: walk the MST parent-first and slide each child along its
 *  run-axis so its connector to the (already-fixed) parent lands on the nearest
 *  octilinear direction, choosing the least slide that keeps every bubble clear.
 *  A fixed crossing cluster (axis < 0) has no freedom, so its connector is left
 *  as drawn. */
function snapOctilinear(bubbles: LondonBubble[], edges: Array<[number, number]>, axisOf: number[], twoR: number): void {
  const maxSlide = twoR;
  for (const [p, c] of edges) {
    if (axisOf[c] < 0) continue;
    const [ax, ay] = axisUnit(axisOf[c]);
    const vx0 = bubbles[c].x - bubbles[p].x, vy0 = bubbles[c].y - bubbles[p].y;
    let bestT: number | null = null, bestAbs = Infinity;
    for (const [dx, dy] of OCTI_DIRS) {
      const denom = ax * dy - ay * dx; // component of the run-axis across d
      if (Math.abs(denom) < 1e-9) continue;
      const t = -(vx0 * dy - vy0 * dx) / denom; // slide making (child - parent) parallel to d
      if (Math.abs(t) >= bestAbs || Math.abs(t) > maxSlide + 1e-9) continue;
      const nx = bubbles[c].x + t * ax, ny = bubbles[c].y + t * ay;
      let ok = true;
      for (let i = 0; i < bubbles.length; i++) {
        if (i === c) continue;
        if (Math.sqrt((nx - bubbles[i].x) ** 2 + (ny - bubbles[i].y) ** 2) < twoR - 1e-9) { ok = false; break; }
      }
      if (ok) { bestAbs = Math.abs(t); bestT = t; }
    }
    if (bestT !== null) { bubbles[c].x += bestT * ax; bubbles[c].y += bestT * ay; }
  }
}

/** Solve one node: the bubbles and connectors for its stopping lines. */
function solveNode(lines: Line[], r: number, cover: number, reach: number, minSep: number): LondonCapsule {
  // Whole-node single dot: one bubble slid to cover every line (a tight crossing
  // or knot of any size).
  const whole = coverCenter(lines, cover, reach);
  if (whole) return { bubbles: [{ x: whole.x, y: whole.y, r }], necks: [] };

  const N = lines.length;
  if (N > NODE_MAX) {
    // Rare mega crossing: fall back to one bubble per line so it still renders.
    const bubbles = lines.map((L) => ({ x: L.px, y: L.py, r }));
    return connect(bubbles, lines.map((L) => L.axisKey), r);
  }

  // Coverable clusters (a bubble covers at most CLUSTER_MAX lines).
  const clusters: Cluster[] = [];
  for (let mask = 1; mask < 1 << N; mask++) {
    if (popcount(mask) > CLUSTER_MAX) continue;
    const idxs = bitsOf(mask);
    const c = coverCenter(idxs.map((i) => lines[i]), cover, reach);
    if (!c) continue;
    let axis = lines[idxs[0]].axisKey;
    let slide = 0; // how far the covering center sits from the lines' stops, along each line
    for (const i of idxs) {
      const L = lines[i];
      if (L.axisKey !== axis) axis = -1;
      slide += Math.abs(L.ux * (c.x - L.px) + L.uy * (c.y - L.py));
    }
    clusters.push({ mask, cx: c.x, cy: c.y, axis, slide });
  }

  // Pick the partition (into clusters) of least cost: fewer bubbles, less slide,
  // no touching.
  let best: { cost: number; placed: ReturnType<typeof placePartition> } | null = null;
  for (const part of partitionsInto((1 << N) - 1, clusters)) {
    const placed = placePartition(part, r, minSep);
    let cost = part.length * BUBBLE_COST;
    for (const cl of part) cost += cl.slide * SLIDE_WEIGHT; // clusters near their stops are cheaper
    for (const p of placed) cost += p.slide * SLIDE_WEIGHT;
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      cost += overlapPen(placed[i].x, placed[i].y, placed[j].x, placed[j].y, minSep);
    }
    if (!best || cost < best.cost) best = { cost, placed };
  }
  const placed = best?.placed ?? lines.map((L) => ({ x: L.px, y: L.py, slide: 0, axis: L.axisKey }));
  const bubbles = placed.map((p) => ({ x: p.x, y: p.y, r }));
  return connect(bubbles, placed.map((p) => p.axis), r);
}

/** Join the bubbles with an MST, snapping each connector octilinear where the
 *  child bubble has the freedom to slide (leaving fixed crossing beads as drawn). */
function connect(bubbles: LondonBubble[], axisOf: number[], r: number): LondonCapsule {
  const edges = mstEdges(bubbles);
  if (SNAP_OCTI) snapOctilinear(bubbles, edges, axisOf, 2 * r);
  const necks = edges.map(([a, b]): LondonNeck => ({ x0: bubbles[a].x, y0: bubbles[a].y, x1: bubbles[b].x, y1: bubbles[b].y, w: r }));
  return { bubbles, necks };
}

/**
 * Per node: the interchange geometry. A node with one drawable (non-mega) mark
 * or none is skipped (its stop is a tick); a mega node is skipped too (it keeps
 * the opaque fallback box).
 */
export function computeLondonByNode(
  stops: Map<string, BubbleMark[]>,
  lineWidth: number,
): Map<string, LondonCapsule> {
  const out = new Map<string, LondonCapsule>();
  const r = lineWidth * R_FACTOR;
  const cover = r - (lineWidth / 2) * COVER_MARGIN;
  const reach = r * 4;
  const minSep = 2 * r + NECK_GAP + TOUCH_TOL;
  for (const [nodeId, marks] of stops) {
    const ms = marks.filter((m) => !m.mega);
    if (ms.length <= 1) continue;
    const lines: Line[] = ms.map((m) => {
      const key = m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4);
      const [ux, uy] = axisUnit(key === -1 ? 0 : key);
      return { ux, uy, px: m.pos[0], py: m.pos[1], axisKey: key };
    });
    out.set(nodeId, solveNode(lines, r, cover, reach, minSep));
  }
  return out;
}
