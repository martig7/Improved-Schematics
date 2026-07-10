# Rectangle capsule seating — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Give the Tokyu design a real interchange placement — upright letter/number boxes
seated on their lines, slid into axis-adaptive rows, joined by shortest-octilinear-polyline
connectors — computed in the placement layer, replacing the hardcoded row in `tokyu.paint()`.

**Architecture:** `computeRibbonGeometry` (design-agnostic, cached) records two geometric
facts per interchange mark — the pre-solve **home** (lane position) and the **octilinear
axis** (0..3). At paint time, `buildScene` (told the design's capsule mode) runs the
`rectSeat` solver from those facts to produce a new `rectRows` capsule (per-member box
centers + group rects + connector polylines). `tokyu.paint()` renders it. `solveRows`,
pill mode, and every other design are untouched (byte-identical).

**Tech stack:** TypeScript; `npm test` (`tsx --test`); deterministic (no `Math.random`/`Date`).

**Key facts (verified):**
- `Capsule` union + `StopScene`/`StopLine`/`Glyph`/`StationDesign`/`PaintCtx`: `src/render/stations/types.ts`.
- `buildScene(nodeId, marks, ctx)`: `src/render/stations/placement.ts` (ctx = `PlacementCtx`).
- `renderStations(stopsByNode, ctx, design)` calls `buildScene`: `src/render/stations/render.ts`.
- Glyph primitives (`rect`, `text`, `line`, `circle`, `capsuleGlyphs`): `src/render/stations/primitives.ts`.
- `glyphToSvg`/`glyphToPrim` already handle `rect`/`line`/`path`/`text`: `src/render/stations/serialize.ts`.
- `StopMark`: `src/render/layout/types.ts:102` (has `seq?`; add `home?`/`axis?`).
- `renderOctilinear.ts`: interchange placement loop starts `~1321`; `markAxis` computed
  `~1344-1349`; `solveRows` at `1471`; `addStop` defined `989`, and the station-group marks
  are flushed to `stopsByNode` at `2806` (`for (const m of s.marks) addStop(...)`). The
  `StMarks` mark objects at `1057-1067` are the SAME refs flushed at 2806, so fields set on
  them in the loop reach `stopsByNode`. `stationDesign` is **draw-time only** (never read in
  `computeRibbonGeometry`) — so home/axis capture must be design-agnostic.

---

## Task 1: Types — `rectRows` capsule, `home`/`axis`, capsule mode

**Files:** Modify `src/render/stations/types.ts`, `src/render/layout/types.ts`,
`src/render/stations/primitives.ts`.

- [ ] **Step 1: Extend the `Capsule` union** in `stations/types.ts` (after the `ring` line):

```ts
  | { kind: 'ring'; cx: number; cy: number; r: number }
  | { kind: 'rectRows';
      box: number;                                   // box side length (world px)
      groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>; // one rounded-rect per aligned row
      connectors: Array<{ points: Point[] }>;        // octilinear polyline (2 pts = 1 segment, 3 = one bend)
    };
```

- [ ] **Step 2: Add the design's capsule mode** to `StationDesign` in `stations/types.ts`:

```ts
export interface StationDesign {
  id: string;
  name: string;
  blurb?: string;
  /** Interchange capsule regime the design wants placement to produce. Default
   *  'pill'. 'rectRows' triggers the upright-box rectangle seating. */
  capsule?: 'pill' | 'rectRows';
  paint: (scene: StopScene, ctx: PaintCtx) => Glyph[];
  previewKind?: 'single' | 'interchange';
}
```

- [ ] **Step 3: Add `home`/`axis`** to `StopMark` in `layout/types.ts` (after `mega?`):

```ts
  /** Rect seating inputs (design-agnostic, recorded in computeRibbonGeometry for
   *  interchange marks): the pre-solve lane position ("home", where the line passes
   *  the node) and its octilinear run-axis index (0=–, 1=/, 2=|, 3=\). Consumed by
   *  the rectangle ("Tokyu") capsule seating at paint time. */
  home?: Pixel;
  axis?: number;
```

- [ ] **Step 4: Give `capsuleGlyphs` a `rectRows` case** in `primitives.ts` (rect capsules
  are painted by the design itself, so this is a no-op for the generic path) — add before
  the final pill block:

```ts
  if (capsule.kind === 'rectRows') return []; // painted by the rect design, not here
```

- [ ] **Step 5: Verify build/tests unaffected**

Run: `npm test`
Expected: 428 pass (types-only change; nothing consumes the new fields yet).

- [ ] **Step 6: Commit** — `git add -A && git commit -F <msg>` (`feat(stations): add rectRows capsule kind + rect-seating type hooks`).

---

## Task 2: `octiConnect` — shortest octilinear polyline between two rects

**Files:** Create `src/render/layout/octiConnect.ts`, `src/render/layout/tests/octiConnect.test.ts`.

A rect is `{ x, y, w, h }` (top-left + size). Returns `{ points: Point[] }`: 2 points when a
single octilinear segment spans the pair, else 3 points (one octilinear bend).

- [ ] **Step 1: Write the failing tests** (`tests/octiConnect.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octiConnect } from '../octiConnect';

const R = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h });

test('vertical gap (x-ranges overlap) -> single vertical segment', () => {
  const c = octiConnect(R(0, 0), R(0, 30));       // stacked, same x
  assert.equal(c.points.length, 2);
  assert.equal(c.points[0][0], c.points[1][0]);   // vertical: equal x
  assert.deepEqual(c.points[0], [5, 10]);         // bottom edge of A (center x)
  assert.deepEqual(c.points[1], [5, 30]);         // top edge of B
});

test('horizontal gap (y-ranges overlap) -> single horizontal segment', () => {
  const c = octiConnect(R(0, 0), R(30, 0));       // side by side, same y
  assert.equal(c.points.length, 2);
  assert.equal(c.points[0][1], c.points[1][1]);   // horizontal: equal y
});

test('pure diagonal offset -> single 45 segment (corner to corner)', () => {
  const c = octiConnect(R(0, 0), R(30, 30));      // down-right by equal amounts
  assert.equal(c.points.length, 2);
  const dx = c.points[1][0] - c.points[0][0], dy = c.points[1][1] - c.points[0][1];
  assert.equal(Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6, true); // 45 degrees
});

test('dead zone (all projections disjoint) -> two-segment octilinear path', () => {
  // A unit-ish box at origin, B far right + slightly up: 5x,2y offset, small boxes
  const c = octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4));
  assert.equal(c.points.length, 3);               // one bend
  // every leg is octilinear (dx==0, dy==0, or |dx|==|dy|)
  for (let i = 1; i < c.points.length; i++) {
    const dx = Math.abs(c.points[i][0] - c.points[i - 1][0]);
    const dy = Math.abs(c.points[i][1] - c.points[i - 1][1]);
    assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, `leg ${i} octilinear`);
  }
});

test('deterministic: same input -> identical output', () => {
  assert.deepEqual(octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4)),
                   octiConnect(R(0, 0, 4, 4), R(50, 20, 4, 4)));
});
```

- [ ] **Step 2: Run tests, verify they fail** — `npx tsx --test src/render/layout/tests/octiConnect.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `octiConnect.ts`.** Algorithm:
  - `Rect = { x, y, w, h }`; `Seg = { points: Point[] }`. Import `Point` from `../stations/types`.
  - **Single-segment candidates** (return the shortest, prefer by fixed direction order
    V, H, then the two diagonals):
    - Vertical: if x-ranges overlap, x* = midpoint of the x-overlap; segment from the near
      horizontal edge of the upper rect to the near edge of the lower rect at x*. Length =
      vertical gap. (If rects overlap in y too, gap ≤ 0 → skip/degenerate.)
    - Horizontal: symmetric on y-overlap.
    - Diagonal (slope −1, i.e. x+y const): if the `x+y` ranges overlap, connect nearest
      corners along a 45° line; length = gap along that diagonal.
    - Diagonal (slope +1, x−y const): symmetric.
    - A candidate is valid only if its gap > 0. Pick the min positive length; tie-break by
      the fixed order above.
  - **Two-segment fallback** (no valid single segment): route `A → v → B` where the bend `v`
    is chosen deterministically as: from A's center, take the octilinear direction whose
    axis matches the larger of |Δx|,|Δy| to reach B's cross-coordinate band, then a second
    octilinear leg into B. Concretely: if |Δx| ≥ |Δy|, leg1 horizontal from A-edge to
    x = B.centerX at y = A.centerY, leg2 vertical into B-edge; else swap. Endpoints clamp to
    the rect boundaries. (A 45°+axis variant is a later refinement; axis-aligned 2-leg is
    fine for v1 and still octilinear.) Points = `[aEdge, bend, bEdge]`.
  - No `Math.random`/`Date`; integer/exact comparisons; deterministic tie-breaks.

- [ ] **Step 4: Run tests, verify pass** — `npx tsx --test .../octiConnect.test.ts` → PASS.

- [ ] **Step 5: Commit** (`feat(layout): octiConnect — shortest octilinear polyline between two rects`).

---

## Task 3: `rectSeat` — upright-box seating solver

**Files:** Create `src/render/layout/rectSeat.ts`, `src/render/layout/tests/rectSeat.test.ts`.

Signature:

```ts
import type { Point } from '../stations/types';
export interface RectMember { lineId: string; home: Point; axis: number } // axis 0..3
export interface RectSeatOut {
  centers: Map<string, Point>;                                  // lineId -> box center
  groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>;
  connectors: Array<{ points: Point[] }>;
}
export function rectSeat(members: RectMember[], box: number, gap: number): RectSeatOut;
```

**Algorithm (deterministic):**
1. **Partition into aligned rows.** For member count `n ≤ 6`, enumerate set partitions; for
   each part choose axis ∈ {H, V}; within a part order members by their along-axis home
   coordinate (tie-break lineId); place boxes edge-to-edge (pitch `box + gap`) centered on
   the part's median along-axis home, at the median cross-axis home (this is the **slide**).
   Cost `= Σ|home_i − placed_i|  +  (#parts − 1) · K`, where `K = 0.5 · maxSlideForcedRow`
   and `maxSlideForcedRow` is the largest single-member slide from forcing ALL members into
   one packed row, taking the **worse** of the two single-axis layouts (the true "merge into
   the main row" cost — the best-axis reading lets trivial zero-slide singleton splits win,
   which is wrong). Pick the min-cost partition+axes; deterministic tie-breaks
   (fewer parts, then lower partition index, then H<V). For `n ≥ 7`, use one best-axis row
   (mega handles the truly huge hubs upstream).
2. **Groups:** each part's rounded-rect = union of its box footprints + pad (`box*0.16`),
   `rx = (box + 2·pad)·0.16`.
3. **Connectors:** MST (Prim) over part-group rects by centroid distance; each edge =
   `octiConnect(groupA, groupB)`.
4. `centers` maps each member's lineId to its placed box center.

- [ ] **Step 1: Write failing tests** (`tests/rectSeat.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectSeat } from '../rectSeat';

const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

test('two horizontally-aligned members -> one row, one group, no connector', () => {
  const out = rectSeat(
    [{ lineId: 'A', home: [0, 0], axis: 0 }, { lineId: 'B', home: [40, 0], axis: 0 }],
    30, 4,
  );
  assert.equal(out.groups.length, 1);
  assert.equal(out.connectors.length, 0);
  const a = out.centers.get('A')!, b = out.centers.get('B')!;
  assert.ok(near(a[1], b[1]));                 // same y (one horizontal row)
  assert.ok(near(Math.abs(b[0] - a[0]), 34));  // pitch = box+gap
});

test('members split into two rows are joined by exactly one connector', () => {
  // three tight left + one far up-right -> a split is cheaper than one long row
  const out = rectSeat([
    { lineId: 'A', home: [0, 0], axis: 0 },
    { lineId: 'B', home: [34, 0], axis: 0 },
    { lineId: 'C', home: [68, 0], axis: 0 },
    { lineId: 'D', home: [34, 120], axis: 0 },
  ], 30, 4);
  assert.equal(out.groups.length, 2);
  assert.equal(out.connectors.length, 1);
  assert.ok(out.connectors[0].points.length >= 2);
});

test('deterministic: identical output on repeat', () => {
  const args = () => rectSeat(
    [{ lineId: 'A', home: [0, 0], axis: 2 }, { lineId: 'B', home: [3, 60], axis: 2 }], 30, 4);
  assert.deepEqual(args(), args());
});

test('single member -> one box at its home, no connector', () => {
  const out = rectSeat([{ lineId: 'A', home: [10, 10], axis: 0 }], 30, 4);
  assert.equal(out.centers.get('A')!.length, 2);
  assert.equal(out.connectors.length, 0);
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `rectSeat.ts`** per the algorithm; import `octiConnect`. Pure/deterministic.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** (`feat(layout): rectSeat — upright-box interchange seating solver`).

---

## Task 4: `buildScene` rect branch

**Files:** Modify `src/render/stations/placement.ts`, `src/render/stations/render.ts`;
add `src/render/stations/tests/placement.rect.test.ts`.

- [ ] **Step 1: Thread capsule mode.** In `placement.ts`, extend `PlacementCtx`:

```ts
export interface PlacementCtx {
  megaFallback: 'box' | 'curve';
  members?: Map<string, number>;
  deg?: Map<string, number>;
  capsuleMode?: 'pill' | 'rectRows';
}
```

  In `render.ts` `renderStations`, pass it from the design at the `buildScene` call (line 27):

```ts
    const scene = buildScene(nodeId, marks, { megaFallback: ctx.megaFallback, members: ctx.members, deg: ctx.deg, capsuleMode: design.capsule });
```

- [ ] **Step 2: Add the rect branch** in `buildScene`, right after the `isCapsule`/`dotRadius`
  lines (before the farthest-pair block), so it takes over multi-line non-mega stations when
  requested and every mark has `home`/`axis`:

```ts
  if (ctx.capsuleMode === 'rectRows' && isCapsule && !marks.some((m) => m.mega)
      && marks.every((m) => m.home && m.axis !== undefined)) {
    const S = 3 * RCAP / MARKER_SCALE;   // box side = single-stop box (matches tokyu paint)
    const members = marks.map((m) => ({ lineId: m.lineId, home: m.home as Point, axis: m.axis as number }));
    const seat = rectSeat(members, S, S * 0.14);
    const rlines = lines.map((ln) => ({ ...ln, pos: (seat.centers.get(ln.lineId) ?? ln.pos) as Point }));
    let cx = 0, cy = 0;
    for (const p of seat.centers.values()) { cx += p[0]; cy += p[1]; }
    const n = seat.centers.size || 1;
    return { nodeId, lines: rlines, capsule: { kind: 'rectRows', box: S, groups: seat.groups, connectors: seat.connectors }, anchor: [cx / n, cy / n], dotRadius: RCAP };
  }
```

  Add imports at top: `import { rectSeat } from '../layout/rectSeat';` and ensure `Point` is imported.
  (Mega and single-line stops fall through to the existing box / `none` paths unchanged.)

- [ ] **Step 3: Write test** (`placement.rect.test.ts`): a 2-mark node with `home`/`axis`
  and `capsuleMode:'rectRows'` yields `capsule.kind==='rectRows'`, non-empty `lines`, and
  `groups.length>=1`; the same marks with `capsuleMode` unset yield `kind==='pill'`.

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** (`feat(stations): buildScene emits rectRows via rectSeat when the design asks`).

---

## Task 5: `renderOctilinear` — record home/axis, thread capsule mode

**Files:** Modify `src/render/renderOctilinear.ts`.

- [ ] **Step 1: Extend the `StMarks` mark type** (interface ~1057-1067) with `home?: Pixel; axis?: number;`.

- [ ] **Step 2: Capture home (pre-solve)** at the top of the `else if (s.marks.length > 1)`
  block (line ~1325, before `const curves`):

```ts
      } else if (s.marks.length > 1) {
        for (const mk of s.marks) if (mk.home === undefined) mk.home = [mk.pos[0], mk.pos[1]];
```

  The `undefined` guard keeps the ORIGINAL pre-solve position when a split unit is re-queued.

- [ ] **Step 3: Capture axis** right after `markAxis` is computed (line ~1349):

```ts
        s.marks.forEach((mk, i) => { if (mk.axis === undefined) mk.axis = markAxis[i]; });
```

- [ ] **Step 4: Carry home/axis into `stopsByNode`.** Extend `addStop` (line 989) with two
  params and write them onto the pushed object:

```ts
  const addStop = (
    lineId: string, color: string, nodeId: string, pos: Pixel,
    chain?: number, cornerAfter?: Pixel, mega?: boolean, home?: Pixel, axis?: number,
  ) => {
    ...
    stopsByNode.get(nodeId)!.push({
      lineId, color, pos, name: lineById.get(lineId)?.label, textColor: lineById.get(lineId)?.textColor,
      seq: ..., chain, cornerAfter, mega, home, axis,
    });
  };
```

  And at the flush (line 2806): `addStop(m.lineId, m.color, s.nodeId, m.pos, m.chain, m.cornerAfter, m.mega, m.home, m.axis);`

- [ ] **Step 5: Thread capsule mode to `renderStations`.** In `paintRibbons` (the
  `renderStations(...)` call ~3096), pass the resolved design so `renderStations` can read
  `design.capsule`. `renderStations` already receives `getStationDesign(args.stationDesign)`
  as its `design` arg, so no signature change is needed — it forwards `design.capsule` to
  `buildScene` (done in Task 4 Step 1). Confirm no change required here beyond Task 4.

- [ ] **Step 6: Verify byte-identity for pill designs.** Run the byte-identity harness
  (`dev/_byte-identity.ts`) on the map dumps in Classic/smoothed: output must be unchanged
  (home/axis are additive and unread by pill `buildScene`). If the harness is absent, at
  minimum `npm test` stays green.

- [ ] **Step 7: Commit** (`feat(render): record interchange home/axis for rect seating (design-agnostic)`).

---

## Task 6: `tokyu.paint` — render rectRows

**Files:** Modify `src/render/stations/tokyu.ts`; update
`src/render/stations/tests/designs.test.ts`, `src/render/stations/index.test.ts` if needed.

- [ ] **Step 1: Set the capsule mode + preview**, and fix the stale keyline comment:

```ts
export const tokyu: StationDesign = { id: 'tokyu', name: 'Tokyu', capsule: 'rectRows', previewKind: 'interchange', paint };
```

- [ ] **Step 2: Rewrite the interchange branch** of `paint` to render the `rectRows` capsule
  (group capsules behind, connectors, then the boxes at each line's solved center):

```ts
function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const cap = scene.capsule;
  if (cap.kind === 'rectRows') {
    const s = cap.box;
    const capBg = ctx.dark ? '#27272a' : '#ffffff';
    const capBorder = ctx.dark ? '#5a5a5f' : '#c9c9c9';
    const g: Glyph[] = [];
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, gr.rx, { fill: capBg, stroke: capBorder, strokeWidth: +(s * 0.045).toFixed(2) }));
    for (const c of cap.connectors) for (let i = 1; i < c.points.length; i++)
      g.push(line(c.points[i - 1][0], c.points[i - 1][1], c.points[i][0], c.points[i][1], { stroke: capBorder, strokeWidth: s * 0.5 }));
    for (const ln of scene.lines) g.push(...square(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
    return g;
  }
  // single stop, degenerate interchange, or preview: one box per line at its pos
  const single = cap.kind === 'none' || scene.lines.length <= 1;
  const baseR = single ? scene.dotRadius : scene.dotRadius / MARKER_SCALE;
  const s = 3 * baseR;
  const g: Glyph[] = [];
  for (const ln of scene.lines) g.push(...square(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
  return g;
}
```

  Import `line` from `./primitives`. Note connectors are drawn BEFORE boxes so boxes sit on
  top; group capsules first so everything sits on top of them.

- [ ] **Step 3: Update `square()`'s doc comment** to drop the "thin keyline" wording (the
  keyline was already removed).

- [ ] **Step 4: Fix/extend tests.** In `designs.test.ts`, the existing tokyu interchange
  test builds a scene — update it to pass a `rectRows` capsule (box + one group + no
  connectors) and assert the group rect + one box per line are emitted. Keep the single-stop
  test. Ensure `index.test.ts` still lists `tokyu`.

- [ ] **Step 5: Run `npm test`, verify pass.**
- [ ] **Step 6: Commit** (`feat(stations): Tokyu renders the rectRows capsule (rows + octilinear connectors)`).

---

## Task 7: Render an example + final verification

- [ ] **Step 1:** Write a scratch render script `dev/_tokyu-rect.ts` (gitignored pattern):
  render a real dump's `inputDump` via `generateSchematicSVG` in smoothed mode with
  `stationDesign: 'tokyu'`, rasterize a cropped region of a busy interchange with resvg to
  `dev/_tokyu-rect.png` (mirror the earlier `_tokyu-render.ts` shape; crop args fx/fy/fs).
- [ ] **Step 2:** Run it on the NYC extracted input; open the PNG; check: boxes upright,
  interchanges form aligned rows, connectors are single octilinear segments, numbers present.
- [ ] **Step 3:** Run full `npm test` (all green) and, if available, the byte-identity harness
  in Classic mode (unchanged).
- [ ] **Step 4:** Surface the PNG to the user. Clean up the scratch script/PNG after.

---

## Self-review notes

- **Spec coverage:** upright boxes (Task 6), axis-adaptive rows (Task 3 step 1), Σslide+½·max-slide
  crossover (Task 3 cost `K`), octilinear-polyline connectors incl. dead-zone 2-segment (Task 2),
  dedicated solver at placement layer (Tasks 3-5), pill mode untouched (Task 5 byte-identity),
  cropping deferred (not in plan).
- **Out of scope (documented):** shape-aware line cropping; cross-station box overlap; label
  re-anchoring to rect centroids (labels still key off pill positions — acceptable v1); mapCache
  schema bump for the new `home`/`axis` fields (optional fields; note if a test needs it).
- **Determinism:** every solver sort/tie-break is index- or id-based; no `Math.random`/`Date`.
