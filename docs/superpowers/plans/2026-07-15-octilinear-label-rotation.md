# Octilinear label rotation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let station labels rotate to octilinear angles ({0, ±45, −90}) so they slot into
space a flat label cannot, cutting overlaps in dense areas, while staying as flat as the
geometry allows and going fully sideways only as a last resort.

**Architecture:** New pure OBB/tilt geometry module (`labelGeom.ts`). `placeLabels` gains
rotated candidates scored by a screen-tilt penalty on top of the existing collision cost,
places stations in a per-bundle walk (derived from stop `seq`) with a same-side neighbor
bonus, and stores each footprint as `{ box | obb, angle }` so flat candidates keep the exact
existing code path. `renderLabel` and the canvas honor an optional `angle`. All new angles are
fixed cos/sin literals (deterministic). `OCTI_LABEL_NO_ROTATE=1` restores the full legacy path.

**Tech stack:** TypeScript, Node built-in test runner (`npm test` = `tsx --test`), esbuild via
`npm run build`. Determinism gate: byte-identical SVG; no runtime trig in the SVG-producing path.

**Spec:** `docs/superpowers/specs/2026-07-15-octilinear-label-rotation-design.md`

---

## Task 1: OBB + tilt geometry module

**Files:**
- Create: `src/render/labelGeom.ts`
- Test: `src/render/tests/labelGeom.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/render/tests/labelGeom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trig, obbFromLocalBox, obbOverlap, segmentIntersectsObb, tilt } from '../labelGeom';
import { boxesOverlap } from '../labels';

const boxObb = (b: { x: number; y: number; w: number; h: number }) =>
  obbFromLocalBox([b.x, b.y], 0, 0, b.w, b.h, 0);

test('trig gives exact literals for the renderable angles', () => {
  assert.deepEqual(trig(0), { c: 1, s: 0 });
  assert.deepEqual(trig(90), { c: 0, s: 1 });
  assert.deepEqual(trig(-90), { c: 0, s: -1 });
  assert.equal(trig(45).c, 0.7071067811865476);
  assert.equal(trig(-45).s, -0.7071067811865476);
});

test('obbOverlap on axis-aligned boxes agrees with boxesOverlap (incl. touching = clear)', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const over = { x: 5, y: 5, w: 10, h: 10 };
  const apart = { x: 20, y: 20, w: 5, h: 5 };
  const touch = { x: 10, y: 0, w: 5, h: 10 };
  for (const b of [over, apart, touch]) {
    assert.equal(obbOverlap(boxObb(a), boxObb(b)), boxesOverlap(a, b));
  }
});

test('a 90-degree box is the flat box with width/height swapped', () => {
  // flat wide box centered on origin vs a tall thin flat box: disjoint...
  const flatWide = obbFromLocalBox([0, 0], -20, -5, 20, 5, 0);   // 40 x 10
  const tallThin = obbFromLocalBox([100, 0], -5, -20, 5, 20, 0); // 10 x 40, far away
  assert.equal(obbOverlap(flatWide, tallThin), false);
  // ...but rotating the wide box 90 about its center makes it tall (10 x 40),
  // which now reaches a box above it that the flat version missed.
  const above = obbFromLocalBox([0, -18], -5, -3, 5, 3, 0);
  assert.equal(obbOverlap(flatWide, above), false);
  const rotated = obbFromLocalBox([0, 0], -20, -5, 20, 5, -90);
  assert.equal(obbOverlap(rotated, above), true);
});

test('segmentIntersectsObb hits a rotated box a flat test would miss', () => {
  const obb = obbFromLocalBox([0, 0], 0, -4, 40, 4, 45); // diagonal band
  assert.equal(segmentIntersectsObb([10, 10], [20, 20], obb), true);   // along the diagonal
  assert.equal(segmentIntersectsObb([40, -40], [50, -50], obb), false); // well off it
});

test('tilt: flat free, 45 cheap, 90 a strong last resort', () => {
  assert.equal(tilt(0), 0);
  assert.equal(tilt(45), 4);
  assert.equal(tilt(-45), 4);
  assert.equal(tilt(90), 35);
  assert.equal(tilt(-90), 35);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test src/render/tests/labelGeom.test.ts`
Expected: FAIL — cannot find module `../labelGeom`.

- [ ] **Step 3: Implement `labelGeom.ts`**

```ts
// src/render/labelGeom.ts
// Oriented-bounding-box (OBB) geometry for rotated station labels, plus the
// screen-tilt penalty. Only the fixed octilinear angles occur, so cos/sin are
// exact literal constants: no runtime trig, so the SVG output stays deterministic
// cross-V8. Marker and station boxes stay axis-aligned; only a label box rotates.

import type { Pixel } from './layout/types';

/** cos/sin for the label angles that can render (degrees, screen space, y-down). */
export function trig(angleDeg: number): { c: number; s: number } {
  const H = 0.7071067811865476; // cos 45 = sin 45, fixed literal
  switch (angleDeg) {
    case 45: return { c: H, s: H };
    case -45: return { c: H, s: -H };
    case 90: return { c: 0, s: 1 };
    case -90: return { c: 0, s: -1 };
    default: return { c: 1, s: 0 }; // 0 and any non-rotating value
  }
}

export interface Obb {
  corners: [Pixel, Pixel, Pixel, Pixel];
}

/** OBB for a text box whose local rectangle is [x0,x1] by [y0,y1] relative to the
 *  pivot (the text origin), rotated angleDeg about the pivot. */
export function obbFromLocalBox(pivot: Pixel, x0: number, y0: number, x1: number, y1: number, angleDeg: number): Obb {
  const { c, s } = trig(angleDeg);
  const rot = (dx: number, dy: number): Pixel => [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c];
  return { corners: [rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)] };
}

/** Axis-aligned bounds of an OBB (used for the crowding tiebreak). */
export function obbAabb(obb: Obb): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of obb.corners) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** SAT overlap of two convex quads. Touching edges count as NOT overlapping, so
 *  an axis-aligned pair reproduces boxesOverlap's half-open convention exactly. */
function satOverlap(a: Pixel[], b: Pixel[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const nx = -(p2[1] - p1[1]);
      const ny = p2[0] - p1[0];
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const q of a) { const d = q[0] * nx + q[1] * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const q of b) { const d = q[0] * nx + q[1] * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

export function obbOverlap(a: Obb, b: Obb): boolean {
  return satOverlap(a.corners, b.corners);
}

/** Whether segment p1->p2 meets the OBB: an endpoint inside, or a crossing of any edge. */
export function segmentIntersectsObb(p1: Pixel, p2: Pixel, obb: Obb): boolean {
  const poly = obb.corners;
  if (pointInConvex(p1, poly) || pointInConvex(p2, poly)) return true;
  for (let i = 0; i < 4; i++) if (segCross(p1, p2, poly[i], poly[(i + 1) % 4])) return true;
  return false;
}

function pointInConvex(pt: Pixel, poly: Pixel[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cr = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
    if (cr !== 0) { const s = cr > 0 ? 1 : -1; if (sign === 0) sign = s; else if (s !== sign) return false; }
  }
  return true;
}

function segCross(a: Pixel, b: Pixel, c: Pixel, d: Pixel): boolean {
  const cross = (o: Pixel, p: Pixel, q: Pixel) => (q[1] - o[1]) * (p[0] - o[0]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Screen-tilt penalty. Flat is free, 45 is cheap, 90 (sideways) is a strong last
 *  resort. Tunable at the visual checkpoint; 90 above the marker cost (30) keeps a
 *  station tolerating a marker overlap rather than turning sideways. */
export function tilt(angleDeg: number): number {
  const a = Math.abs(angleDeg);
  return a === 0 ? 0 : a === 90 ? 35 : 4;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test src/render/tests/labelGeom.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit** (only if the user has asked for commits)

```bash
git add src/render/labelGeom.ts src/render/tests/labelGeom.test.ts
git commit -F <msg-file>   # "feat(labels): OBB + tilt geometry for rotated labels"
```

---

## Task 2: `Placement.angle` and SVG rotation in `renderLabel`

**Files:**
- Modify: `src/render/labels.ts` (`Placement` interface; `renderLabel`)
- Test: `src/render/tests/labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/render/tests/labels.test.ts
import { renderLabel } from '../labels';

test('renderLabel emits rotate() only when angle is nonzero', () => {
  const flat = renderLabel({ id: 'n', label: 'Foo' }, { x: 10, y: 20, anchor: 'start' }, [10, 20], true, false);
  assert.ok(!flat.includes('rotate('), 'flat label has no rotate, byte-identical to today');
  const rot = renderLabel({ id: 'n', label: 'Foo' }, { x: 10, y: 20, anchor: 'start', angle: -45 }, [10, 20], true, false);
  assert.ok(rot.includes('rotate(-45)'), 'rotated label carries the transform');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: FAIL — `angle` not on `Placement` (type error) / no `rotate(` in output.

- [ ] **Step 3: Add `angle` to `Placement` and emit the transform**

In `src/render/labels.ts`, extend the interface:

```ts
export interface Placement {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** Screen rotation in degrees about the text origin; absent/0 = flat (today). */
  angle?: number;
}
```

In `renderLabel`, compute the transform and reuse it for the SVG group (leave the
`prims` block for Task 3):

```ts
const angle = placement.angle ?? 0;
const xf =
  'translate(' + placement.x.toFixed(1) + ',' + placement.y.toFixed(1) + ')' +
  (angle !== 0 ? ' rotate(' + angle + ')' : '');
```

Replace the group's `transform="translate(...)"` string with `'" transform="' + xf + '">'`
(so when `angle` is 0 the emitted string is byte-identical to today).

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (if asked) — `git add src/render/labels.ts src/render/tests/labels.test.ts` / "feat(labels): Placement.angle emits an SVG rotate() transform".

---

## Task 3: `TextPrim.angle` and canvas rotation

**Files:**
- Modify: `src/render/sceneIR.ts` (`TextPrim`)
- Modify: `src/render/labels.ts` (`renderLabel` prim push)
- Modify: `src/render/sceneCanvas.ts` (label draw loop)
- Test: `src/render/tests/labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/render/tests/labels.test.ts
import type { Prim } from '../sceneIR';

test('renderLabel pushes a text prim carrying the angle only when rotated', () => {
  const flat: Prim[] = [];
  renderLabel({ id: 'n', label: 'Foo' }, { x: 1, y: 2, anchor: 'start' }, [1, 2], true, false, flat);
  assert.equal((flat[0] as { angle?: number }).angle, undefined);
  const rot: Prim[] = [];
  renderLabel({ id: 'n', label: 'Foo' }, { x: 1, y: 2, anchor: 'start', angle: 90 }, [1, 2], true, false, rot);
  assert.equal((rot[0] as { angle?: number }).angle, 90);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: FAIL — prim has no `angle`.

- [ ] **Step 3: Implement**

`src/render/sceneIR.ts` — add to `TextPrim` (optional, so no scene-schema bump and
angle-0 prims stay identical):

```ts
  /** Screen rotation in degrees about the text origin; absent = flat. */
  angle?: number;
```

`src/render/labels.ts` — in the `prims.push({ kind: 'text', ... })` object, append the
angle only when nonzero so existing scene emission is byte-identical:

```ts
      worldScale: false,
      ...(angle !== 0 ? { angle } : {}),
```

`src/render/sceneCanvas.ts` — in the `for (const label of prepared.labels)` loop, honor
the angle. Canvas is display-only (not the deterministic SVG artifact), so runtime trig is
fine here:

```ts
    ctx.fillStyle = label.fill;
    const ox = label.ax + label.x * ls;
    const oy = label.ay + label.y * ls;
    if (label.angle) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate((label.angle * Math.PI) / 180);
      ctx.fillText(label.text, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(label.text, ox, oy);
    }
```

(The angle-0 branch calls `fillText` at the same coordinates as today, so unrotated paint
is unchanged.)

- [ ] **Step 4: Run tests and confirm they pass**

Run: `npx tsx --test "src/render/**/*.test.ts"`
Expected: PASS (existing scene tests still green; new prim test passes).

- [ ] **Step 5: Commit** (if asked) — "feat(render): text prim + canvas honor an optional label angle".

---

## Task 4: bundle-walk order from stop sequence

**Files:**
- Modify: `src/render/labels.ts` (new exported pure helper `bundleOrder`)
- Test: `src/render/tests/labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/render/tests/labels.test.ts
import { bundleOrder } from '../labels';

test('bundleOrder walks each line in seq order and chains predecessors', () => {
  const nodes = [
    { id: 'a', label: 'AAelong' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'CC' },
  ];
  const stops = new Map([
    ['a', [{ lineId: 'L', color: '#000', pos: [0, 0] as Pixel, seq: 0 }]],
    ['b', [{ lineId: 'L', color: '#000', pos: [0, 0] as Pixel, seq: 1 }]],
    ['c', [{ lineId: 'L', color: '#000', pos: [0, 0] as Pixel, seq: 2 }]],
  ]);
  const { order, prevOnBundle } = bundleOrder(nodes, stops);
  assert.deepEqual(order.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(prevOnBundle.get('b'), 'a');
  assert.equal(prevOnBundle.get('c'), 'b');
  assert.equal(prevOnBundle.get('a'), undefined);
});

test('bundleOrder tails unsequenced nodes longest-label-first (today order)', () => {
  const nodes = [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'YYYY' },
  ];
  const stops = new Map<string, StopMark[]>(); // no seq/lineId anywhere
  const { order, prevOnBundle } = bundleOrder(nodes, stops);
  assert.deepEqual(order.map((n) => n.id), ['y', 'x']);
  assert.equal(prevOnBundle.size, 0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: FAIL — `bundleOrder` not exported.

- [ ] **Step 3: Implement `bundleOrder` in `labels.ts`**

```ts
/**
 * Placement order plus each node's on-bundle predecessor, derived from the stop
 * marks alone. Stations are walked line by line (lines in id order) in stop-seq
 * order, so a node's on-bundle neighbor is placed just before it; nodes without a
 * seq (e.g. the geographic caller's synthetic stops) tail the list longest-label
 * first, reproducing the previous global order for that caller. Deterministic:
 * lines sorted by id, seq ties broken by node id. Pure.
 */
export function bundleOrder(
  nodes: LabelNode[],
  stopsByNode: Map<string, StopMark[]>,
): { order: LabelNode[]; prevOnBundle: Map<string, string> } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const perLine = new Map<string, Array<{ nodeId: string; seq: number }>>();
  for (const n of nodes) {
    for (const m of stopsByNode.get(n.id) ?? []) {
      if (m.seq == null || !m.lineId) continue;
      let arr = perLine.get(m.lineId);
      if (!arr) perLine.set(m.lineId, (arr = []));
      arr.push({ nodeId: n.id, seq: m.seq });
    }
  }
  const order: LabelNode[] = [];
  const seen = new Set<string>();
  const prevOnBundle = new Map<string, string>();
  for (const lineId of [...perLine.keys()].sort()) {
    const seq = perLine.get(lineId)!.sort((a, b) => a.seq - b.seq || (a.nodeId < b.nodeId ? -1 : 1));
    let prev: string | null = null;
    for (const { nodeId } of seq) {
      if (prev != null && !prevOnBundle.has(nodeId)) prevOnBundle.set(nodeId, prev);
      if (!seen.has(nodeId)) { seen.add(nodeId); order.push(byId.get(nodeId)!); }
      prev = nodeId;
    }
  }
  for (const n of nodes.filter((n) => !seen.has(n.id)).sort((a, b) => b.label.length - a.label.length)) {
    order.push(n);
  }
  return { order, prevOnBundle };
}
```

(`StopMark` is already imported in `labels.ts`; it carries `lineId` and `seq`.)

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (if asked) — "feat(labels): derive per-bundle placement order from stop seq".

---

## Task 5: rotated candidates + tilt scoring + `OCTI_LABEL_NO_ROTATE`

**Files:**
- Modify: `src/render/labels.ts` (`placeLabels` body)
- Test: `src/render/tests/labels.test.ts`

This task adds rotation but keeps today's longest-first order (the neighbor bonus arrives in
Task 6), so its behavior is easy to assert.

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/render/tests/labels.test.ts
const ANGLES = new Set([0, 45, -45, -90]);

test('every placement uses only never-upside-down octilinear angles', () => {
  const graph = lineGraph([[0, 0], [200, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [200, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L1', color: '#f00', pos: [0, 0] }]],
    ['n1', [{ lineId: 'L1', color: '#f00', pos: [200, 0] }]],
  ]);
  for (const p of placeLabels(graph, nodePx, stops, []).values()) {
    assert.ok(ANGLES.has(p.angle ?? 0));
  }
});

test('a lone label with room stays flat (flat when it fits)', () => {
  const graph = lineGraph([[0, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n0', [{ lineId: 'L', color: '#000', pos: [0, 0] }]]]);
  assert.equal(placeLabels(graph, nodePx, stops, []).get('n0')!.angle ?? 0, 0);
});

test('placeLabels is deterministic (same input, same placements twice)', () => {
  const graph = lineGraph([[0, 0], [30, 0], [60, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [30, 0]], ['n2', [60, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['n1', [{ lineId: 'L', color: '#000', pos: [30, 0], seq: 1 }]],
    ['n2', [{ lineId: 'L', color: '#000', pos: [60, 0], seq: 2 }]],
  ]);
  const a = [...placeLabels(graph, nodePx, stops, []).entries()];
  const b = [...placeLabels(graph, nodePx, stops, []).entries()];
  assert.deepEqual(a, b);
});

test('OCTI_LABEL_NO_ROTATE=1 keeps every label flat', () => {
  process.env.OCTI_LABEL_NO_ROTATE = '1';
  try {
    const graph = lineGraph([[0, 0], [8, 0]]); // deliberately cramped
    const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [8, 0]]]);
    const stops = new Map<string, StopMark[]>([
      ['n0', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
      ['n1', [{ lineId: 'L', color: '#000', pos: [8, 0], seq: 1 }]],
    ]);
    for (const p of placeLabels(graph, nodePx, stops, []).values()) {
      assert.equal(p.angle ?? 0, 0);
    }
  } finally {
    delete process.env.OCTI_LABEL_NO_ROTATE;
  }
});
```

- [ ] **Step 2: Run and confirm the new tests fail**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: FAIL — `angle` is never set (all undefined passes the flat tests but the
never-upside-down set test still passes trivially; the real failure is the type/behavior once
Step 3 lands). Confirm the suite is green BEFORE Step 3 except where you assert rotation; if a
test cannot fail pre-implementation, note it and rely on Task 6 / the checkpoint for the
rotation-positive assertion. (The crowded-scenario positive test lives in Task 6.)

- [ ] **Step 3: Rewrite the `placeLabels` per-node loop**

Add near the top of `labels.ts`:

```ts
import { obbFromLocalBox, obbAabb, obbOverlap, segmentIntersectsObb, tilt, type Obb } from './labelGeom';

/** A label footprint: axis-aligned box (angle 0, the legacy path) or an OBB. */
interface Footprint { angle: number; box?: Box; obb?: Obb; }
const boxToObb = (b: Box): Obb => obbFromLocalBox([b.x, b.y], 0, 0, b.w, b.h, 0);
const asObb = (f: Footprint): Obb => f.obb ?? boxToObb(f.box!);
const fpOverlap = (a: Footprint, b: Footprint): boolean =>
  a.angle === 0 && b.angle === 0 ? boxesOverlap(a.box!, b.box!) : obbOverlap(asObb(a), asObb(b));
const fpSeg = (a: Footprint, s: Segment): boolean =>
  a.angle === 0 ? segmentIntersectsBox(s.p1, s.p2, a.box!) : segmentIntersectsObb(s.p1, s.p2, a.obb!);
const fpAabb = (f: Footprint): Box => f.box ?? obbAabb(f.obb!);
```

Extend `Candidate` to carry the footprint and angle:

```ts
interface Candidate { placement: Placement; fp: Footprint; priority: number; }
```

In `placeLabels`, read the flag and choose the order:

```ts
  const noRotate = envStr('OCTI_LABEL_NO_ROTATE') === '1';
  // ...existing stationBoxes build stays...
  const placed: Footprint[] = [];              // was placedBoxes: Box[]
  const stations: Footprint[] = stationBoxes.map((b) => ({ angle: 0, box: b }));
  const withStops = [...graph.nodes.values()].filter((n) => stopsByNode.has(n.id));
  const order = noRotate
    ? withStops.sort((a, b) => b.label.length - a.label.length)
    : withStops.sort((a, b) => b.label.length - a.label.length); // Task 6 replaces this with bundleOrder
```

Per node, build flat candidates exactly as today (each `fp = { angle: 0, box }`, priority
1/2/3), then, when `!noRotate`, append the rotated candidates:

```ts
    const rot = (ox: number, oy: number, angle: number, anchor: Placement['anchor']): Candidate => {
      const x0 = anchor === 'end' ? -tw : anchor === 'middle' ? -tw / 2 : 0;
      const obb = obbFromLocalBox([ox, oy], x0, -fh / 2, x0 + tw, fh / 2, angle);
      return { placement: { x: ox, y: oy, anchor, angle }, fp: { angle, obb }, priority: 1 };
    };
    const rotated: Candidate[] = noRotate ? [] : [
      rot(cx + off, cy, -90, 'start'),
      rot(cx - off, cy, -90, 'start'),
      rot(cx + off * 0.7, cy - off * 0.7, -45, 'start'),
      rot(cx + off * 0.7, cy + off * 0.7, 45, 'start'),
      rot(cx - off * 0.7, cy - off * 0.7, 45, 'end'),
      rot(cx - off * 0.7, cy + off * 0.7, -45, 'end'),
    ];
    const candidates = [...flatCandidates, ...rotated];
```

Scoring: replace the box loops with footprint-aware ones and add the tilt term:

```ts
    for (const cand of candidates) {
      let cost = 0;
      for (const f of placed) if (fpOverlap(cand.fp, f)) cost += 100;
      for (const f of stations) if (fpOverlap(cand.fp, f)) cost += 30;
      for (const s of segments) if (fpSeg(cand.fp, s)) cost += 12;
      cost += cand.priority;
      cost += tilt(cand.fp.angle);
      const crowd = LABEL_TIEBREAK ? crowding(fpAabb(cand.fp)) : 0;
      if (cost < bestCost || (LABEL_TIEBREAK && cost === bestCost && crowd < bestCrowd)) {
        bestCost = cost; bestCrowd = crowd; best = cand;
      }
    }
    placed.push(best.fp);
    result.set(node.id, best.placement);
```

Update `crowding` to take a `Box` (it already does) and to read `placed`/`stations`
footprints via `fpAabb`:

```ts
  const crowding = (box: Box): number => {
    let c = 0;
    for (const f of placed) { const g = boxGap(box, fpAabb(f)); if (g < CLEAR_MARGIN) c += CLEAR_MARGIN - g; }
    for (const f of stations) { const g = boxGap(box, fpAabb(f)); if (g < CLEAR_MARGIN) c += CLEAR_MARGIN - g; }
    return c;
  };
```

Keep the flat candidate construction byte-identical to today (same 8 boxes, same priorities);
only the container type changes from `Box` to `{ angle: 0, box }`.

- [ ] **Step 4: Run the whole render suite**

Run: `npx tsx --test "src/render/**/*.test.ts"`
Expected: PASS. The existing `placeLabels assigns a placement per station` test still passes;
new flat/determinism/flag tests pass.

- [ ] **Step 5: Commit** (if asked) — "feat(labels): rotated label candidates scored by screen tilt; OCTI_LABEL_NO_ROTATE".

---

## Task 6: per-bundle order + same-side neighbor bonus

**Files:**
- Modify: `src/render/labels.ts` (`placeLabels`: order + side term)
- Test: `src/render/tests/labels.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/render/tests/labels.test.ts

// A cross of line segments boxes the node horizontally but leaves a vertical gap;
// the packer must reach for a non-flat angle to escape the hard overlaps.
test('a horizontally boxed-in label rotates off flat', () => {
  const graph = lineGraph([[0, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n0', [{ lineId: 'L', color: '#000', pos: [0, 0] }]]]);
  // dense horizontal segments on both flat flanks, vertical corridor left open
  const segs: Segment[] = [];
  for (let y = -60; y <= 60; y += 6) segs.push({ p1: [8, y], p2: [80, y] }, { p1: [-80, y], p2: [-8, y] });
  const angle = placeLabels(graph, nodePx, stops, segs).get('n0')!.angle ?? 0;
  assert.notEqual(angle, 0);
});

test('a run of stations on one line labels to a consistent side', () => {
  const graph = lineGraph([[0, 0], [0, 40], [0, 80]]); // vertical line
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [0, 40]], ['n2', [0, 80]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['n1', [{ lineId: 'L', color: '#000', pos: [0, 40], seq: 1 }]],
    ['n2', [{ lineId: 'L', color: '#000', pos: [0, 80], seq: 2 }]],
  ]);
  const pl = placeLabels(graph, nodePx, stops, []);
  const sideOf = (id: string) => Math.sign(pl.get(id)!.x - nodePx.get(id)![0]);
  assert.equal(sideOf('n1'), sideOf('n0'));
  assert.equal(sideOf('n2'), sideOf('n1'));
});
```

- [ ] **Step 2: Run and confirm the side test fails**

Run: `npx tsx --test src/render/tests/labels.test.ts`
Expected: the consistent-side test FAILS (order is still longest-first, no side bonus); the
boxed-in test should already pass from Task 5.

- [ ] **Step 3: Wire in `bundleOrder` and the side term**

Replace the order line from Task 5 with the bundle walk, and track chosen sides:

```ts
  const nodesWithStops = [...graph.nodes.values()].filter((n) => stopsByNode.has(n.id));
  const { order, prevOnBundle } = noRotate
    ? { order: nodesWithStops.sort((a, b) => b.label.length - a.label.length), prevOnBundle: new Map<string, string>() }
    : bundleOrder(nodesWithStops, stopsByNode);
  const chosenSide = new Map<string, number>(); // nodeId -> -1 | 0 | 1
  const WSIDE = 5;
```

Compute each candidate's side relative to the on-bundle predecessor's line direction, and add
the mismatch penalty inside the scoring loop:

```ts
    const prevId = prevOnBundle.get(node.id);
    const prevP = prevId ? nodePx.get(prevId) : undefined;
    const prevSide = prevId != null ? chosenSide.get(prevId) ?? 0 : 0;
    const sideOf = (pl: Placement): number => {
      if (!prevP) return 0;
      const dirx = p[0] - prevP[0], diry = p[1] - prevP[1];      // local line direction
      const offx = pl.x - cx, offy = pl.y - cy;                  // label offset from the dot
      const cr = dirx * offy - diry * offx;                      // which side of the line
      return cr > 0 ? 1 : cr < 0 ? -1 : 0;
    };
```

In the cost loop add:

```ts
      const side = sideOf(cand.placement);
      if (prevSide !== 0 && side !== 0 && side !== prevSide) cost += WSIDE;
```

After choosing `best`, record its side so successors can match it:

```ts
    chosenSide.set(node.id, sideOf(best.placement));
```

- [ ] **Step 4: Run the suite and confirm green**

Run: `npx tsx --test "src/render/**/*.test.ts"`
Expected: PASS (consistent-side + boxed-in + all earlier tests).

- [ ] **Step 5: Commit** (if asked) — "feat(labels): per-bundle placement order with a same-side neighbor bonus".

---

## Task 7: Verification checkpoint

**Files:** none (verification + tuning only)

- [ ] **Step 1: Full test gate**

Run: `npm test`
Expected: all tests pass (0 fail), including the ~11 new label/geom tests.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: esbuild succeeds and installs the mod (JSX/type-free transpile; no gate on `tsc`).

- [ ] **Step 3: Legacy byte-identity (background)**

With `OCTI_LABEL_NO_ROTATE=1`, render every `improvedschematics-map-*.json` dump in both modes
via `dev/_byte-identity.ts` and diff against master's output for the same dumps. Expected:
byte-identical (the flag runs the legacy code path). Renders are slow; run in the background.

- [ ] **Step 4: Visual before/after (decision point)**

Rasterize a dense dump (e.g. the busiest available) to PNG via the dev harness, once on master
and once on this branch (rotation on). Surface both to the user. Confirm: sideways labels are
rare, bundle ladders read consistently, overlaps are down. This is the point to tune
`tilt(90)` (fewer/more sideways) and `WSIDE` (stronger/weaker side coherence) in
`labelGeom.ts` / `labels.ts` and re-render.

- [ ] **Step 5: Report** overlap-count and sideways-label-count before/after, plus the flag's
byte-identity result, and hand the tuning knobs to the user.

---

## Self-review notes

- **Spec coverage:** angle set {0,±45,−90} (Task 5); flat-when-fits (Task 5 test); aggressive
  declutter via dominant collision weights + tilt ladder (Task 5); same-bundle-same-side via
  bundle order + neighbor bonus (Tasks 4/6); determinism via fixed trig literals (Task 1);
  legacy repro via `OCTI_LABEL_NO_ROTATE` (Task 5); rendering via `angle` on placement/prim
  (Tasks 2/3). All spec sections map to a task.
- **Type consistency:** `Footprint` (Task 5) is the single container used by `placed`,
  `stations`, `fpOverlap`, `fpSeg`, `fpAabb`, `crowding`; `Candidate.fp` is a `Footprint`;
  `bundleOrder` returns `{ order: LabelNode[]; prevOnBundle: Map<string,string> }` consumed
  verbatim in Task 6.
- **Byte-identity:** flat candidates keep `{ angle: 0, box }` and run `boxesOverlap` /
  `segmentIntersectsBox`; `renderLabel` and the text prim only diverge from today when
  `angle !== 0`; the geographic caller has no `seq`, so `bundleOrder` tails it in the old
  longest-first order. Legacy flag path is old-order + flat-only.
- **Watch-items (from the spec):** order-change churn on dense maps; too-many-sideways
  (`tilt(90)` knob); rotated-label cutout hiding in detail insets uses the unrotated
  `labelWorldBox` AABB (display-only, acceptable; revisit only if it reads wrong).
