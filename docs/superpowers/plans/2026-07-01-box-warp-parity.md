# Box-Warp Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-map box warp resolve dense clusters like the detail-area popout does: discover boxes from predicted octi contraction (not just density peaks), size each box's expansion to what its edges need to survive contraction, and grow the output canvas to absorb the demand instead of clawing it back.

**Architecture:** All warp math lives in `src/render/layout/densityBoxWarp.ts` (new demand-driven builders replace `buildBoxExpandWarp`/`buildSepBoxWarp`); `renderGeographic.ts` feeds it the projected graph and consumes per-axis canvas growth; the cache fingerprint schema bumps; the panel slider mappings get new semantics. Spec: `docs/superpowers/specs/2026-07-01-box-warp-parity-design.md`.

**Tech Stack:** TypeScript, `tsx --test` (node:test + node:assert), no new dependencies. Determinism discipline: `+ − × ÷ √ min max` and fully tiebroken sorts only (cross-V8 bit-identical).

---

## Context for a zero-context engineer

- **Pipeline:** `precomputeSmoothed` (src/render/renderGeographic.ts:454) projects the transit graph to pixels (`baseProj`), applies a **warp** to pixel space, re-fits the warped content to the canvas, then runs topo-merge + octilinearization ("octi") on the warped positions. Octi **contracts** (collapses) any edge shorter than `cellSize/2`, where `cellSize = max(12, medianSupportEdgeLen / divisor)` (renderGeographic.ts:831) — this is what turns tight station clusters into unreadable "megaboxes".
- **Current box warp** (`densityBoxWarp.ts`): finds dense regions as axis-aligned boxes from a density grid (`findDenseBoxes`), expands each with a per-axis saturating push (a single global `expand` strength), then normalizes the growth back to ~the original canvas. The normalization + downstream refit confiscate most of the granted room.
- **The change:** boxes come from density **∪** predicted contraction; each box's expansion is computed from its own median node gap vs the contraction threshold; the canvas grows (up to `maxGrowth`) instead of shrinking the result back.
- **Run tests:** `npm test` (all) or `npx tsx --test src/render/layout/densityBoxWarp.test.ts` (one file). Typecheck: `npm run typecheck`.
- **`Pixel`** is `[number, number]` (`src/render/layout/types.ts`). **`WarpBox`**/**`WarpFn`**/**`DensityWarpOptions`** come from `densityWarp.ts`.

---

### Task 1: Contraction-oracle box discovery (`findContractionBoxes`)

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Append to `src/render/layout/densityBoxWarp.test.ts`:

```ts
test('findContractionBoxes: pinned sub-threshold cluster gets a box, spread nodes do not', () => {
  // 5 nodes 8px apart (JFK-shaped) + 3 well-spread nodes.
  const nodes: Pixel[] = [[50, 50], [58, 50], [66, 50], [58, 58], [50, 58], [200, 200], [400, 200], [400, 400]];
  const edges: [number, number][] = [[0, 1], [1, 2], [1, 3], [3, 4], [5, 6], [6, 7]];
  const boxes = findContractionBoxes({ nodes, edges }, 20);
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  // covers the cluster, padded by threshold/2 = 10px per side
  assert.ok(b.x0 <= 40 && b.x1 >= 76 && b.y0 <= 40 && b.y1 >= 68);
});

test('findContractionBoxes: no short edges → no boxes; isolated close nodes without an edge → no boxes', () => {
  const nodes: Pixel[] = [[0, 0], [100, 0], [5, 5]]; // node 2 is near node 0 but NOT connected
  const edges: [number, number][] = [[0, 1]];
  assert.deepEqual(findContractionBoxes({ nodes, edges }, 20), []);
});

test('findContractionBoxes: two separate clusters → two boxes', () => {
  const nodes: Pixel[] = [[10, 10], [15, 10], [300, 300], [305, 300]];
  const edges: [number, number][] = [[0, 1], [2, 3]];
  assert.equal(findContractionBoxes({ nodes, edges }, 20).length, 2);
});
```

Add `findContractionBoxes` and `BoxGraph` to the import from `./densityBoxWarp` at the top of the test file, and `Pixel` from `./types` if not present.

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npx tsx --test src/render/layout/densityBoxWarp.test.ts`
Expected: FAIL — `findContractionBoxes` is not exported.

- [ ] **Step 1.3: Implement**

Add to `src/render/layout/densityBoxWarp.ts` (after the `DenseBox` interface):

```ts
/** The projected transit graph, for the contraction oracle: node positions in
 *  the warp's INPUT pixel space plus edges as index pairs into `nodes`. */
export interface BoxGraph {
  nodes: readonly Pixel[];
  edges: readonly [number, number][];
}

const edgeLen = (g: BoxGraph, a: number, b: number): number => {
  const dx = g.nodes[a][0] - g.nodes[b][0];
  const dy = g.nodes[a][1] - g.nodes[b][1];
  return Math.sqrt(dx * dx + dy * dy); // sqrt is correctly-rounded (cross-V8 safe)
};

/** Median projected edge length (0 when the graph has no edges). */
export function medianEdgeLenPx(g: BoxGraph): number {
  const ls = g.edges.map(([a, b]) => edgeLen(g, a, b)).sort((x, y) => x - y);
  return ls.length ? ls[ls.length >> 1] : 0;
}

/** Mean incident-edge length per node (Infinity for isolated nodes) — the same
 *  "neighbour gap" statistic renderGeographic uses for warp weights. */
function nodeGaps(g: BoxGraph): number[] {
  const sum = new Float64Array(g.nodes.length);
  const cnt = new Float64Array(g.nodes.length);
  for (const [a, b] of g.edges) {
    const l = edgeLen(g, a, b);
    sum[a] += l; cnt[a]++;
    sum[b] += l; cnt[b]++;
  }
  return [...sum].map((s, i) => (cnt[i] ? s / cnt[i] : Infinity));
}

/** Contraction oracle: cluster nodes joined by edges shorter than `threshold`
 *  (the predicted octi contraction length ĉ/2 × safety) via union-find, and
 *  bound each cluster of >= 2 nodes, padded by threshold/2 per side so the
 *  expansion push has extent even for collinear pairs. Catches small pinned
 *  clusters (JFK's 8px terminals) that are invisible to fraction-of-peak
 *  density. Deterministic: plain array iteration + arithmetic. */
export function findContractionBoxes(g: BoxGraph, threshold: number): DenseBox[] {
  const parent = g.nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const touched = new Uint8Array(g.nodes.length);
  for (const [a, b] of g.edges) {
    if (edgeLen(g, a, b) >= threshold) continue;
    touched[a] = 1;
    touched[b] = 1;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }
  const byRoot = new Map<number, DenseBox & { n: number }>();
  for (let i = 0; i < g.nodes.length; i++) {
    if (!touched[i]) continue;
    const r = find(i);
    const p = g.nodes[i];
    const cur = byRoot.get(r);
    if (!cur) byRoot.set(r, { x0: p[0], y0: p[1], x1: p[0], y1: p[1], n: 1 });
    else {
      if (p[0] < cur.x0) cur.x0 = p[0];
      if (p[0] > cur.x1) cur.x1 = p[0];
      if (p[1] < cur.y0) cur.y0 = p[1];
      if (p[1] > cur.y1) cur.y1 = p[1];
      cur.n++;
    }
  }
  const pad = threshold / 2;
  const boxes: DenseBox[] = [];
  for (const b of byRoot.values()) {
    if (b.n < 2) continue;
    boxes.push({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad });
  }
  return boxes;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `npx tsx --test src/render/layout/densityBoxWarp.test.ts`
Expected: the three new tests PASS (pre-existing tests untouched).

- [ ] **Step 1.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): contraction-oracle box discovery (findContractionBoxes)"
```

---

### Task 2: `mergeIntersectingBoxes`

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 2.1: Write the failing tests**

```ts
test('mergeIntersectingBoxes: overlapping chain collapses to one bbox; disjoint boxes survive', () => {
  const merged = mergeIntersectingBoxes([
    { x0: 0, y0: 0, x1: 10, y1: 10 },
    { x0: 8, y0: 8, x1: 20, y1: 20 },   // overlaps #0
    { x0: 18, y0: 18, x1: 30, y1: 30 }, // overlaps #1 only AFTER #0+#1 merge
    { x0: 100, y0: 100, x1: 110, y1: 110 },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { x0: 0, y0: 0, x1: 30, y1: 30 });
  assert.deepEqual(merged[1], { x0: 100, y0: 100, x1: 110, y1: 110 });
});

test('mergeIntersectingBoxes: empty and singleton inputs pass through', () => {
  assert.deepEqual(mergeIntersectingBoxes([]), []);
  assert.deepEqual(mergeIntersectingBoxes([{ x0: 1, y0: 2, x1: 3, y1: 4 }]), [{ x0: 1, y0: 2, x1: 3, y1: 4 }]);
});
```

- [ ] **Step 2.2: Run to verify FAIL** (`mergeIntersectingBoxes` not exported).

- [ ] **Step 2.3: Implement**

```ts
/** Merge intersecting boxes to their union bbox, repeated to a fixpoint, so the
 *  summed per-axis pushes never double-stack on overlapping regions (density
 *  boxes and contraction boxes can overlap). Deterministic: fixed scan order. */
export function mergeIntersectingBoxes(boxes: DenseBox[]): DenseBox[] {
  const out = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          out[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          };
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  return out;
}
```

- [ ] **Step 2.4: Run to verify PASS.**

- [ ] **Step 2.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): merge intersecting warp boxes to a fixpoint"
```

---

### Task 3: Demand-driven warp builder (`buildDemandBoxWarp`) with canvas growth

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

This is the core: per-box expansion strengths + growth-instead-of-clawback. The refinement iteration is Task 4 (this task builds single-pass).

- [ ] **Step 3.1: Write the failing tests**

```ts
// Helper: a JFK-shaped pinned cluster (gaps ~8px) connected off to a sparse line.
function pinnedGraph(): BoxGraph {
  const nodes: Pixel[] = [
    [50, 50], [58, 50], [66, 50], [58, 58], [50, 58], // cluster
    [30, 30], [150, 150], [300, 300], [450, 450],     // sparse chain
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [1, 3], [3, 4], // cluster edges (~8px)
    [0, 5], [2, 6], [6, 7], [7, 8], // outbound + sparse (>100px)
  ];
  return { nodes, edges };
}
const DOPTS = {
  bins: 48, frac: 0.4, marginFrac: 1,
  cellFromMedLen: (m: number) => Math.max(12, m / 1.6),
  safety: 1.3, slack: 1.3, userMult: 1, expandMax: 10, maxGrowth: 8,
};

test('buildDemandBoxWarp: demanded expansion lifts a pinned cluster past the contraction need', () => {
  const g = pinnedGraph();
  const r = buildDemandBoxWarp([], g, BOX, DOPTS); // no density samples: contraction oracle only
  const medLen = medianEdgeLenPx(g);
  const need = (DOPTS.cellFromMedLen(medLen) / 2) * DOPTS.slack;
  // every formerly-short cluster edge comes out >= need
  for (const [a, b] of [[0, 1], [1, 2], [1, 3], [3, 4]] as [number, number][]) {
    const pa = r.warp(g.nodes[a]);
    const pb = r.warp(g.nodes[b]);
    const d = Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2);
    assert.ok(d >= need, `edge ${a}-${b}: ${d.toFixed(1)} < need ${need.toFixed(1)}`);
  }
});

test('buildDemandBoxWarp: growth is real (canvas grows, no claw-back) and capped by maxGrowth', () => {
  const g = pinnedGraph();
  const free = buildDemandBoxWarp([], g, BOX, { ...DOPTS, maxGrowth: 8 });
  assert.ok(free.growthX >= 1 && free.growthY >= 1);
  // warped canvas corners span growth × canvas exactly
  const tl = free.warp([BOX.minX, BOX.minY]);
  const br = free.warp([BOX.maxX, BOX.maxY]);
  assert.ok(Math.abs((br[0] - tl[0]) - (BOX.maxX - BOX.minX) * free.growthX) < 1e-6);
  assert.ok(Math.abs((br[1] - tl[1]) - (BOX.maxY - BOX.minY) * free.growthY) < 1e-6);
  // capping: maxGrowth 1 → canvas-preserving, and the cap shrinks the result globally
  const capped = buildDemandBoxWarp([], g, BOX, { ...DOPTS, maxGrowth: 1 });
  assert.equal(capped.growthX, 1);
  assert.equal(capped.growthY, 1);
});

test('buildDemandBoxWarp: no short edges + no density boxes → identity, growth 1', () => {
  const g: BoxGraph = { nodes: [[10, 10], [500, 500]], edges: [[0, 1]] };
  const r = buildDemandBoxWarp([], g, BOX, DOPTS);
  assert.deepEqual(r.warp([123, 456]), [123, 456]);
  assert.equal(r.growthX, 1);
  assert.equal(r.growthY, 1);
});

test('buildDemandBoxWarp: userMult magnifies an already-clear density box aesthetically', () => {
  // dense SAMPLES cluster whose EDGES already clear the threshold: survival demand ~1.
  const g: BoxGraph = { nodes: [[45, 45], [55, 55], [200, 200]], edges: [[0, 1], [1, 2]] };
  const samples = clusterAt(50, 50, 200);
  const base = buildDemandBoxWarp(samples, g, BOX, { ...DOPTS, cellFromMedLen: () => 12, userMult: 1 });
  const boosted = buildDemandBoxWarp(samples, g, BOX, { ...DOPTS, cellFromMedLen: () => 12, userMult: 2 });
  // userMult 2 grows the box's span more than userMult 1
  const span = (r: { warp: WarpFn }) => r.warp([60, 60])[0] - r.warp([40, 40])[0];
  assert.ok(span(boosted) > span(base));
});

test('buildDemandBoxWarp: deterministic; out reports boxes (output space) and per-box expands', () => {
  const g = pinnedGraph();
  const o1: { boxes?: DenseBox[]; expands?: number[] } = {};
  const o2: { boxes?: DenseBox[]; expands?: number[] } = {};
  const r1 = buildDemandBoxWarp([], g, BOX, DOPTS, o1);
  const r2 = buildDemandBoxWarp([], g, BOX, DOPTS, o2);
  assert.deepEqual(r1.warp([77, 88]), r2.warp([77, 88]));
  assert.deepEqual(o1.boxes, o2.boxes);
  assert.deepEqual(o1.expands, o2.expands);
  assert.equal(o1.boxes!.length, o1.expands!.length);
  assert.ok(o1.expands!.every((e) => e >= 1));
  // the cluster's box in OUTPUT space contains the warped cluster nodes
  const p = r1.warp([58, 54]);
  assert.ok(o1.boxes!.some((b) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1));
});
```

(`BOX` and `clusterAt` already exist at the top of the test file — `BOX` is `{ minX: 0, minY: 0, maxX: 100, maxY: 100 }`-style; **check the actual values at the top of densityBoxWarp.test.ts and, if BOX is 100×100, change `pinnedGraph`'s sparse chain to fit inside it, e.g. `[30,30],[80,80],[90,20],[20,90]` with the same edge topology — the invariants tested don't depend on the exact sparse positions.**)

- [ ] **Step 3.2: Run to verify FAIL** (`buildDemandBoxWarp` not exported).

- [ ] **Step 3.3: Implement**

Add to `densityBoxWarp.ts`:

```ts
export interface DemandOptions extends DensityWarp2DOptionsLike {
  /** Density-oracle cutoff (fraction of peak), as findDenseBoxes. Default 0.4. */
  frac?: number;
  /** Saturation margin as a fraction of box half-extent (as before). Default 1. */
  marginFrac?: number;
  /** Derive the octi cellSize estimate ĉ from a median edge length — supplied by
   *  the caller so the divisor regime matches the real layout. */
  cellFromMedLen: (medLenPx: number) => number;
  /** Safety factor on the contraction threshold ĉ/2 (ĉ is an estimate). Default 1.3. */
  safety?: number;
  /** Headroom above bare survival for the demand target. Default 1.3. */
  slack?: number;
  /** User aesthetic multiplier on every box's demand (Box warp slider). Default 1. */
  userMult?: number;
  /** Per-box expansion ceiling. Default 10. */
  expandMax?: number;
  /** Max per-axis canvas growth; demand beyond it shrinks globally. Default 2. */
  maxGrowth?: number;
}

export interface DemandWarpResult {
  warp: WarpFn;
  /** Capped per-axis canvas growth (>= 1): the output canvas is growth × input canvas. */
  growthX: number;
  growthY: number;
}

/** Per-box demand: the expansion that lifts the box's median node gap to the
 *  demand target `need` (= ĉ/2 · slack), times the user's aesthetic multiplier.
 *  A box whose gaps already clear the target gets ~userMult (aesthetics only). */
function boxDemand(
  b: DenseBox,
  nodes: readonly Pixel[],
  gaps: readonly number[],
  need: number,
  userMult: number,
  expandMax: number,
): number {
  const inside: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && Number.isFinite(gaps[i]) && gaps[i] > 0)
      inside.push(gaps[i]);
  }
  if (inside.length === 0) return Math.min(expandMax, Math.max(1, userMult));
  inside.sort((x, y) => x - y);
  const gMed = inside[inside.length >> 1];
  return Math.min(expandMax, Math.max(1, userMult * Math.max(1, need / gMed)));
}

/** Build the per-axis saturating push warp for `boxes` with PER-BOX strengths,
 *  growing the canvas by min(raw growth, maxGrowth) per axis instead of
 *  normalizing back to the input canvas. Top-left anchored: [minX..maxX] maps
 *  to [minX .. minX + W·growthX] (the caller's content refit re-frames anyway). */
function buildWarpFromBoxes(
  boxes: DenseBox[],
  strengths: readonly number[], // expand_b - 1, per box
  box: WarpBox,
  marginFrac: number,
  maxGrowth: number,
  out?: { boxes?: DenseBox[] },
): DemandWarpResult {
  const identity: WarpFn = (p) => [p[0], p[1]];
  if (boxes.length === 0 || strengths.every((s) => s === 0)) {
    if (out) out.boxes = boxes.map((b) => ({ ...b }));
    return { warp: identity, growthX: 1, growthY: 1 };
  }
  const bs = boxes.map((b, i) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const hx = (b.x1 - b.x0) / 2;
    const hy = (b.y1 - b.y0) / 2;
    const m = Math.max(1, marginFrac * Math.max(hx, hy));
    return { cx, cy, hx, hy, m, s: strengths[i] };
  });
  // Same smooth saturating odd-symmetric push as before (slope in [0,1] ⇒ each
  // s·push term is monotone ⇒ the sum is monotone per axis ⇒ fold-free, det >= 1).
  const push = (t: number, h: number, m: number): number => {
    const a = t < 0 ? -t : t;
    let p: number;
    if (a <= h) p = a;
    else if (a <= h + m) { const u = a - h; p = a - (u * u) / (2 * m); }
    else p = h + m / 2;
    return t < 0 ? -p : p;
  };
  const raw = (px: number, py: number): Pixel => {
    let ux = 0;
    let uy = 0;
    for (const b of bs) {
      ux += b.s * push(px - b.cx, b.hx, b.m);
      uy += b.s * push(py - b.cy, b.hy, b.m);
    }
    return [px + ux, py + uy];
  };
  // Growth instead of claw-back: the raw push only expands (monotone, det >= 1),
  // so the warped canvas corners give the raw growth; cap per axis at maxGrowth.
  // sx = 1 while demand fits (rooms is REAL); < 1 only past the cap (global,
  // even shrink — never a ring).
  const xl = raw(box.minX, box.minY)[0];
  const xr = raw(box.maxX, box.minY)[0];
  const yt = raw(box.minX, box.minY)[1];
  const yb = raw(box.minX, box.maxY)[1];
  const W = box.maxX - box.minX;
  const H = box.maxY - box.minY;
  const rawGx = (xr - xl) / W;
  const rawGy = (yb - yt) / H;
  const growthX = Math.min(rawGx, maxGrowth);
  const growthY = Math.min(rawGy, maxGrowth);
  const sx = growthX / rawGx;
  const sy = growthY / rawGy;
  const warp: WarpFn = (p) => {
    const q = raw(p[0], p[1]);
    return [box.minX + (q[0] - xl) * sx, box.minY + (q[1] - yt) * sy];
  };
  if (out) {
    out.boxes = boxes.map((b) => {
      const a = warp([b.x0, b.y0]);
      const c = warp([b.x1, b.y1]);
      return { x0: a[0], y0: a[1], x1: c[0], y1: c[1] };
    });
  }
  return { warp, growthX, growthY };
}

/** Demand-driven dense-box warp: boxes from density peaks ∪ predicted octi
 *  contraction, each expanded by exactly what its edges need to survive
 *  contraction (× userMult), growth absorbed by the canvas up to maxGrowth. */
export function buildDemandBoxWarp(
  samples: readonly Pixel[],
  g: BoxGraph,
  box: WarpBox,
  opts: DemandOptions,
  out?: { boxes?: DenseBox[]; expands?: number[] },
): DemandWarpResult {
  const safety = opts.safety ?? 1.3;
  const slack = opts.slack ?? 1.3;
  const userMult = opts.userMult ?? 1;
  const expandMax = opts.expandMax ?? 10;
  const maxGrowth = opts.maxGrowth ?? 2;
  const marginFrac = opts.marginFrac ?? 1;

  const medLen = medianEdgeLenPx(g);
  const cell = opts.cellFromMedLen(medLen);
  const density = samples.length ? findDenseBoxes(samples, box, opts) : [];
  const contraction = findContractionBoxes(g, (cell / 2) * safety);
  const boxes = mergeIntersectingBoxes([...density, ...contraction]);
  if (boxes.length === 0) {
    if (out) { out.boxes = []; out.expands = []; }
    return { warp: (p) => [p[0], p[1]], growthX: 1, growthY: 1 };
  }

  const gaps = nodeGaps(g);
  const need = (cell / 2) * slack;
  const expands = boxes.map((b) => boxDemand(b, g.nodes, gaps, need, userMult, expandMax));
  const result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, out);
  if (out) out.expands = expands;

  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_WARP_DEBUG) {
    const ex = expands.map((e) => e.toFixed(2)).join(',');
    console.error(
      `[boxwarp] boxes=${boxes.length} (density=${density.length} contraction=${contraction.length}) ` +
      `cell=${cell.toFixed(1)} need=${need.toFixed(1)} expands=[${ex}] growth=${result.growthX.toFixed(2)},${result.growthY.toFixed(2)} (cap=${maxGrowth})`,
    );
  }
  return result;
}
```

Note: `findDenseBoxes` and the `DensityWarp2DOptionsLike` alias already exist in this file — reuse them, do not duplicate.

- [ ] **Step 3.4: Run to verify PASS**

Run: `npx tsx --test src/render/layout/densityBoxWarp.test.ts`
Expected: all new tests PASS. Pre-existing `buildBoxExpandWarp` tests still pass (old builders untouched so far).

- [ ] **Step 3.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): demand-driven box warp with per-box expansion + canvas growth"
```

---

### Task 4: Refinement iteration (moving-target correction)

Expansion raises the global median edge length → the real post-warp cellSize rises → first-pass demands can undershoot. One bounded second pass fixes it.

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 4.1: Write the failing test**

```ts
test('buildDemandBoxWarp: refinement — post-warp gaps in every box clear the RE-DERIVED need', () => {
  const g = pinnedGraph();
  const opts = { ...DOPTS, maxGrowth: 8 };
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  const r = buildDemandBoxWarp([], g, BOX, opts, o);
  // Advect the graph through the FINAL warp and re-derive the threshold the way
  // the builder does; every box's median inside-gap must clear it.
  const warped: BoxGraph = { nodes: g.nodes.map((p) => r.warp([p[0], p[1]])), edges: g.edges };
  const needAfter = (opts.cellFromMedLen(medianEdgeLenPx(warped)) / 2) * opts.slack;
  for (const b of o.boxes!) {
    const gapsIn: number[] = [];
    for (const [a, c] of warped.edges) {
      const pa = warped.nodes[a], pc = warped.nodes[c];
      const inA = pa[0] >= b.x0 && pa[0] <= b.x1 && pa[1] >= b.y0 && pa[1] <= b.y1;
      const inC = pc[0] >= b.x0 && pc[0] <= b.x1 && pc[1] >= b.y0 && pc[1] <= b.y1;
      if (inA && inC) gapsIn.push(Math.sqrt((pa[0] - pc[0]) ** 2 + (pa[1] - pc[1]) ** 2));
    }
    if (!gapsIn.length) continue;
    gapsIn.sort((x, y) => x - y);
    assert.ok(gapsIn[gapsIn.length >> 1] >= needAfter, `box median gap ${gapsIn[gapsIn.length >> 1]} < ${needAfter}`);
  }
});
```

- [ ] **Step 4.2: Run to verify it fails** (it may pass already on this input if slack absorbs the shift — if it passes, tighten `slack` to 1.0 **in the test's opts only** to expose the moving target, verify it fails, then continue).

- [ ] **Step 4.3: Implement the second pass**

In `buildDemandBoxWarp`, replace the single `buildWarpFromBoxes(...)` call + return with:

```ts
  let expands = boxes.map((b) => boxDemand(b, g.nodes, gaps, need, userMult, expandMax));
  let result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, out);

  // One refinement pass: advect the graph through the first warp, re-derive the
  // (now larger) threshold from the post-warp median edge length, and bump any
  // box whose achieved median gap still falls short. Bounded at ONE extra pass —
  // deterministic, and slack absorbs the residual.
  {
    const advected: BoxGraph = { nodes: g.nodes.map((p) => result.warp([p[0], p[1]]) as Pixel), edges: g.edges };
    const needAfter = (opts.cellFromMedLen(medianEdgeLenPx(advected)) / 2) * slack;
    const gapsAfter = nodeGaps(advected);
    let bumped = false;
    const expands2 = boxes.map((b, i) => {
      const outB = out?.boxes?.[i];
      if (!outB) return expands[i];
      const achieved = boxDemand(outB, advected.nodes, gapsAfter, needAfter, 1, expandMax);
      // achieved > 1 means the box STILL demands more (its post-warp median gap
      // is under needAfter); scale the first-pass expand by the shortfall.
      if (achieved <= 1) return expands[i];
      bumped = true;
      return Math.min(expandMax, expands[i] * achieved);
    });
    if (bumped) {
      expands = expands2;
      result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, out);
    }
  }
  if (out) out.expands = expands;
```

(The `out.boxes` from the first `buildWarpFromBoxes` call are consumed for the shortfall measurement, then overwritten by the second call — final `out.boxes` are always in the FINAL warp's output space.)

Note: this requires `out` to exist for the refinement measurement. Make the function allocate a local `const oref: { boxes?: DenseBox[] } = out ?? {}` and pass `oref` to both `buildWarpFromBoxes` calls, so refinement works even when the caller passed no `out`.

- [ ] **Step 4.4: Run to verify PASS** (restore `slack: 1.3` in test opts if changed; the invariant test from 4.1 must pass at both slack values).

- [ ] **Step 4.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): one-pass demand refinement against the post-warp threshold"
```

---

### Task 5: Separable composition (`buildSepDemandBoxWarp`)

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 5.1: Write the failing test**

```ts
test('buildSepDemandBoxWarp: composes separable + demand warp; growth passes through', () => {
  const g = pinnedGraph();
  const s = clusterAt(58, 54, 200);
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  const r = buildSepDemandBoxWarp(s, g, BOX, { alpha: 0.8, minScale: 1 }, { ...DOPTS, maxGrowth: 8 }, o);
  assert.ok(r.growthX >= 1 && r.growthY >= 1);
  assert.ok(o.boxes!.length >= 1);
  // deterministic
  const r2 = buildSepDemandBoxWarp(s, g, BOX, { alpha: 0.8, minScale: 1 }, { ...DOPTS, maxGrowth: 8 });
  assert.deepEqual(r.warp([61, 47]), r2.warp([61, 47]));
});
```

- [ ] **Step 5.2: Run to verify FAIL.**

- [ ] **Step 5.3: Implement**

```ts
/** Separable warp (global magnification) composed with the demand-driven box
 *  warp (local rectilinear room). Boxes are found — and demands measured — in
 *  SEPARABLE-WARPED space, so both the samples and the graph advect through
 *  `sep` first. Composition of fold-free maps is fold-free; growth comes only
 *  from the box layer (the separable CDF maps the canvas onto itself). */
export function buildSepDemandBoxWarp(
  samples: readonly Pixel[],
  g: BoxGraph,
  box: WarpBox,
  sepOpts: DensityWarpOptions,
  boxOpts: DemandOptions,
  out?: { boxes?: DenseBox[]; expands?: number[] },
): DemandWarpResult {
  const sep = buildDensityWarp(samples, box, sepOpts);
  const warpedSamples = samples.map((s) => sep([s[0], s[1]]) as Pixel);
  const warpedGraph: BoxGraph = { nodes: g.nodes.map((p) => sep([p[0], p[1]]) as Pixel), edges: g.edges };
  const bx = buildDemandBoxWarp(warpedSamples, warpedGraph, box, boxOpts, out);
  return { warp: (p) => bx.warp(sep(p)), growthX: bx.growthX, growthY: bx.growthY };
}
```

- [ ] **Step 5.4: Run to verify PASS.**

- [ ] **Step 5.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): separable + demand-box warp composition"
```

---

### Task 6: Wire into `renderGeographic.ts` (graph input, knobs, canvas growth)

**Files:**
- Modify: `src/render/renderGeographic.ts` (warp knob block ~549-676, refit block ~692-728, `__warpDebug` ~770, return ~1009)

- [ ] **Step 6.1: Update the knob block**

Replace the `boxExpand` / `boxGrowth` reader IIFEs (renderGeographic.ts:575-587) with demand-semantics versions (same option/env NAMES — the panel and fingerprint fields don't change):

```ts
  // boxExpand is now the demand MULTIPLIER (userMult): 1 = expand each box by
  // exactly what its edges need to survive octi contraction; >1 adds aesthetic
  // magnification on top. (Was: absolute expansion factor, default 4.)
  const boxUserMult = (() => {
    const e = envNum('OCTI_BOX_EXPAND');
    if (Number.isFinite(e) && e > 0) return e; // dev sweep override wins
    if (typeof opts.boxExpand === 'number' && Number.isFinite(opts.boxExpand) && opts.boxExpand > 0) return opts.boxExpand;
    return 1;
  })();
  const boxMargin = Number.isFinite(envNum('OCTI_BOX_MARGIN')) && envNum('OCTI_BOX_MARGIN') > 0 ? envNum('OCTI_BOX_MARGIN') : 3;
  // boxGrowth is now the MAX per-axis canvas growth that absorbs the demanded
  // expansion (2 = output canvas may be up to 2x the base canvas; demand past
  // the cap shrinks globally). (Was: growthCap with claw-back, default 1.2.)
  const boxMaxGrowth = (() => {
    const gv = envNum('OCTI_BOX_GROWTH');
    if (Number.isFinite(gv) && gv >= 1) return gv; // dev sweep override wins
    if (typeof opts.boxGrowth === 'number' && Number.isFinite(opts.boxGrowth) && opts.boxGrowth >= 1) return opts.boxGrowth;
    return 2;
  })();
```

Also update the mode comment block above (renderGeographic.ts:549-560) to describe the demand semantics.

- [ ] **Step 6.2: Build the `BoxGraph` and swap the warp construction**

After the `warpSamples` loop (renderGeographic.ts:641-661) — which already computed `nodePos` and `edgeById` — add:

```ts
  // Demand inputs for the box warp: the projected graph as index-pair edges.
  // Node order = graph.nodes insertion order (already id-canonicalized upstream).
  const nodeIds = [...graph.nodes.keys()];
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const boxGraph: BoxGraph = {
    nodes: nodeIds.map((id) => nodePos.get(id)!),
    edges: graph.edges
      .map((e) => [nodeIndex.get(e.from), nodeIndex.get(e.to)] as [number | undefined, number | undefined])
      .filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined),
  };
  // ĉ estimate for the contraction oracle: mirrors the real post-warp
  // cellSize = max(12, medianSupportEdgeLen / divisor). graph edge count is a
  // PROXY for the support edge count (topo merge hasn't run yet) — the demand
  // safety factor covers the regime mismatch.
  const divisorEst = graph.edges.length > 800 ? 1.2 : 1.6;
  const cellFromMedLen = (m: number) => Math.max(12, m / divisorEst);
```

Replace the `boxOpts` line and the warp selection (renderGeographic.ts:663-676) with:

```ts
  const warpBox = { minX: 0, minY: 0, maxX: width, maxY: height };
  const boxOpts = {
    frac: boxFrac,
    marginFrac: boxMargin,
    userMult: boxUserMult,
    maxGrowth: boxMaxGrowth,
    cellFromMedLen,
  };
  const sepOpts = { alpha: warpAlpha, maxScale: warpMaxScale, minScale: warpMinScale };
  const warpOut: { boxes?: DenseBox[]; expands?: number[] } = {};
  // Per-axis canvas growth granted by the demand warp (1,1 for non-box modes).
  let warpGrowth: [number, number] = [1, 1];
  const warp = (() => {
    if (warpMode === 'separable') return buildDensityWarp(warpSamples, warpBox, sepOpts);
    if (warpMode === '2d')
      return buildDensityWarp2D(warpSamples, warpBox, { alpha: warpAlpha, sigmaPx: warpSigmaPx, iterations: warpIters });
    const r =
      warpMode === 'box'
        ? buildDemandBoxWarp(warpSamples, boxGraph, warpBox, boxOpts, warpOut)
        : buildSepDemandBoxWarp(warpSamples, boxGraph, warpBox, sepOpts, boxOpts, warpOut); // default 'both'
    warpGrowth = [r.growthX, r.growthY];
    return r.warp;
  })();
  // The REAL output canvas: base canvas × granted growth. Everything downstream
  // (refit target, land base, viewBox, export frame, pre.width/height) uses the
  // grown dims, so the demanded room is kept instead of clawed back.
  const outW = Math.round(width * warpGrowth[0]);
  const outH = Math.round(height * warpGrowth[1]);
```

Update imports at renderGeographic.ts:19 to `{ buildDemandBoxWarp, buildSepDemandBoxWarp, type BoxGraph, type DenseBox }`.

- [ ] **Step 6.3: Refit + return use the grown canvas**

In the refit block (renderGeographic.ts:711-719), replace `width`/`height` with the grown dims:

```ts
      const sx = (outW * (1 - 2 * m)) / (mxX - mnX);
      const sy = (outH * (1 - 2 * m)) / (mxY - mnY);
      const ox = outW * m - mnX * sx;
      const oy = outH * m - mnY * sy;
```

In the `__warpDebug` assignment (renderGeographic.ts:770), pass `width: outW, height: outH`.

In the return statement (renderGeographic.ts:1009), return `width: outW, height: outH` instead of `width, height`.

Then search the function body between the refit block and the return for any other use of the bare `width`/`height` that means "output canvas" (e.g. viewBox/frame construction) — `warpBox` and everything BEFORE the warp stays on the base `width`/`height`; everything sized to the output canvas uses `outW`/`outH`. Run: `npx tsx --test "src/**/*.test.ts"` and `npm run typecheck`.

- [ ] **Step 6.4: Sanity-run a real render**

Run: `OCTI_WARP_DEBUG=1 npx tsx dev/render-from-dump.ts 2>&1 | head -40` (uses the default in-game dump path; if it's missing on this machine, skip — Task 10 does the visual pass).
Expected: `[boxwarp] boxes=… (density=… contraction=…) … growth=…` line; render completes; no exceptions.

- [ ] **Step 6.5: Commit**

```bash
git add src/render/renderGeographic.ts
git commit -m "feat(render): wire demand-driven box warp — graph oracle input + canvas growth"
```

---

### Task 7: Delete the old builders, migrate their remaining test coverage

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts` (remove `buildBoxExpandWarp`, `buildSepBoxWarp`, and the now-unused `expand`/`growthCap` fields of `BoxWarpOptions`)
- Modify: `src/render/layout/densityBoxWarp.test.ts` (rewrite old-builder tests against the new API)

- [ ] **Step 7.1: Confirm no other importers**

Run: `grep -rn "buildBoxExpandWarp\|buildSepBoxWarp" src dev --include=*.ts --include=*.tsx`
Expected: only `densityBoxWarp.ts` (definitions) and `densityBoxWarp.test.ts`. If a dev script imports them, port it to `buildDemandBoxWarp` in this task (same argument shapes plus a `BoxGraph`; a dev script with no graph can pass `{ nodes: [], edges: [] }` and `cellFromMedLen: () => 12`).

- [ ] **Step 7.2: Rewrite the old tests to preserve their coverage under the new API**

Old test → new form:
- "magnifies the core relative to its surround, no localized thinning" → same assertion via `buildDemandBoxWarp(clusterAt(50,50,160), emptyish graph, …, userMult: 4, cellFromMedLen: () => 12)`: interior span grows more than an equal-width far-field span; no interval anywhere shrinks below `sx` (the global scale, which is 1 when growth fits).
- "bounded — fits growthCap, no blowup" → replaced by Task 3's growth-cap test (delete the old one).
- "deterministic; expand=1 or no samples → identity" → `userMult=1` + gaps clearing threshold → identity; keep the empty-input identity assertion via `buildDemandBoxWarp([], {nodes: [], edges: []}, BOX, DOPTS)`.
- "out.boxes in warp-OUTPUT space" → covered by Task 3's determinism/out test (delete the old one).
- "buildSepBoxWarp composes…" → covered by Task 5 (delete the old one).

Delete `buildBoxExpandWarp`, `buildSepBoxWarp`, and the `expand`/`growthCap` option fields; keep `findDenseBoxes`, `BoxWarpOptions`'s surviving fields (`frac`, `marginFrac`) folded into `DemandOptions` if simpler — the exported names `findDenseBoxes`, `DenseBox`, `BoxGraph`, `DemandOptions`, `buildDemandBoxWarp`, `buildSepDemandBoxWarp`, `mergeIntersectingBoxes`, `findContractionBoxes`, `medianEdgeLenPx` remain.

- [ ] **Step 7.3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no references to removed symbols.

- [ ] **Step 7.4: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "refactor(warp): remove superseded fixed-expand box warp builders"
```

---

### Task 8: Cache fingerprint schema bump

**Files:**
- Modify: `src/render/cacheFingerprint.ts:17`

- [ ] **Step 8.1: Bump and document**

```ts
const SCHEMA = 7; // bump to bust all fingerprints when the renderer's inputs change
```

Append to the version-history comment block below it:

```ts
// v7: demand-driven box warp — boxes from density ∪ predicted-contraction
// clusters, per-box expansion sized to clear the octi contraction threshold,
// canvas grows (boxGrowth = max growth) instead of clawing expansion back.
// boxExpand/boxGrowth keep their option names but change semantics
// (multiplier / max-growth), so cached layouts keyed on the old meanings must
// re-sim. Layout change, unchanged raw inputs; bust main + detail-inset caches.
```

- [ ] **Step 8.2: Run fingerprint tests**

Run: `npx tsx --test src/render/cacheFingerprint.test.ts`
Expected: PASS (if a test pins the literal `v6-` prefix, update it to `v7-`).

- [ ] **Step 8.3: Commit**

```bash
git add src/render/cacheFingerprint.ts src/render/cacheFingerprint.test.ts
git commit -m "chore(cache): schema 7 — demand-driven box warp changes layout semantics"
```

---

### Task 9: Panel slider remap (demand multiplier + max growth)

**Files:**
- Modify: `src/ui/SchematicPanel.tsx:85-92`

- [ ] **Step 9.1: Remap the box-warp slider**

Replace the comment + two mapping functions (SchematicPanel.tsx:85-92) with:

```ts
// Box-warp strength → the demand MULTIPLIER (densityBoxWarp userMult). 0 (center)
// = 1: every dense box expands by exactly what its edges need to survive octi
// contraction, no more. Right (stylized) adds aesthetic magnification on top
// (up to 4x the demand); left (realistic) eases the granted room back toward
// bare survival and below (the demand formula clamps at >= 1 internally, so the
// far left softens aesthetics only — survival room is never fully revoked).
// boxGrowth → the MAX per-axis canvas growth that absorbs the demand (2x at
// center, up to 4x at the right; 1 = canvas-preserving at the far left). [-1, +1].
const boxExpandFromPos = (p: number) => Math.max(0.25, Math.pow(4, p));
const boxGrowthFromPos = (p: number) => Math.max(1, 2 * Math.pow(2, p));
```

(Slider position 0 now yields `userMult 1 / maxGrowth 2` — the new renderer defaults, so a fresh install and the slider's center agree.)

- [ ] **Step 9.2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean. (The `applied.boxWarpPos` persistence shape is unchanged — old saved positions just map through the new curves.)

- [ ] **Step 9.3: Commit**

```bash
git add src/ui/SchematicPanel.tsx
git commit -m "feat(panel): box-warp slider drives demand multiplier + max canvas growth"
```

---

### Task 10: Visual checkpoint on the live dump

**Files:** none (verification only)

- [ ] **Step 10.1: Render before/after**

```bash
git stash list  # ensure clean tree
git worktree list
# BEFORE (pre-change master is the merge-base if working on a branch; if working
# directly on master, use the commit before Task 1):
git log --oneline -12
```

Render the current build: `OCTI_WARP_DEBUG=1 npx tsx dev/render-from-dump.ts "" dev/_parity-after` — writes `dev/_parity-after.svg/.png`. For the BEFORE image, `git stash` any uncommitted work, `git checkout <pre-task-1-commit> -- src/render src/ui`, render to `dev/_parity-before`, then `git checkout HEAD -- src/render src/ui` to restore. (Rasterize with resvg happens inside render-from-dump.)

- [ ] **Step 10.2: Inspect + send to the user**

Check, per the spec's verification section: JFK terminal cluster spread (no megabox), Manhattan readable, Newark/Queens termini still connected, periphery not compressed, `[boxwarp]` debug line shows sensible box counts/expands/growth. Send both PNGs to the user with SendUserFile for the visual checkpoint (this is the user's standing workflow preference).

- [ ] **Step 10.3: Contiguity regression**

Run: `npx tsx dev/contig.ts` (see its usage header for the dump argument — same dump as above).
Expected: no route-contiguity regressions vs master's output.

---

### Task 11: Full verification + wrap up

- [ ] **Step 11.1:** `npm test` — all pass.
- [ ] **Step 11.2:** `npm run typecheck` — clean.
- [ ] **Step 11.3:** Update `README.md` only if it documents the old boxExpand/boxGrowth semantics (grep `boxExpand` in README.md; skip if absent).
- [ ] **Step 11.4:** Final commit of any stragglers; then use superpowers:finishing-a-development-branch (user preference: merge to master).

---

## Self-review notes

- **Spec coverage:** §1 discovery → Tasks 1-2; §2 demand → Task 3; §3 growth → Tasks 3+6; §4 refinement → Task 4; §5 determinism → arithmetic discipline throughout + determinism tests; cache → Task 8; UI → Task 9; testing/verification → Tasks 10-11. Sep composition (spec §2 "both" mode) → Task 5.
- **Type consistency:** `BoxGraph`, `DemandOptions`, `DemandWarpResult`, `buildDemandBoxWarp`, `buildSepDemandBoxWarp`, `findContractionBoxes`, `mergeIntersectingBoxes`, `medianEdgeLenPx` used consistently across Tasks 1-7.
- **Known estimate risks** (accepted in spec): graph-edge-count divisor proxy vs support count (safety 1.3), refinement bounded at one extra pass.
