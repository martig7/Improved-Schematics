# Capsule-Demand Oracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent station-capsule overlaps upstream (a capsule-demand oracle in the box warp buys interchange-scale room) and make them impossible downstream (the experiment's seat-time check/retry + move guard become defaults-on).

**Architecture:** `densityBoxWarp.ts` gains a third box source (`findCapsuleBoxes`), boxes become kind-tagged with pairwise spacing targets, one nesting-aware merge replaces the union-everything merge, and the secant refinement solves each box against its own worst target. `renderGeographic.ts` feeds line counts + capsule geometry constants. `renderOctilinear.ts` flips the `capsule-noovl` experiment gates to on-by-default. Schema 7 → 8.

**Tech Stack:** TypeScript, `tsx --test` (node:test/node:assert). Determinism discipline: `+ − × ÷ √ min max`, fixed iteration order, fully tiebroken sorts (cross-V8 bit-identical). No new dependencies, no new UI.

---

## Context for a zero-context engineer

- **Work on branch `capsule-noovl`** (already checked out; contains the env-gated enforcement experiment this plan productionizes). Spec: `docs/superpowers/specs/2026-07-02-capsule-demand-oracle-design.md`. Prior art: `docs/superpowers/specs/2026-07-01-box-warp-parity-design.md`.
- **The demand warp** (`src/render/layout/densityBoxWarp.ts`): finds boxes via two oracles (`findDenseBoxes` density peaks; `findContractionBoxes` union-find over graph edges shorter than the octi contraction threshold), merges them (`mergeIntersectingBoxes`), seeds per-box expansion (`boxDemand`), builds a fold-free summed per-axis push (`buildWarpFromBoxes`) growing the canvas up to `maxGrowth`, then a bounded (≤4 passes) **secant refinement** re-solves each box's expand against the post-warp contraction threshold (`gapInBox` inside-edge median vs `needAfter`). Read the whole file first — it is heavily commented and ~470 lines.
- **Why capsules still overlap:** the contraction threshold is ~13px, but a 7-line interchange capsule needs ~40–80px of separation from its neighbours. The warp under-asks exactly where capsules are biggest (SEA Naches Av). The enforcement experiment (renderOctilinear.ts, `OCTI_CAPSULE_NOOVL` env) measures/rejects at placement: NYC-difficult has 32 seat-time cross-violations; hull-masked retry recovers 15, the other 17 fall to megaboxes.
- **`BoxGraph`** = `{ nodes: readonly Pixel[]; edges: readonly [number, number][] }` (projected px, index-pair edges). **`Pixel`** = `[number, number]`.
- Test commands: `npx tsx --test src/render/layout/densityBoxWarp.test.ts` (module), `npm test` (all — expect 346 passing at branch head), `npm run typecheck` (31 PRE-EXISTING errors in imageMerge/topo/renderGeographic — you must add zero new ones; compare before/after).
- Dumps for verification: `improvedschematics-map-SEA.json`, `improvedschematics-input-nyc-difficult-NEW.json` (v2 bundles; render with `npx tsx dev/render-dump.ts <dump> <outPrefix> --recompute`, debug via `OCTI_PLACE_DEBUG=1`, warp debug via `OCTI_WARP_DEBUG=1`).

---

### Task 1: Kinded boxes + capsule oracle (`findCapsuleBoxes`)

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Append to densityBoxWarp.test.ts (import `findCapsuleBoxes` and types `DemandBox`, `PairTarget` from `./densityBoxWarp`):

```ts
test('findCapsuleBoxes: a close big-interchange pair gets a box with the pair target; spaced pairs do not', () => {
  // nodes 0,1: 7-line and 6-line interchanges 30px apart (capsules need far more);
  // node 2: 5-line interchange 400px away (clear); nodes 3,4: single-line (excluded).
  const g: BoxGraph = {
    nodes: [[100, 100], [130, 100], [500, 100], [110, 130], [90, 80]],
    edges: [[0, 1], [1, 2], [0, 3], [0, 4]],
  };
  const lineCounts = [7, 6, 5, 1, 1];
  const spacing = 5.5;
  const boxes = findCapsuleBoxes(g, lineCounts, { spacing, margin: 4, casing: 8 });
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  assert.equal(b.kind, 'capsule');
  assert.equal(b.pairs.length, 1);
  assert.deepEqual([b.pairs[0].a, b.pairs[0].b], [0, 1]);
  // required = needA + needB + casing = ((7-1)*5.5/2 + 4) + ((6-1)*5.5/2 + 4) + 8
  const needA = ((7 - 1) * spacing) / 2 + 4;
  const needB = ((6 - 1) * spacing) / 2 + 4;
  assert.ok(Math.abs(b.pairs[0].required - (needA + needB + 8)) < 1e-9);
  // box covers both nodes, padded
  assert.ok(b.x0 < 100 && b.x1 > 130 && b.y0 < 100 && b.y1 > 100);
});

test('findCapsuleBoxes: chains of close interchanges cluster into one box with all violating pairs', () => {
  // three 4-line stations in a 25px-spaced row: pairs (0,1),(1,2) violate; (0,2) may too.
  const g: BoxGraph = { nodes: [[100, 100], [125, 100], [150, 100]], edges: [[0, 1], [1, 2]] };
  const boxes = findCapsuleBoxes(g, [4, 4, 4], { spacing: 5.5, margin: 4, casing: 8 });
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].pairs.length >= 2);
  for (const t of boxes[0].pairs) assert.ok(t.required > 0 && t.a < t.b);
});

test('findCapsuleBoxes: proximity does not require a shared edge', () => {
  // two 5-line interchanges 20px apart with NO connecting edge still flag.
  const g: BoxGraph = { nodes: [[100, 100], [120, 100]], edges: [] };
  const boxes = findCapsuleBoxes(g, [5, 5], { spacing: 5.5, margin: 4, casing: 8 });
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].pairs.length, 1);
});

test('findCapsuleBoxes: deterministic', () => {
  const g: BoxGraph = { nodes: [[100, 100], [130, 100], [110, 130]], edges: [[0, 1]] };
  const a = findCapsuleBoxes(g, [6, 6, 6], { spacing: 5.5 });
  const b = findCapsuleBoxes(g, [6, 6, 6], { spacing: 5.5 });
  assert.deepEqual(a, b);
});
```

- [ ] **Step 1.2: Run to verify FAIL** (`findCapsuleBoxes` not exported).

Run: `npx tsx --test src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 1.3: Implement**

Add to densityBoxWarp.ts, after `mergeIntersectingBoxes`:

```ts
export type BoxKind = 'density' | 'contraction' | 'capsule';
/** A pairwise spacing requirement: the warped distance between nodes a,b must
 *  reach `required` px (capsule separation — CONSTANT under the warp, unlike
 *  the octi contraction threshold, which moves as the map stretches). */
export interface PairTarget { a: number; b: number; required: number }
/** A warp box with its oracle kind and extra spacing targets. Every box also
 *  implicitly carries the octi-contraction floor (inside-edge median ≥
 *  ĉ/2·slack) in the refinement — `pairs` ADD capsule-scale requirements. */
export interface DemandBox extends DenseBox {
  kind: BoxKind;
  pairs: PairTarget[];
}

export interface CapsuleOracleOptions {
  /** Marker lane pitch in px (LINE_WIDTH + LINE_GAP at the call site). */
  spacing: number;
  /** Per-capsule slack beyond the marker row, px. Default 4. */
  margin?: number;
  /** Inter-capsule clearance (casing + breathing room), px. Default 8. */
  casing?: number;
}

/** Capsule-demand oracle: stations whose MARKER ROWS cannot both fit in the
 *  space between them. Per node, the capsule half-length is
 *  (lineCount−1)·spacing/2 + margin (a 1-line node is a plain dot — excluded).
 *  Pairs are found by SPATIAL proximity (bucket grid), NOT graph adjacency —
 *  capsule collisions don't require a shared edge (SEA mn89×mn461). Flagged
 *  pairs union-find into clusters → one box per cluster carrying ALL its
 *  violating pairs as targets. Deterministic: index-ordered scans, integer
 *  bucket keys iterated per node (not per Map order). */
export function findCapsuleBoxes(
  g: BoxGraph,
  lineCounts: readonly number[],
  o: CapsuleOracleOptions,
): DemandBox[] {
  const margin = o.margin ?? 4;
  const casing = o.casing ?? 8;
  const need = (i: number): number =>
    (lineCounts[i] ?? 1) >= 2 ? (((lineCounts[i] ?? 1) - 1) * o.spacing) / 2 + margin : 0;
  const idx: number[] = [];
  let maxNeed = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    const n = need(i);
    if (n > 0) { idx.push(i); if (n > maxNeed) maxNeed = n; }
  }
  if (idx.length < 2) return [];
  // bucket grid at the largest possible pair threshold so any violating pair
  // sits in the same or an adjacent cell
  const cell = 2 * maxNeed + casing;
  const key = (x: number, y: number): string => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  const buckets = new Map<string, number[]>();
  for (const i of idx) {
    const k = key(g.nodes[i][0], g.nodes[i][1]);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }
  const parent = new Map<number, number>(idx.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(i) !== i) { const nx = parent.get(i)!; parent.set(i, root); i = nx; }
    return root;
  };
  const pairs: PairTarget[] = [];
  for (const i of idx) {
    const [ix, iy] = g.nodes[i];
    const cx = Math.floor(ix / cell);
    const cy = Math.floor(iy / cell);
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const arr = buckets.get(cx + ox + ',' + (cy + oy));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue; // each pair once, index-ordered → deterministic
          const dx = ix - g.nodes[j][0];
          const dy = iy - g.nodes[j][1];
          const required = need(i) + need(j) + casing;
          if (Math.sqrt(dx * dx + dy * dy) >= required) continue;
          pairs.push({ a: i, b: j, required });
          const ra = find(i), rb = find(j);
          if (ra !== rb) parent.set(rb, ra);
        }
      }
  }
  if (pairs.length === 0) return [];
  const byRoot = new Map<number, { x0: number; y0: number; x1: number; y1: number; pairs: PairTarget[]; pad: number }>();
  for (const t of pairs) {
    const r = find(t.a);
    let e = byRoot.get(r);
    if (!e) { e = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, pairs: [], pad: 0 }; byRoot.set(r, e); }
    for (const n of [t.a, t.b]) {
      const p = g.nodes[n];
      if (p[0] < e.x0) e.x0 = p[0];
      if (p[0] > e.x1) e.x1 = p[0];
      if (p[1] < e.y0) e.y0 = p[1];
      if (p[1] > e.y1) e.y1 = p[1];
      if (need(n) > e.pad) e.pad = need(n);
    }
    e.pairs.push(t);
  }
  const out: DemandBox[] = [];
  for (const e of byRoot.values()) {
    out.push({ x0: e.x0 - e.pad, y0: e.y0 - e.pad, x1: e.x1 + e.pad, y1: e.y1 + e.pad, kind: 'capsule', pairs: e.pairs });
  }
  return out;
}
```

NOTE on determinism: `byRoot` / `buckets` Maps are keyed by first-insertion in index order, so `.values()` iteration is insertion-ordered and deterministic — the same discipline `findContractionBoxes` uses.

- [ ] **Step 1.4: Run to verify PASS** (module tests; the 18 pre-existing tests untouched).

- [ ] **Step 1.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): capsule-demand oracle — spatial pair scan over marker-row needs"
```

---

### Task 2: Nesting-aware merge (`mergeDemandBoxes`)

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts`
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 2.1: Write the failing tests**

```ts
const DB = (x0: number, y0: number, x1: number, y1: number, kind: BoxKind, pairs: PairTarget[] = []): DemandBox =>
  ({ x0, y0, x1, y1, kind, pairs });

test('mergeDemandBoxes: same-kind overlap unions (old behavior); pairs concatenate', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 10, 10, 'capsule', [{ a: 0, b: 1, required: 20 }]),
    DB(8, 8, 20, 20, 'capsule', [{ a: 2, b: 3, required: 30 }]),
  ]);
  assert.equal(m.length, 1);
  assert.deepEqual({ x0: m[0].x0, y0: m[0].y0, x1: m[0].x1, y1: m[0].y1 }, { x0: 0, y0: 0, x1: 20, y1: 20 });
  assert.equal(m[0].pairs.length, 2);
});

test('mergeDemandBoxes: cross-kind CONTAINMENT nests — both boxes survive', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 100, 100, 'density'),
    DB(40, 40, 60, 60, 'capsule', [{ a: 0, b: 1, required: 25 }]),
  ]);
  assert.equal(m.length, 2);
});

test('mergeDemandBoxes: cross-kind PARTIAL overlap unions; capsule kind and pairs win', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 50, 50, 'contraction'),
    DB(40, 40, 90, 90, 'capsule', [{ a: 0, b: 1, required: 25 }]),
  ]);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'capsule');
  assert.equal(m[0].pairs.length, 1);
  assert.deepEqual({ x0: m[0].x0, x1: m[0].x1 }, { x0: 0, x1: 90 });
});

test('mergeDemandBoxes: disjoint boxes pass through; empty input passes through', () => {
  assert.equal(mergeDemandBoxes([DB(0, 0, 10, 10, 'density'), DB(50, 50, 60, 60, 'contraction')]).length, 2);
  assert.deepEqual(mergeDemandBoxes([]), []);
});
```

- [ ] **Step 2.2: Run to verify FAIL.**

- [ ] **Step 2.3: Implement**

Add after `findCapsuleBoxes`:

```ts
/** Nesting-aware merge (spec §3). Same-kind overlaps union to their bbox (as
 *  the old mergeIntersectingBoxes). A box fully CONTAINED in a different-kind
 *  box NESTS — both survive; the summed per-axis pushes stay monotone, so
 *  compounding is fold-free, and the inner push only adds a rigid translation
 *  to the outer far field. Cross-kind PARTIAL overlap unions conservatively
 *  (kind precedence capsule > contraction > density; pairs concatenate) so
 *  partial pushes never double-stack. Deterministic fixpoint scan. */
export function mergeDemandBoxes(boxes: DemandBox[]): DemandBox[] {
  const out = boxes.map((b) => ({ ...b, pairs: [...b.pairs] }));
  const contains = (a: DemandBox, b: DemandBox): boolean =>
    b.x0 >= a.x0 - 1e-6 && b.x1 <= a.x1 + 1e-6 && b.y0 >= a.y0 - 1e-6 && b.y1 <= a.y1 + 1e-6;
  const rank: Record<BoxKind, number> = { density: 0, contraction: 1, capsule: 2 };
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const overlap = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
        if (!overlap) continue;
        if (a.kind !== b.kind && (contains(a, b) || contains(b, a))) continue; // nest
        out[i] = {
          x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          kind: rank[a.kind] >= rank[b.kind] ? a.kind : b.kind,
          pairs: [...a.pairs, ...b.pairs],
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
  }
  return out;
}
```

- [ ] **Step 2.4: Run to verify PASS.**

- [ ] **Step 2.5: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): nesting-aware demand-box merge (kinded, cross-kind containment nests)"
```

---

### Task 3: Builder integration — third oracle, pair seeding, generalized refinement

**Files:**
- Modify: `src/render/layout/densityBoxWarp.ts` (buildDemandBoxWarp, DemandOptions)
- Test: `src/render/layout/densityBoxWarp.test.ts`

- [ ] **Step 3.1: Write the failing tests**

```ts
test('buildDemandBoxWarp: capsule oracle lifts a close interchange pair to its required separation', () => {
  // two interchanges 30px apart needing ~48px, on an otherwise sparse graph
  const g: BoxGraph = {
    nodes: [[200, 200], [230, 200], [30, 30], [560, 560], [560, 30], [30, 560]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
  };
  const lineCounts = [7, 6, 1, 1, 1, 1];
  const opts = { ...DOPTS, maxGrowth: 8, capsule: { spacing: 5.5, lineCounts, margin: 4, casing: 8 } };
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  const rr = buildDemandBoxWarp([], g, DBOX, opts, o);
  const required = ((7 - 1) * 5.5) / 2 + 4 + (((6 - 1) * 5.5) / 2 + 4) + 8;
  const pa = rr.warp(g.nodes[0]);
  const pb = rr.warp(g.nodes[1]);
  const d = Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2);
  assert.ok(d >= required, `pair separation ${d.toFixed(1)} < required ${required.toFixed(1)}`);
});

test('buildDemandBoxWarp: no capsule opts → behavior unchanged (existing demand path)', () => {
  const g = pinnedGraph();
  const withOpt = buildDemandBoxWarp([], g, DBOX, DOPTS);
  const noCaps = buildDemandBoxWarp([], g, DBOX, { ...DOPTS });
  assert.deepEqual(withOpt.warp([123, 234]), noCaps.warp([123, 234]));
});

test('buildDemandBoxWarp: capsule box nested in a density box compounds fold-free', () => {
  // dense sample cluster spanning ~(40..160)² CONTAINING an interchange pair
  const g: BoxGraph = {
    nodes: [[90, 100], [115, 100], [30, 30], [560, 560]],
    edges: [[0, 1], [0, 2], [1, 3]],
  };
  const samples = clusterAt(100, 100, 400);
  const opts = { ...DOPTS, maxGrowth: 8, capsule: { spacing: 5.5, lineCounts: [6, 6, 1, 1], margin: 4, casing: 8 } };
  const rr = buildDemandBoxWarp(samples, g, DBOX, opts);
  // fold-free: strict per-axis monotonicity over a coarse grid
  for (let y = 0; y <= 600; y += 30) {
    let px = -Infinity;
    for (let x = 0; x <= 600; x += 30) {
      const q = rr.warp([x, y])[0];
      assert.ok(q > px, `x-monotonicity broke at ${x},${y}`);
      px = q;
    }
  }
  for (let x = 0; x <= 600; x += 30) {
    let py = -Infinity;
    for (let y = 0; y <= 600; y += 30) {
      const q = rr.warp([x, y])[1];
      assert.ok(q > py, `y-monotonicity broke at ${x},${y}`);
      py = q;
    }
  }
});
```

(`DOPTS`, `DBOX`, `pinnedGraph`, `clusterAt` already exist in the test file — check their shapes and adapt coordinates only if a helper differs from what these tests assume, preserving each assertion's meaning.)

- [ ] **Step 3.2: Run to verify FAIL** (unknown option `capsule`; first test's separation assertion fails).

- [ ] **Step 3.3: Implement**

1. Extend `DemandOptions`:

```ts
  /** Capsule-demand oracle inputs (optional — omitted by unit-level callers
   *  and dev tools that have no marker model; the oracle then doesn't run). */
  capsule?: CapsuleOracleOptions & {
    /** Per-g.nodes-index stopping-line estimate (lines through the node —
     *  an upper bound on stop marks; slack-friendly). */
    lineCounts: readonly number[];
  };
```

2. In `buildDemandBoxWarp`, replace the discovery + merge + seed block:

```ts
  const density = samples.length ? findDenseBoxes(samples, box, opts) : [];
  const contraction = findContractionBoxes(g, (cell / 2) * safety);
  const capsule = opts.capsule ? findCapsuleBoxes(g, opts.capsule.lineCounts, opts.capsule) : [];
  const boxes = mergeDemandBoxes([
    ...density.map((b) => ({ ...b, kind: 'density' as const, pairs: [] })),
    ...contraction.map((b) => ({ ...b, kind: 'contraction' as const, pairs: [] })),
    ...capsule,
  ]);
```

(the empty-boxes early return stays; update the debug line at the bottom to `(density=${density.length} contraction=${contraction.length} capsule=${capsule.length})`).

3. Seeding — after `let expands = boxes.map(...boxDemand...)`, lift capsule targets into the seed:

```ts
  // Capsule pair targets seed on top of the contraction-floor demand: the
  // expansion that lifts each pair to its required separation (× userMult).
  expands = expands.map((e, i) => {
    let out = e;
    for (const t of boxes[i].pairs) {
      const pa = g.nodes[t.a], pb = g.nodes[t.b];
      const d = Math.sqrt((pa[0] - pb[0]) * (pa[0] - pb[0]) + (pa[1] - pb[1]) * (pa[1] - pb[1]));
      if (d > 0) out = Math.max(out, Math.min(expandMax, Math.max(1, userMult * Math.max(1, t.required / d))));
    }
    return out;
  });
```

4. Generalize the refinement to per-box worst-of targets. Replace the refinement block's evaluation state (`gapPrev`/`needPrev` and the per-pass `gapNow`/`needAfter` usage) with a per-box `{gap, need}` evaluator — the contraction floor for every box plus any pair targets, worst violation (max need/gap ratio) wins:

```ts
    // Worst-of evaluation: every box carries the contraction floor (inside-
    // edge median vs the CURRENT global threshold), and capsule boxes add
    // pair-separation targets (CONSTANT need — capsule size doesn't move with
    // the warp). The secant solves each box against its worst violator; the
    // per-box `need` is now part of the secant state because pair needs and
    // the contraction threshold evolve differently.
    const evalBox = (i: number, bbox: DenseBox, nodes: readonly Pixel[], needFloor: number): { gap: number; need: number } => {
      let gap = gapInBox(bbox, nodes);
      let needV = needFloor;
      let worst = Number.isFinite(gap) && gap > 0 ? needV / gap : 0;
      for (const t of boxes[i].pairs) {
        const pa = nodes[t.a], pb = nodes[t.b];
        const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
        const d = Math.sqrt(dx * dx + dy * dy);
        const ratio = d > 0 ? t.required / d : Infinity;
        if (ratio > worst) { worst = ratio; gap = d; needV = t.required; }
      }
      return { gap, need: needV };
    };
    let prev = boxes.map((b, i) => evalBox(i, b, g.nodes, need));
    let ePrev = boxes.map(() => 1);
    for (let pass = 0; pass < 4; pass++) {
      const advected = g.nodes.map((p) => result.warp([p[0], p[1]]) as Pixel);
      const needAfter = (opts.cellFromMedLen(medianEdgeLenPx({ nodes: advected, edges: g.edges })) / 2) * slack;
      const now = boxes.map((_, i) => evalBox(i, oref.boxes![i], advected, needAfter));
      const eNext = expands.map((e, i) => {
        const { gap, need: needV } = now[i];
        if (!Number.isFinite(gap) || gap >= needV) return e; // cleared
        const margin = needV * 0.05; // headroom for the affine-model error
        // (the two 1e-9 guards below are just "<= 0 with an fp cushion";
        // scale-independent — the guarded deltas are far above 1e-9 whenever
        // a real step happened.)
        const de = e - ePrev[i];
        if (de <= 1e-9) return Math.min(expandMax, (e * (needV + margin)) / gap); // no slope yet: proportional seed
        const denom = (gap - prev[i].gap) - (needV - prev[i].need);
        // denom <= 0: the need rises at least as fast as this box's gap — the
        // target is out of reach of expansion alone; jump to the ceiling (the
        // growth cap then freezes the median so the gap can catch up).
        if (denom <= 1e-9) return expandMax;
        const target = e + ((needV + margin - gap) * de) / denom;
        return Math.min(expandMax, Math.max(e, target));
      });
      // No progress — every box either cleared or sits saturated at the
      // ceiling: another pass would rebuild bit-identically, so stop.
      if (eNext.every((e, i) => e === expands[i])) break;
      ePrev = expands; prev = now;
      expands = eNext;
      result = buildWarpFromBoxes(boxes, expands.map((e) => e - 1), box, marginFrac, maxGrowth, oref);
    }
```

CAREFUL: this REPLACES the existing refinement loop body (which tracked `gapPrev`/`needPrev` with a single global need). The existing `gapInBox` helper stays as-is. `boxes` is now `DemandBox[]` — `buildWarpFromBoxes` accepts `DenseBox[]` (structural supertype), no change needed there. `out.boxes`/`oref.boxes` remain plain output-space DenseBoxes (display-only) — no kind leak into `denseBoxesPx`.

5. `buildSepDemandBoxWarp` needs no change — `boxOpts` (with `capsule`) flows through and node indices survive the separable advection.

- [ ] **Step 3.4: Run the module tests + full suite**

Run: `npx tsx --test src/render/layout/densityBoxWarp.test.ts` then `npx tsx --test "src/**/*.test.ts"`.
Expected: all pass. Pre-existing tests exercise the no-`capsule` path — the refinement rewrite must reproduce their results (the corner-mapping test at ~line 208 recomputes `mergeIntersectingBoxes(findContractionBoxes(...))` to mirror the builder — the builder now uses `mergeDemandBoxes`, but with contraction-only input the two produce IDENTICAL bboxes, so the test should still pass; if it fails on shape, update its recomputation to `mergeDemandBoxes(findContractionBoxes(...).map((b) => ({ ...b, kind: 'contraction' as const, pairs: [] })))` and strip kind/pairs before comparing).

- [ ] **Step 3.5: Typecheck** — `npm run typecheck`, zero NEW errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/render/layout/densityBoxWarp.ts src/render/layout/densityBoxWarp.test.ts
git commit -m "feat(warp): capsule oracle in the demand builder — pair seeding + worst-of secant targets"
```

---

### Task 4: renderGeographic wiring

**Files:**
- Modify: `src/render/renderGeographic.ts` (warpSamples loop ~line 655-676, boxOpts ~line 700)

- [ ] **Step 4.1: Capture per-node line counts**

In `precomputeSmoothed`'s warpSamples loop (it iterates `graph.nodes.values()` — the SAME insertion order as `nodeIds = [...graph.nodes.keys()]` used for `boxGraph`), the per-node `lines` Set already exists. Declare before the loop and push inside it:

```ts
  const nodeLineCounts: number[] = []; // per nodeIds index — capsule-oracle input
```

inside the loop, right after `const lineWeight = ...`:

```ts
    nodeLineCounts.push(lines.size);
```

- [ ] **Step 4.2: Feed the capsule oracle**

Add `LINE_WIDTH, LINE_GAP` to the existing import from `./constants` (check what's already imported — extend, don't duplicate). Extend `boxOpts`:

```ts
  // Capsule-demand oracle (spec 2026-07-02): marker geometry constants +
  // per-node line counts. OCTI_CAPS_MARGIN / OCTI_CAPS_CASING override the
  // per-capsule slack / inter-capsule clearance for dev sweeps.
  const capsMargin = Number.isFinite(envNum('OCTI_CAPS_MARGIN')) && envNum('OCTI_CAPS_MARGIN') >= 0 ? envNum('OCTI_CAPS_MARGIN') : 4;
  const capsCasing = Number.isFinite(envNum('OCTI_CAPS_CASING')) && envNum('OCTI_CAPS_CASING') >= 0 ? envNum('OCTI_CAPS_CASING') : 8;
  const boxOpts = {
    frac: boxFrac,
    marginFrac: boxMargin,
    userMult: boxUserMult,
    maxGrowth: boxMaxGrowth,
    cellFromMedLen,
    capsule: { spacing: LINE_WIDTH + LINE_GAP, lineCounts: nodeLineCounts, margin: capsMargin, casing: capsCasing },
  };
```

(the existing boxOpts fields stay exactly as they are — only `capsule` is added).

- [ ] **Step 4.3: Sanity render**

Run: `OCTI_WARP_DEBUG=1 OCTI_WARP_CAPTURE_ONLY=1 npx tsx dev/render-from-dump.ts improvedschematics-input-dump-current-seattle.json 2>&1 | grep boxwarp`
Expected: a `[boxwarp] boxes=… (density=… contraction=… capsule=…) …` line (capsule count may be 0 or small on Seattle; the line must carry the third counter). The trailing resvg error on the CAPTURE_ONLY sentinel is expected.

- [ ] **Step 4.4: Full suite + typecheck** — `npx tsx --test "src/**/*.test.ts"` green; zero new type errors.

- [ ] **Step 4.5: Commit**

```bash
git add src/render/renderGeographic.ts
git commit -m "feat(render): feed line counts + marker geometry to the capsule-demand oracle"
```

---

### Task 5: Enforcement defaults-on (renderOctilinear)

**Files:**
- Modify: `src/render/renderOctilinear.ts` (the experiment's gate block near the `placedDots` declaration ~line 1248, the seat-check block ~line 1415, the summary log, and the `capGuardOn` definition next to `capsHullOf`)

- [ ] **Step 5.1: Replace the experiment gates with production gates**

Replace the `capNoOvlMode`/`capPlaceDebug`/`capOvlOn` block (near line 1250) with:

```ts
    // Capsule overlap enforcement (spec 2026-07-02) — ON BY DEFAULT.
    // Seat-time: a solution whose spine hull crosses a placed capsule gets ONE
    // hull-masked re-solve (blocked = dot-ring-inside-hull veto, proximity =
    // comfort ramp); a still-crossing retry — and any SELF-crossing chain
    // (per-dot masks can't express "don't cross yourself") — falls to the
    // mega box. The upstream capsule-demand oracle (densityBoxWarp) buys the
    // room that makes violations rare; this pass makes them impossible.
    // OCTI_CAPSULE_NOOVL=0 disables the seat-time check+retry (legacy);
    // OCTI_CAPSULE_GUARD=0 disables the move-commit hull guard (diagnostic).
    // Counters/audits print under OCTI_PLACE_DEBUG=1.
    const capEnv = typeof process !== 'undefined' ? (process as { env?: Record<string, string> }).env : undefined;
    const capNoOvlOn = capEnv?.OCTI_CAPSULE_NOOVL !== '0';
    const capPlaceDebug = capEnv?.OCTI_PLACE_DEBUG === '1';
    const capOvlOn = capNoOvlOn || capPlaceDebug;
    const placedHulls: Array<{ nodeId: string; hull: Hull }> = [];
    const capOvlStats = { capsules: 0, self: 0, cross: 0, retried: 0, retriedOk: 0, rejected: 0 };
```

And where `capGuardOn` is defined (next to `capsHullClash`): `const capGuardOn = capEnv?.OCTI_CAPSULE_GUARD !== '0';` — note `capEnv` must be in scope there (it is: same enclosing function; if the declaration order puts `capsHullClash` before the gate block, move the `capEnv` line up as needed).

- [ ] **Step 5.2: Rewire the seat-check block's mode tests**

In the seat-check block: replace `const wantSelf = capNoOvlMode.includes('self') || …` and `const wantCross = …` with `const wantSelf = capNoOvlOn; const wantCross = capNoOvlOn;`, and the retry condition `capNoOvlMode.includes('retry')` with `capNoOvlOn`. Update the block's header comment to describe the production behavior (drop "experiment"). Everything else (evalSol, retry mechanics, placedHulls push) stays.

- [ ] **Step 5.3: Summary log**

Replace the `[capsovl]` summary condition with: print when `capPlaceDebug || capOvlStats.rejected > 0` (a rejection changes the drawn map — worth a log line even without debug, mirroring `[stops] mega-box fallbacks`). Drop `mode=` from the message; print `guard=${capGuardOn ? 'on' : 'off'} noovl=${capNoOvlOn ? 'on' : 'off'}` instead.

- [ ] **Step 5.4: Audit calls stay debug-only** — confirm all four `capsAudit(...)` call sites are inside the function and `capsAudit` itself early-returns unless `capOvlOn`; change its guard to `if (!capPlaceDebug) return;` (audits are diagnostics; the enforcement no longer needs them).

- [ ] **Step 5.5: Full suite** — `npx tsx --test "src/**/*.test.ts"`: **expect 346 pass**. The fixtures are small synthetic networks; if any end-to-end snapshot changes, inspect whether a fixture legitimately had a capsule crossing (enforcement now boxes/retries it) — report the specific test and diff BEFORE changing any expectation; a changed fixture expectation needs the controller's sign-off.

- [ ] **Step 5.6: Typecheck** (zero new) **+ Commit**

```bash
git add src/render/renderOctilinear.ts
git commit -m "feat(stops): capsule overlap enforcement on by default (seat check + retry + move guard)"
```

---

### Task 6: Cache schema bump 7 → 8

**Files:**
- Modify: `src/render/cacheFingerprint.ts:17` (SCHEMA) + version-history comment

- [ ] **Step 6.1: Bump + document**

`const SCHEMA = 8;` and append:

```ts
// v8: capsule-demand oracle (third warp-box source: interchange pairs closer
// than their combined marker-row needs; nesting-aware box merge; per-kind
// secant targets) + capsule overlap enforcement on by default (seat-time
// hull check with hull-masked retry, move-commit hull guard). Layout AND
// placement change, unchanged raw inputs; bust main + detail-inset caches.
```

- [ ] **Step 6.2: Run** `npx tsx --test src/render/cacheFingerprint.test.ts` (3 tests; no literal `v7-` pin exists, but verify).

- [ ] **Step 6.3: Commit**

```bash
git add src/render/cacheFingerprint.ts
git commit -m "chore(cache): schema 8 — capsule oracle + overlap enforcement change layouts"
```

---

### Task 7: Dump verification matrix

**Files:** none (verification; writes scratch renders under dev/_*)

- [ ] **Step 7.1: SEA + NYC metrics**

```bash
OCTI_PLACE_DEBUG=1 npx tsx dev/render-dump.ts improvedschematics-map-SEA.json dev/_sea-oracle --recompute --crop "Naches" --span 500 2> dev/_sea-oracle.log >/dev/null
grep -E "capsovl|capsaudit:final|mega-box fallbacks|boxwarp" dev/_sea-oracle.log
OCTI_PLACE_DEBUG=1 OCTI_WARP_DEBUG=1 npx tsx dev/render-dump.ts improvedschematics-input-nyc-difficult-NEW.json dev/_nyc-oracle --recompute 2> dev/_nyc-oracle.log >/dev/null
grep -E "capsovl\] capsules|capsaudit:final|mega-box fallbacks|boxwarp" dev/_nyc-oracle.log
```

Success criteria (record actual numbers in your report):
- `[capsaudit:final] cross=0 self=0` on BOTH dumps (enforcement guarantee).
- NYC seat-time `crossOvl` **< 32** and megaboxes **< 20** (the no-oracle experiment's numbers — the oracle must reduce enforcement's work; if crossOvl does NOT drop, the oracle isn't reaching the violating clusters: check the `[boxwarp]` line for capsule box count and report as DONE_WITH_CONCERNS with the numbers rather than tuning constants ad hoc).
- SEA megaboxes ≤ 3 (the retry-experiment level).
- `[boxwarp]` shows `capsule=` ≥ 1 on NYC.

- [ ] **Step 7.2: Regression checks**

```bash
npx tsx dev/_contig-fresh.ts dev/_nyc-input-extracted.json   # 38/38 routes contiguous (file exists from the prior session; if missing, note and skip)
npm run build                                                 # panel bundle builds
```

Also render the JFK crop to confirm the box-warp result is unregressed: `node dev/_crop.mjs dev/_nyc-oracle.svg dev/_nyc-oracle-jfk.png <cx> <cy> 840` — find JFK's coords via `grep -o '<text x="[0-9.]*" y="[0-9.]*"[^>]*>JFK' dev/_nyc-oracle.svg | head -2` and center the crop there.

- [ ] **Step 7.3: Report** the metric table (before/after per dump), attach paths of `dev/_sea-oracle.png`, `dev/_nyc-oracle-jfk.png` for the controller's visual checkpoint to the user. Do NOT commit scratch files.

---

### Task 8: Docs touch-up + final verification

**Files:**
- Modify: `docs/smoothed-pipeline-performance.md` (only if stale — grep first)

- [ ] **Step 8.1:** `grep -n "density ∪ contraction\|contraction oracle" docs/smoothed-pipeline-performance.md docs/superpowers/specs/2026-07-01-box-warp-parity-design.md` — the perf doc's §4 construction line should mention the capsule oracle's pair scan (`O(n)` bucket grid) alongside the contraction oracle. One-line addition; do not rewrite history in the 07-01 spec (it documents its own scope).
- [ ] **Step 8.2:** `npm test` (all green) + `npm run typecheck` (no new errors) + `git status --short` (clean).
- [ ] **Step 8.3: Commit** any doc touch-up: `git commit -m "docs: note capsule oracle in the warp perf reference"`.
- [ ] **Step 8.4:** Final code review of the whole branch range (controller dispatches), then superpowers:finishing-a-development-branch — user preference: merge `capsule-noovl` to master.

---

## Self-review notes

- **Spec coverage:** §1 oracle → Task 1; §2 per-box need functions + refinement → Task 3; §3 nesting merge → Task 2; §4 enforcement defaults → Task 5; §5 determinism (in each impl), cache → Task 6, UI-none (no task needed), perf (bucket grid Task 1, measured Task 7); Testing → Tasks 1-3 units + Task 7 dumps + visual checkpoint.
- **Type consistency:** `BoxKind`/`PairTarget`/`DemandBox`/`CapsuleOracleOptions`/`findCapsuleBoxes`/`mergeDemandBoxes`/`evalBox` used consistently across Tasks 1-3; `capEnv`/`capNoOvlOn`/`capGuardOn`/`capPlaceDebug` across Task 5.
- **Known judgment points left to the implementer to REPORT (not decide silently):** fixture-expectation changes in Task 5.5; oracle-miss numbers in Task 7.1.
