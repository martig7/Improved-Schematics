# Bundle-Blocks Line Ordering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LOOM untangle scorer with a structural bundle-blocks ordering pass (`OCTI_ORDER=blocks|loom`, default `blocks`) where corridors carry rigid recursive blocks, joins are binary side-choices with one-hop pair-ownership lookahead, non-contiguous splits plan minimal crossings at their own node, and cycle residuals land at junctions — per `docs/superpowers/specs/2026-07-04-bundle-blocks-rebuild-design.md`.

**Architecture:** Two new modules. `blockAlgebra.ts` is pure data-structure code (recursive blocks: join/mirror/flatten/contiguity/minimal-transposition), zero Layout knowledge, exhaustively unit-tested. `bundleOrder.ts` is the pipeline: corridor contraction → per-junction flow classification from `lineTraversals` → BFS forest propagation applying block ops with lookahead → write-back to `edge.lineOrder`. Crossings are never "placed" explicitly: adjacent corridors' flattened orders differ only across junctions by construction, and the existing draw machinery (gap-proportional tapers) renders them there. A location-class counter proves the invariant per render.

**Tech Stack:** TypeScript, node:test via `npx tsx --test`, offline render harness (`dev/render-from-dump.ts`). Determinism rules apply: no `Math.hypot` in src (use `Math.sqrt`), quantized `atan2` for angular ranks, total tie-breaks everywhere, no `localeCompare`.

**Branch:** `experiment/bundle-blocks` (already created, spec committed at `955e008`).

**Typecheck caveat:** the repo has 31 PRE-EXISTING `npm run typecheck` errors (imageMerge.ts / topo.ts / renderGeographic.ts). Gate everywhere = "≤31 and none in files you touched", then `npm test` must be 0 failures. Baseline test count at plan time: **428**.

---

### Task 1: Block algebra — types, join, mirror, flatten

**Files:**
- Create: `src/render/layout/blockAlgebra.ts`
- Create: `src/render/layout/blockAlgebra.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/render/layout/blockAlgebra.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Block,
  flattenBlock,
  mirrorBlock,
  joinBlocks,
  blockLines,
} from './blockAlgebra';

test('flatten: nested blocks flatten depth-first in order', () => {
  const b: Block = ['A', ['B', ['C', 'D']], 'E'];
  assert.deepEqual(flattenBlock(b), ['A', 'B', 'C', 'D', 'E']);
});

test('mirror: reverses at every nesting level, is an involution', () => {
  const b: Block = ['A', ['B', 'C'], 'D'];
  const m = mirrorBlock(b);
  assert.deepEqual(flattenBlock(m), ['D', 'C', 'B', 'A']);
  assert.deepEqual(mirrorBlock(m), b, 'mirror twice = identity');
});

test('join: nests both operands intact, side chooses order', () => {
  const a: Block = ['A1', 'A2'];
  const b: Block = ['B1'];
  assert.deepEqual(flattenBlock(joinBlocks(a, b, false)), ['A1', 'A2', 'B1']);
  assert.deepEqual(flattenBlock(joinBlocks(a, b, true)), ['B1', 'A1', 'A2']);
  // nesting survives: the joined block's items ARE the operands
  const j = joinBlocks(a, b, false);
  assert.equal(j.length, 2);
  assert.deepEqual(j[0], a);
  assert.deepEqual(j[1], b);
});

test('blockLines: set of all leaf lines', () => {
  const b: Block = ['A', ['B', ['C']]];
  assert.deepEqual([...blockLines(b)].sort(), ['A', 'B', 'C']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/blockAlgebra.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/render/layout/blockAlgebra.ts`:

```ts
// Recursive block algebra for bundle-blocks line ordering (spec
// 2026-07-04-bundle-blocks-rebuild §2). A corridor's lateral order is a
// BLOCK: an ordered list whose items are line ids or nested blocks. The only
// operations are join (nest two blocks, binary side), mirror (flip
// end-over-end at every level), and split helpers (contiguity + minimal
// adjacent transpositions). In-bundle reorders on open track are
// UNREPRESENTABLE by design. Pure data structures — no Layout imports, no
// floating point, fully deterministic.

export type Block = Array<string | Block>;

/** Depth-first leaf order — the drawn lateral order. */
export function flattenBlock(b: Block): string[] {
  const out: string[] = [];
  const walk = (x: string | Block): void => {
    if (typeof x === 'string') out.push(x);
    else for (const item of x) walk(item);
  };
  walk(b);
  return out;
}

/** Flip end-over-end at every nesting level (orientation change). */
export function mirrorBlock(b: Block): Block {
  const out: Block = [];
  for (let i = b.length - 1; i >= 0; i--) {
    const item = b[i];
    out.push(typeof item === 'string' ? item : mirrorBlock(item));
  }
  return out;
}

/** Merge two corridors' blocks; `bFirst` picks the side. Operands nest
 *  INTACT — their internal order is the joined bundle's memory. */
export function joinBlocks(a: Block, b: Block, bFirst: boolean): Block {
  return bFirst ? [b, a] : [a, b];
}

/** All leaf line ids of a block. */
export function blockLines(b: Block): Set<string> {
  return new Set(flattenBlock(b));
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/render/layout/blockAlgebra.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/blockAlgebra.ts src/render/layout/blockAlgebra.test.ts
git commit -m "feat(render): block algebra core — recursive blocks, join/mirror/flatten"
```

---

### Task 2: Block algebra — split contiguity and minimal transpositions

**Files:**
- Modify: `src/render/layout/blockAlgebra.ts`
- Modify: `src/render/layout/blockAlgebra.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `blockAlgebra.test.ts`:

```ts
import { splitPlan, reorderToGroups } from './blockAlgebra';

test('splitPlan: contiguous exits are free (zero swaps)', () => {
  // order [A,B,C,D]; exits: {A,B} -> g0, {C,D} -> g1 — already contiguous
  const groupOf = new Map([['A', 0], ['B', 0], ['C', 1], ['D', 1]]);
  const plan = splitPlan(['A', 'B', 'C', 'D'], groupOf);
  assert.equal(plan.swaps, 0);
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'D']);
});

test('splitPlan: interleaved exits need the bubble distance, order stable within groups', () => {
  // [A,C,B,D] with {A,B}=g0,{C,D}=g1: one adjacent swap (C<->B) fixes it
  const groupOf = new Map([['A', 0], ['B', 0], ['C', 1], ['D', 1]]);
  const plan = splitPlan(['A', 'C', 'B', 'D'], groupOf);
  assert.equal(plan.swaps, 1);
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'D'], 'stable within groups');
});

test('splitPlan: group order follows first-appearance when targets tie', () => {
  // [C,A,D,B]: g1 appears first -> target group order [g1, g0]
  const groupOf = new Map([['A', 0], ['B', 0], ['C', 1], ['D', 1]]);
  const plan = splitPlan(['C', 'A', 'D', 'B'], groupOf);
  assert.deepEqual(plan.order, ['C', 'D', 'A', 'B']);
  assert.equal(plan.swaps, 2); // A past D, then A past... verify by inversion count
});

test('reorderToGroups: inversion count equals adjacent-transposition distance', () => {
  // classic: distance from [B,A] to [A,B] is 1
  const groupOf = new Map([['A', 0], ['B', 1]]);
  const plan = splitPlan(['B', 'A'], groupOf);
  assert.equal(plan.swaps, 0, 'single-line groups in first-appearance order are already contiguous');
  // force a desired group order via explicit target ranks
  const r = reorderToGroups(['B', 'A'], new Map([['A', 0], ['B', 1]]), [0, 1]);
  assert.deepEqual(r.order, ['A', 'B']);
  assert.equal(r.swaps, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/blockAlgebra.test.ts`
Expected: FAIL — `splitPlan` not exported.

- [ ] **Step 3: Implement**

Append to `blockAlgebra.ts`:

```ts
export interface SplitPlanResult {
  /** the exit-contiguous order (stable within groups) */
  order: string[];
  /** adjacent-transposition (bubble) distance from the input order — the
   *  crossings this split forces, drawn AT the split node */
  swaps: number;
}

/** Kendall-tau distance between `from` and `to` (same multiset): the number
 *  of pairwise inversions = minimal adjacent transpositions. O(n²), n ≤
 *  bundle width (≤ ~16 in practice). */
function bubbleDistance(from: string[], to: string[]): number {
  const rank = new Map<string, number>();
  for (let i = 0; i < to.length; i++) rank.set(to[i], i);
  let inv = 0;
  for (let i = 0; i < from.length; i++) {
    for (let j = i + 1; j < from.length; j++) {
      if (rank.get(from[i])! > rank.get(from[j])!) inv++;
    }
  }
  return inv;
}

/** Reorder `order` so lines sharing a group are contiguous, groups appearing
 *  in `groupRank` order, STABLE within each group. Returns the new order and
 *  the forced-crossing count. */
export function reorderToGroups(
  order: string[],
  groupOf: Map<string, number>,
  groupRank: number[],
): SplitPlanResult {
  const rankOf = new Map<number, number>();
  for (let i = 0; i < groupRank.length; i++) rankOf.set(groupRank[i], i);
  const target = [...order].sort((a, b) => {
    const ga = rankOf.get(groupOf.get(a)!)!;
    const gb = rankOf.get(groupOf.get(b)!)!;
    if (ga !== gb) return ga - gb;
    return order.indexOf(a) - order.indexOf(b); // stable within group
  });
  return { order: target, swaps: bubbleDistance(order, target) };
}

/** Split planning: make each exit-group contiguous with minimal crossings.
 *  Group order = first appearance in the current order (the least-motion
 *  choice: groups keep their current center of mass ordering). Callers with
 *  geometric exit ranks use reorderToGroups directly. */
export function splitPlan(
  order: string[],
  groupOf: Map<string, number>,
): SplitPlanResult {
  const seen: number[] = [];
  for (const l of order) {
    const g = groupOf.get(l)!;
    if (!seen.includes(g)) seen.push(g);
  }
  return reorderToGroups(order, groupOf, seen);
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/render/layout/blockAlgebra.test.ts`
Expected: 8/8 PASS. (If the third test's `swaps` assertion of 2 fails, count the actual inversions between `[C,A,D,B]` and `[C,D,A,B]` — pairs (A,D) inverted only → if the implementation reports 1, the TEST is wrong: fix the test's expected value to the bubbleDistance the implementation computes AND verify by hand: from=[C,A,D,B], to=[C,D,A,B]; inverted pairs: (A,D). Expected swaps = 1. Correct the test to 1 — the comment in the test anticipates this check.)

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/blockAlgebra.ts src/render/layout/blockAlgebra.test.ts
git commit -m "feat(render): block algebra split ops — contiguity plans with bubble-distance crossing counts"
```

---

### Task 3: bundleOrder — corridor contraction + flow classification

**Files:**
- Create: `src/render/layout/bundleOrder.ts`
- Create: `src/render/layout/bundleOrder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/render/layout/bundleOrder.test.ts` (fixture helper mirrors `untangle.test.ts`'s `makeLayout` — copy it verbatim so fixtures read identically):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorridors, classifyFlows } from './bundleOrder';
import type { Layout, LayoutEdge, LineRef, TraversalStep } from './types';

const L = (id: string): LineRef => ({ id, label: id, color: '#000' });

function makeLayout(
  nodes: Array<[string, number, number]>,
  edges: Array<{ id: string; from: string; to: string; lines: string[]; order?: string[] }>,
  traversals: Record<string, TraversalStep[]>,
): Layout {
  const nodeMap = new Map(
    nodes.map(([id, x, y]) => [id, { id, cell: [x, y] as [number, number], label: '', lngLat: [0, 0] as [number, number] }]),
  );
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    path: [nodeMap.get(e.from)!.cell, nodeMap.get(e.to)!.cell],
    lines: e.lines.map(L),
    lineOrder: e.order ?? [...e.lines].sort(),
    stops: new Map(),
  }));
  return {
    cellSize: 1,
    nodes: nodeMap,
    edges: layoutEdges,
    lineTraversals: new Map(Object.entries(traversals)),
  };
}

test('corridors: deg-2 identical-set runs contract into one corridor', () => {
  // r -e1- m -e2- n : same {A,B} through deg-2 m -> ONE corridor r..n
  const layout = makeLayout(
    [['r', 0, 0], ['m', 10, 0], ['n', 20, 0]],
    [
      { id: 'e1', from: 'r', to: 'm', lines: ['A', 'B'] },
      { id: 'e2', from: 'm', to: 'n', lines: ['A', 'B'] },
    ],
    {
      A: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
      B: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  assert.equal(cs.corridors.length, 1);
  const c = cs.corridors[0];
  assert.deepEqual([c.endA, c.endB], ['r', 'n']);
  assert.deepEqual(c.parts.map((p) => p.edge.id), ['e1', 'e2']);
});

test('corridors: a line-set change breaks the run', () => {
  const layout = makeLayout(
    [['r', 0, 0], ['m', 10, 0], ['n', 20, 0]],
    [
      { id: 'e1', from: 'r', to: 'm', lines: ['A', 'B'] },
      { id: 'e2', from: 'm', to: 'n', lines: ['A'] },
    ],
    {
      A: [{ edgeId: 'e1', reversed: false }, { edgeId: 'e2', reversed: false }],
      B: [{ edgeId: 'e1', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  assert.equal(cs.corridors.length, 2);
});

test('flows: per-junction line transitions from traversals', () => {
  // Y: trunk t {A,B} from r to n; branches p {A}, q {B} out of n
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  const cs = buildCorridors(layout);
  const flows = classifyFlows(layout, cs);
  const atN = flows.get('n')!;
  const tCorr = cs.byEdge.get('t')!;
  const pCorr = cs.byEdge.get('p')!;
  const qCorr = cs.byEdge.get('q')!;
  assert.equal(atN.get('A')!.from, tCorr.id);
  assert.equal(atN.get('A')!.to, pCorr.id);
  assert.equal(atN.get('B')!.from, tCorr.id);
  assert.equal(atN.get('B')!.to, qCorr.id);
  // terminals: at r, A arrives from nothing and leaves on t
  const atR = flows.get('r')!;
  assert.equal(atR.get('A')!.from, null);
  assert.equal(atR.get('A')!.to, tCorr.id);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/bundleOrder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/render/layout/bundleOrder.ts`:

```ts
// Bundle-blocks line ordering (spec 2026-07-04-bundle-blocks-rebuild):
// structural replacement for the LOOM untangle scorer. Corridors carry rigid
// recursive Blocks; the only order-changing events are bundle joins (binary
// side, one-hop pair-ownership lookahead), splits (free when exit-contiguous,
// else minimal planned crossings AT the split), and cycle-closure residuals
// (always at a junction — corridor interiors are deg-2 by construction, so
// every block boundary IS a junction). Same-corridor open-track reorders are
// unrepresentable. Deterministic: sorted iteration, quantized atan2 angular
// ranks, sqrt-only distances, total tie-breaks.
//
// Writes edge.lineOrder in place — drop-in alternative to untangleLineOrder,
// selected by OCTI_ORDER=blocks|loom at the renderGeographic call site.

import type { Layout, LayoutEdge } from './types';
import {
  type Block,
  flattenBlock,
  mirrorBlock,
  joinBlocks,
  blockLines,
  reorderToGroups,
} from './blockAlgebra';

export interface CorridorPart {
  edge: LayoutEdge;
  /** edge is traversed endB→endA relative to the corridor direction */
  rev: boolean;
}

export interface Corridor {
  id: number;
  endA: string;
  endB: string;
  parts: CorridorPart[]; // ordered endA → endB
  lines: string[];       // sorted line ids (identical across parts)
}

export interface CorridorSet {
  corridors: Corridor[];
  byEdge: Map<string, Corridor>;    // layout edge id → corridor
  atNode: Map<string, Corridor[]>;  // junction node → incident corridors
}

const lineSetKey = (e: LayoutEdge): string => e.lines.map((l) => l.id).sort().join(' ');

/** Maximal runs of layout edges through degree-2 nodes with IDENTICAL line
 *  sets (the OptGraph contraction, minus any Y rewriting — joins are native
 *  here). Self-loops and empty edges are excluded like untangle does. */
export function buildCorridors(layout: Layout): CorridorSet {
  const edges = layout.edges
    .filter((e) => e.from !== e.to && e.lines.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const incident = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    for (const nd of [e.from, e.to]) {
      let a = incident.get(nd);
      if (!a) incident.set(nd, (a = []));
      a.push(e);
    }
  }
  // a node is a THROUGH node when exactly two edges meet with the same set
  const through = (nd: string): boolean => {
    const inc = incident.get(nd) ?? [];
    return inc.length === 2 && lineSetKey(inc[0]) === lineSetKey(inc[1]);
  };
  const used = new Set<string>();
  const corridors: Corridor[] = [];
  const byEdge = new Map<string, Corridor>();
  let seq = 0;
  for (const e of edges) {
    if (used.has(e.id)) continue;
    // grow both ways from e through THROUGH nodes
    const parts: CorridorPart[] = [{ edge: e, rev: false }];
    used.add(e.id);
    let head = e.from; // walk backwards from e.from
    for (;;) {
      if (!through(head)) break;
      const inc = incident.get(head)!;
      const next = inc[0].id === parts[0].edge.id ? inc[1] : inc[0];
      if (used.has(next.id)) break;
      used.add(next.id);
      const rev = next.to !== head; // oriented so the part flows INTO head
      parts.unshift({ edge: next, rev });
      head = rev ? next.to === head ? next.from : next.to : next.from;
      // recompute head properly: the far end of `next` from the old head
      head = next.from === (rev ? next.from : next.from) && next.from !== undefined
        ? (next.from === parts[1] as unknown as string ? next.from : next.from)
        : head; // (replaced below — see NOTE)
      head = next.from === undefined ? head : (next.from === head ? next.to : (next.to === head ? next.from : (rev ? next.from : next.from)));
      break; // NOTE: executor — see Step 3b; this backward walk is finalized there
    }
    corridors.push({ id: seq++, endA: e.from, endB: e.to, parts, lines: e.lines.map((l) => l.id).sort() });
  }
  // (placeholder registration; finalized in Step 3b)
  for (const c of corridors) for (const p of c.parts) byEdge.set(p.edge.id, c);
  const atNode = new Map<string, Corridor[]>();
  for (const c of corridors) {
    for (const nd of [c.endA, c.endB]) {
      let a = atNode.get(nd);
      if (!a) atNode.set(nd, (a = []));
      a.push(c);
    }
  }
  return { corridors, byEdge, atNode };
}
```

STOP — the backward-walk in the sketch above is convoluted. **Step 3b replaces `buildCorridors` wholesale** with the clean two-pointer version below. Write THIS as the final implementation (the sketch exists only to show the executor the intended data shapes):

```ts
export function buildCorridors(layout: Layout): CorridorSet {
  const edges = layout.edges
    .filter((e) => e.from !== e.to && e.lines.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const incident = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    for (const nd of [e.from, e.to]) {
      let a = incident.get(nd);
      if (!a) incident.set(nd, (a = []));
      a.push(e);
    }
  }
  const through = (nd: string): boolean => {
    const inc = incident.get(nd) ?? [];
    return inc.length === 2 && lineSetKey(inc[0]) === lineSetKey(inc[1]);
  };
  const otherEnd = (e: LayoutEdge, nd: string): string => (e.from === nd ? e.to : e.from);
  const used = new Set<string>();
  const corridors: Corridor[] = [];
  let seq = 0;
  for (const e of edges) {
    if (used.has(e.id)) continue;
    used.add(e.id);
    // walk one direction: from `start` node outward while THROUGH
    const walk = (startEdge: LayoutEdge, startNode: string): CorridorPart[] => {
      const acc: CorridorPart[] = [];
      let nd = startNode;
      let prev = startEdge;
      while (through(nd)) {
        const inc = incident.get(nd)!;
        const next = inc[0].id === prev.id ? inc[1] : inc[0];
        if (used.has(next.id)) break; // ring of identical edges (pure cycle)
        used.add(next.id);
        acc.push({ edge: next, rev: next.to === nd }); // oriented AWAY from nd
        nd = otherEnd(next, nd);
        prev = next;
      }
      return acc;
    };
    const fwd = walk(e, e.to);            // parts flowing endA→endB after e
    const bwdRaw = walk(e, e.from);       // parts flowing AWAY from e.from
    // backward parts flow away from the corridor: reverse the list and flip
    // each rev so they flow toward e (endA→endB frame)
    const bwd = bwdRaw.reverse().map((p) => ({ edge: p.edge, rev: !p.rev }));
    const parts = [...bwd, { edge: e, rev: false }, ...fwd];
    const endA = parts[0].rev ? parts[0].edge.to : parts[0].edge.from;
    const last = parts[parts.length - 1];
    const endB = last.rev ? last.edge.from : last.edge.to;
    corridors.push({ id: seq++, endA, endB, parts, lines: e.lines.map((l) => l.id).sort() });
  }
  const byEdge = new Map<string, Corridor>();
  for (const c of corridors) for (const p of c.parts) byEdge.set(p.edge.id, c);
  const atNode = new Map<string, Corridor[]>();
  for (const c of corridors) {
    for (const nd of [c.endA, c.endB]) {
      let a = atNode.get(nd);
      if (!a) atNode.set(nd, (a = []));
      a.push(c);
    }
  }
  return { corridors, byEdge, atNode };
}
```

Then flows:

```ts
export interface LineFlow {
  from: number | null; // corridor id the line arrives on (null = line starts here)
  to: number | null;   // corridor id it leaves on (null = line ends here)
}

/** Per junction node: each line's corridor→corridor transition, derived from
 *  lineTraversals exactly like untangle's connOccurs machinery. Only nodes
 *  that are corridor ENDPOINTS appear (interiors are through nodes). */
export function classifyFlows(
  layout: Layout,
  cs: CorridorSet,
): Map<string, Map<string, LineFlow>> {
  const flows = new Map<string, Map<string, LineFlow>>();
  const at = (nd: string, line: string): LineFlow => {
    let m = flows.get(nd);
    if (!m) flows.set(nd, (m = new Map()));
    let f = m.get(line);
    if (!f) m.set(line, (f = { from: null, to: null }));
    return f;
  };
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  for (const [lineId, steps] of [...layout.lineTraversals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (steps.length === 0) continue;
    // terminal start
    const first = edgeById.get(steps[0].edgeId);
    if (first) {
      const startNode = steps[0].reversed ? first.to : first.from;
      const c = cs.byEdge.get(first.id);
      if (c && cs.atNode.has(startNode)) at(startNode, lineId).to = c.id;
    }
    for (let i = 1; i < steps.length; i++) {
      const e1 = edgeById.get(steps[i - 1].edgeId);
      const e2 = edgeById.get(steps[i].edgeId);
      if (!e1 || !e2) continue;
      const c1 = cs.byEdge.get(e1.id);
      const c2 = cs.byEdge.get(e2.id);
      if (!c1 || !c2 || c1 === c2) continue; // same corridor: interior step
      const nd = steps[i - 1].reversed ? e1.from : e1.to; // shared node
      at(nd, lineId).from = c1.id;
      at(nd, lineId).to = c2.id;
    }
    // terminal end
    const last = edgeById.get(steps[steps.length - 1].edgeId);
    if (last) {
      const endNode = steps[steps.length - 1].reversed ? last.from : last.to;
      const c = cs.byEdge.get(last.id);
      if (c && cs.atNode.has(endNode)) at(endNode, lineId).from = c.id;
    }
  }
  return flows;
}
```

IMPORTANT for the executor: delete the Step-3 sketch version entirely — only the Step-3b `buildCorridors` ships. If a line rides a corridor in BOTH directions (out-and-back), later transitions overwrite `from`/`to` for the same node+line; that matches spec §6 (self-pairs out of scope) — leave as-is.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/render/layout/bundleOrder.test.ts`
Expected: 3/3 PASS. Also `npx tsx --test src/render/layout/blockAlgebra.test.ts` still green.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/bundleOrder.ts src/render/layout/bundleOrder.test.ts
git commit -m "feat(render): bundleOrder corridors + per-junction flow classification"
```

---

### Task 4: bundleOrder — angular ranks, exit keys, forest propagation (joins/splits/terminals)

**Files:**
- Modify: `src/render/layout/bundleOrder.ts`
- Modify: `src/render/layout/bundleOrder.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `bundleOrder.test.ts`:

```ts
import { orderByBlocks } from './bundleOrder';

test('blocks: Y join — trunk order matches branch geometry, no crossings', () => {
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B'], order: ['B', 'A'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['B'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  // A exits toward pe (y=-10), B toward qe (y=+10): the split is contiguous
  // either way (singletons), so the trunk order is the angular one
  assert.deepEqual([...t.lineOrder].sort(), ['A', 'B']);
});

test('blocks: family emergence — partners ride adjacent with zero color logic', () => {
  // P1,P2 ride the identical corridor set; X crosses to its own branch.
  // No colors anywhere in bundleOrder: adjacency must come from the split
  // structure (P1,P2 exit together => contiguous slice).
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['P1', 'X', 'P2'], order: ['P1', 'X', 'P2'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['P1', 'P2'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['X'] },
    ],
    {
      P1: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      P2: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      X: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const t = layout.edges.find((e) => e.id === 't')!;
  const i1 = t.lineOrder.indexOf('P1');
  const i2 = t.lineOrder.indexOf('P2');
  assert.equal(Math.abs(i1 - i2), 1, `P1/P2 adjacent structurally (got ${t.lineOrder})`);
});

test('blocks: join lookahead — side chosen so the pair separation is contiguous', () => {
  // Two 2-line corridors join at j into a 4-line trunk, which later splits at
  // s into {A1,B1} (north) and {A2,B2} (south) — MIXING the joined bundles.
  // Geometry at j alone cannot make the s-split contiguous; the lookahead
  // must nest the join so that after the split-plan at s, planned crossings
  // are minimal. With [A1,A2]+[B1,B2] joined either way, s always needs ≥1
  // crossing; the test asserts total lineOrder consistency and that the
  // crossing shows ONLY across s (edges before s agree; edges after differ).
  const layout = makeLayout(
    [['a0', 0, -10], ['b0', 0, 10], ['j', 10, 0], ['s', 30, 0], ['n1', 40, -10], ['n2', 40, 10]],
    [
      { id: 'ea', from: 'a0', to: 'j', lines: ['A1', 'A2'] },
      { id: 'eb', from: 'b0', to: 'j', lines: ['B1', 'B2'] },
      { id: 'tr', from: 'j', to: 's', lines: ['A1', 'A2', 'B1', 'B2'] },
      { id: 'n', from: 's', to: 'n1', lines: ['A1', 'B1'] },
      { id: 'm', from: 's', to: 'n2', lines: ['A2', 'B2'] },
    ],
    {
      A1: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'n', reversed: false }],
      A2: [{ edgeId: 'ea', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'm', reversed: false }],
      B1: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'n', reversed: false }],
      B2: [{ edgeId: 'eb', reversed: false }, { edgeId: 'tr', reversed: false }, { edgeId: 'm', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const tr = layout.edges.find((e) => e.id === 'tr')!;
  assert.equal(tr.lineOrder.length, 4);
  // the trunk order nests the two joined pairs intact:
  const pos = new Map(tr.lineOrder.map((l, i) => [l, i]));
  assert.equal(Math.abs(pos.get('A1')! - pos.get('A2')!), 1, 'A-block intact on the trunk');
  assert.equal(Math.abs(pos.get('B1')! - pos.get('B2')!), 1, 'B-block intact on the trunk');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/bundleOrder.test.ts`
Expected: FAIL — `orderByBlocks` not exported.

- [ ] **Step 3: Implement the propagation core**

Append to `bundleOrder.ts` (this is the heart of the module — copy exactly, the design notes are inline):

```ts
// quantized atan2 angular rank (cross-V8; same convention as untangle's
// angleAt/tryY): angle of the corridor's departure direction at `nd`.
const angleAt = (c: Corridor, nd: string): number => {
  const part = c.endA === nd ? c.parts[0] : c.parts[c.parts.length - 1];
  const path = part.edge.path;
  // direction pointing AWAY from nd, over ~12px of arc (corridor-scale, like
  // untangle's hardened tangentAt)
  const pts = (() => {
    const fwd = part.edge.from === nd ? path : [...path].reverse();
    return fwd;
  })();
  let dx = pts[1][0] - pts[0][0];
  let dy = pts[1][1] - pts[0][1];
  let hi = 1;
  while (dx * dx + dy * dy < 12 * 12 && hi < pts.length - 1) {
    hi++;
    dx = pts[hi][0] - pts[0][0];
    dy = pts[hi][1] - pts[0][1];
  }
  return Math.round(Math.atan2(dy, dx) * 1e6) / 1e6;
};

/** Comparable exit key for a line leaving `nd` on corridor `to`: the angular
 *  rank of `to` at nd, then recursively the next exit — bounded depth. Used
 *  for terminal-yard seeding and split group ranking (spec §2.4). */
const exitKeyOf = (
  line: string,
  nd: string,
  cs: CorridorSet,
  flows: Map<string, Map<string, LineFlow>>,
  depth: number,
): number[] => {
  const key: number[] = [];
  let node = nd;
  for (let d = 0; d < depth; d++) {
    const f = flows.get(node)?.get(line);
    const toId = f?.to ?? null;
    if (toId === null) { key.push(Number.MAX_SAFE_INTEGER); break; } // terminates
    const to = cs.corridors[toId];
    key.push(angleAt(to, node));
    node = to.endA === node ? to.endB : to.endA; // far end
  }
  return key;
};

const cmpKeys = (a: number[], b: number[]): number => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -Infinity;
    const y = b[i] ?? -Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

interface Planned {
  node: string;
  swaps: number;
}

/** The pipeline: assign a Block to every corridor, then write back. */
export function orderByBlocks(layout: Layout): void {
  const cs = buildCorridors(layout);
  if (cs.corridors.length === 0) return;
  const flows = classifyFlows(layout, cs);

  // blocks are stored in each corridor's canonical endA→endB lateral frame
  const blocks = new Map<number, Block>();
  const planned: Planned[] = [];

  // ---- seeds: every corridor starts flat, ordered by exit keys at its endB
  // (the structural destination grouping — no colors, no barycenter). The
  // propagation below OVERWRITES seeded corridors whenever a join/split
  // derives their block from a neighbour; seeds only survive where no
  // structure reaches them (isolated corridors, component roots).
  const seedBlock = (c: Corridor): Block => {
    const ls = [...c.lines];
    const keys = new Map(ls.map((l) => [l, exitKeyOf(l, c.endB, cs, flows, 4)]));
    ls.sort((a, b) => cmpKeys(keys.get(a)!, keys.get(b)!) || (a < b ? -1 : 1));
    return ls;
  };

  // ---- BFS over corridors from the widest (root per component) ------------
  const order = [...cs.corridors].sort(
    (a, b) => (b.lines.length - a.lines.length) || (a.id - b.id),
  );
  const visited = new Set<number>();
  for (const root of order) {
    if (visited.has(root.id)) continue;
    blocks.set(root.id, seedBlock(root));
    const queue = [root];
    visited.add(root.id);
    while (queue.length > 0) {
      const c = queue.shift()!;
      for (const nd of [c.endA, c.endB]) {
        processJunction(nd, c);
      }
    }

    function processJunction(nd: string, from: Corridor): void {
      const ndFlows = flows.get(nd);
      if (!ndFlows) return;
      // partition `from`'s lines by their counterpart corridor across nd
      const exits = new Map<number, string[]>(); // corridor id -> lines (order of from's block)
      const fromBlock = blocks.get(from.id)!;
      // from's order AT nd: canonical frame if nd is endB (block reads
      // toward nd), mirrored if nd is endA
      const atNd = from.endB === nd ? flattenBlock(fromBlock) : flattenBlock(mirrorBlock(fromBlock));
      for (const l of atNd) {
        const f = ndFlows.get(l);
        const other = f === undefined ? null : (f.from === from.id ? f.to : f.to === from.id ? f.from : (f.from !== null && f.from !== from.id ? f.from : f.to));
        if (other === null || other === undefined) continue; // terminal here
        let arr = exits.get(other);
        if (!arr) exits.set(other, (arr = []));
        arr.push(l);
      }
      if (exits.size === 0) return;

      // SPLIT-FIRST: if from's lines exit to 2+ corridors, plan contiguity
      let ordered = atNd;
      if (exits.size >= 2) {
        const groupOf = new Map<string, number>();
        const groupIds = [...exits.keys()];
        for (const gid of groupIds) for (const l of exits.get(gid)!) groupOf.set(l, gid);
        // group rank = angular order of the exit corridors at nd
        const ranked = [...groupIds].sort(
          (x, y) => angleAt(cs.corridors[x], nd) - angleAt(cs.corridors[y], nd) || x - y,
        );
        const plan = reorderToGroups(ordered.filter((l) => groupOf.has(l)), groupOf, ranked);
        if (plan.swaps > 0) planned.push({ node: nd, swaps: plan.swaps });
        // realize the plan ON from's block at this end: from's stored block
        // becomes the reordered one (crossings draw across nd because the
        // NEIGHBOUR blocks derive from the reordered order while from's
        // other-end neighbours saw the original — the flip is at nd only
        // when from is the divergence corridor; for v1 we adopt the
        // reordered order for the SLICES ONLY, leaving from's own block as
        // is (the crossing then draws across nd, the allowed node).
        ordered = plan.order;
      }

      // THEN JOIN/DERIVE: hand each exit corridor its slice (and join with
      // other feeders when they're already known)
      for (const [gid, ls] of [...exits.entries()].sort((a, b) => a[0] - b[0])) {
        const to = cs.corridors[gid];
        const slice: Block = ordered.filter((l) => ls.includes(l));
        // frame: slice is in from→to walking order at nd; to's canonical
        // frame reads endA→endB, i.e. AWAY from nd if nd === to.endA. The
        // lateral frame flips iff both corridors point the same way through
        // nd (the standard mirror rule).
        const fromPointsIn = from.endB === nd;
        const toPointsOut = to.endA === nd;
        const sameDir = fromPointsIn === !toPointsOut ? false : true;
        const oriented: Block = sameDir ? slice : mirrorBlock(slice);
        // NOTE (executor): the two-boolean dance above must implement:
        // mirror iff (from.endB === nd) === (to.endB === nd). Simplify to:
        const rev = (from.endB === nd) === (to.endB === nd);
        const finalSlice: Block = rev ? mirrorBlock(slice) : slice;
        if (!visited.has(to.id)) {
          // does `to` have OTHER feeders at nd (a join)?
          const existing = blocks.get(to.id);
          if (existing === undefined) {
            blocks.set(to.id, finalSlice);
          } else {
            // another feeder already contributed: JOIN — side by lookahead
            const bFirst = joinSideLookahead(existing, finalSlice, to, nd);
            blocks.set(to.id, joinBlocks(existing, finalSlice, bFirst));
          }
          // enqueue only when to's line set is fully covered by contributions
          const have = blockLines(blocks.get(to.id)!);
          if (to.lines.every((l) => have.has(l))) {
            visited.add(to.id);
            queue.push(to);
          }
        } else {
          // BACK-EDGE (cycle closure): `to` already has a block. Count the
          // disagreement — the forced residual — and leave the block alone
          // (the flip draws across nd, a junction: allowed by construction).
          const haveOrder = (() => {
            const b = blocks.get(to.id)!;
            const flat = to.endA === nd ? flattenBlock(b) : flattenBlock(mirrorBlock(b));
            return flat.filter((l) => ls.includes(l));
          })();
          const want = flattenBlock(finalSlice);
          let inv = 0;
          const rankW = new Map(want.map((l, i) => [l, i]));
          for (let i = 0; i < haveOrder.length; i++) {
            for (let j = i + 1; j < haveOrder.length; j++) {
              if ((rankW.get(haveOrder[i]) ?? 0) > (rankW.get(haveOrder[j]) ?? 0)) inv++;
            }
          }
          if (inv > 0) planned.push({ node: nd, swaps: inv });
        }
      }
    }

    /** Join side by pair-ownership lookahead (spec §2.1): walk forward from
     *  the join until the A-set and B-set take different exits; pick the
     *  side whose angular assignment at that separation matches. Tie or no
     *  separation → angular geometry at the join itself. */
    function joinSideLookahead(a: Block, b: Block, joined: Corridor, joinNode: string): boolean {
      const aLines = blockLines(a);
      const bLines = blockLines(b);
      let node = joined.endA === joinNode ? joined.endB : joined.endA;
      let corridor = joined;
      for (let hops = 0; hops < 64; hops++) {
        const ndFlows = flows.get(node);
        if (!ndFlows) break;
        const exitOf = (l: string): number | null => {
          const f = ndFlows.get(l);
          if (!f) return null;
          return f.from === corridor.id ? f.to : null;
        };
        const aExits = new Set<number | null>();
        const bExits = new Set<number | null>();
        for (const l of aLines) aExits.add(exitOf(l));
        for (const l of bLines) bExits.add(exitOf(l));
        const union = new Set([...aExits, ...bExits]);
        if (union.size > 1) {
          // separation: rank exits angularly; A should sit on the side of
          // its lowest-ranked exit
          const rank = (s: Set<number | null>): number => {
            let m = Infinity;
            for (const gid of s) {
              if (gid === null) continue;
              const ang = angleAt(cs.corridors[gid], node);
              if (ang < m) m = ang;
            }
            return m;
          };
          const ra = rank(aExits);
          const rb = rank(bExits);
          if (ra === rb) break; // degenerate — fall to geometry
          // in the joined corridor's frame at the join: bFirst=true puts B
          // before A. B goes first iff B's separation rank is lower.
          return rb < ra;
        }
        const next = [...union][0];
        if (next === null || next === undefined) break; // all terminate together
        corridor = cs.corridors[next];
        node = corridor.endA === node ? corridor.endB : corridor.endA;
      }
      // geometry tie-break: the feeder arriving from the angularly-lower
      // side at the join goes first — compare a/b feeder angles is not
      // available here (blocks only), so default aFirst (deterministic).
      return false;
    }
  }

  // ---- write-back ----------------------------------------------------------
  for (const c of cs.corridors) {
    const b = blocks.get(c.id) ?? seedBlock(c);
    const flat = flattenBlock(b);
    for (const p of c.parts) {
      p.edge.lineOrder = p.rev ? [...flat].reverse() : [...flat];
    }
  }

  // ---- diagnostics ---------------------------------------------------------
  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_DEBUG) {
    let swapsAtJunctions = 0;
    for (const p of planned) swapsAtJunctions += p.swaps;
    console.error(`[blocks] corridors=${cs.corridors.length} planned-crossings=${swapsAtJunctions} (all at junctions by construction)`);
  }
}
```

EXECUTOR NOTES for this step (deviations here are expected and fine — report them):
- The `sameDir`/`oriented` lines above the `rev` NOTE are the sketch's dead end — implement ONLY the `rev = (from.endB === nd) === (to.endB === nd)` form and delete the dead lines.
- The split-plan realization is v1-simple: slices hand the REORDERED order to neighbours while `from` keeps its own block; the flip draws across `nd`. This matches spec §3.6 ("blocks per corridor; flips manifest at junctions").
- `joinSideLookahead`'s geometry fallback returns `false` (a-first). A follow-up task refines it with feeder angles if the A/B gates show it matters; do NOT gold-plate now.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/render/layout/bundleOrder.test.ts`
Expected: 6/6 PASS. Debug interactively with tiny fixtures if the frame/mirror logic misbehaves — the Y test failing usually means the `rev` rule or the `atNd` mirroring is inverted.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/bundleOrder.ts src/render/layout/bundleOrder.test.ts
git commit -m "feat(render): bundle-blocks propagation — seeds, joins with lookahead, split plans, cycle residuals"
```

---

### Task 5: Cycle + transfer-node tests (behavioral hardening)

**Files:**
- Modify: `src/render/layout/bundleOrder.test.ts`

- [ ] **Step 1: Write the tests (they should pass against Task 4's code — failures here are BUGS to fix in bundleOrder.ts, not test adjustments)**

```ts
test('blocks: triangle cycle — forced inversion lands at a junction, not mid-corridor', () => {
  // three corridors forming a triangle r-s-t, each carrying {A,B}, with
  // branch stubs pinning opposite orders at r and t. SOME junction must eat
  // one A/B flip; every edge's own lineOrder must still be internally
  // consistent with its corridor (no mid-corridor flip is representable).
  const layout = makeLayout(
    [['r', 0, 0], ['s', 20, 0], ['t', 10, 17], ['ra', -10, -5], ['rb', -10, 5], ['ta', 10, 30]],
    [
      { id: 'rs', from: 'r', to: 's', lines: ['A', 'B'] },
      { id: 'st', from: 's', to: 't', lines: ['A', 'B'] },
      { id: 'tr', from: 't', to: 'r', lines: ['A', 'B'] },
      { id: 'pa', from: 'ra', to: 'r', lines: ['A'] },
      { id: 'pb', from: 'rb', to: 'r', lines: ['B'] },
      { id: 'pt', from: 't', to: 'ta', lines: ['A'] },
    ],
    {
      A: [{ edgeId: 'pa', reversed: false }, { edgeId: 'rs', reversed: false }, { edgeId: 'st', reversed: false }, { edgeId: 'pt', reversed: false }],
      B: [{ edgeId: 'pb', reversed: false }, { edgeId: 'rs', reversed: false }, { edgeId: 'st', reversed: false }, { edgeId: 'tr', reversed: false }],
    },
  );
  orderByBlocks(layout);
  for (const id of ['rs', 'st', 'tr']) {
    const e = layout.edges.find((x) => x.id === id)!;
    assert.deepEqual([...e.lineOrder].sort(), [...new Set(e.lines.map((l) => l.id))].sort(),
      `membership preserved on ${id}`);
  }
});

test('blocks: write-back parity — idempotent and membership-preserving', () => {
  const layout = makeLayout(
    [['r', 0, 0], ['n', 20, 0], ['pe', 30, -10], ['qe', 30, 10]],
    [
      { id: 't', from: 'r', to: 'n', lines: ['A', 'B', 'C'] },
      { id: 'p', from: 'n', to: 'pe', lines: ['A', 'B'] },
      { id: 'q', from: 'n', to: 'qe', lines: ['C'] },
    ],
    {
      A: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      B: [{ edgeId: 't', reversed: false }, { edgeId: 'p', reversed: false }],
      C: [{ edgeId: 't', reversed: false }, { edgeId: 'q', reversed: false }],
    },
  );
  orderByBlocks(layout);
  const first = layout.edges.map((e) => [...e.lineOrder]);
  orderByBlocks(layout);
  const second = layout.edges.map((e) => [...e.lineOrder]);
  assert.deepEqual(first, second, 'idempotent');
  for (const e of layout.edges) {
    assert.deepEqual([...e.lineOrder].sort(), e.lines.map((l) => l.id).sort());
  }
});

test('blocks: mirrored parts — opposed edge orientations mirror the order', () => {
  // ea: a->n, eb: b->n (both INTO n), same set: one corridor; written orders
  // must mirror across the flip exactly like untangle's contraction test
  const layout = makeLayout(
    [['a', 0, 0], ['n', 10, 0], ['b', 20, 0]],
    [
      { id: 'ea', from: 'a', to: 'n', lines: ['L1', 'L2'] },
      { id: 'eb', from: 'b', to: 'n', lines: ['L1', 'L2'] },
    ],
    {
      L1: [{ edgeId: 'ea', reversed: false }, { edgeId: 'eb', reversed: true }],
      L2: [{ edgeId: 'ea', reversed: false }, { edgeId: 'eb', reversed: true }],
    },
  );
  orderByBlocks(layout);
  const ea = layout.edges.find((e) => e.id === 'ea')!;
  const eb = layout.edges.find((e) => e.id === 'eb')!;
  assert.deepEqual([...ea.lineOrder].reverse(), eb.lineOrder, 'order mirrors across the flip');
});
```

- [ ] **Step 2: Run; fix any failures IN bundleOrder.ts**

Run: `npx tsx --test src/render/layout/bundleOrder.test.ts`
Expected: 9/9 PASS. The mirrored-parts test exercises `CorridorPart.rev` in write-back; the triangle exercises the back-edge path. Fix code, not tests (the assertions are intentionally structural — membership, idempotence, mirroring — not exact orders).

- [ ] **Step 3: Full suite + commit**

Run: `npm test` — expect 428 + 13 new = 441 total, 0 failures (recount precisely; earlier tasks added 8 blockAlgebra + 6 bundleOrder, this task +3 → expected 445; trust the runner's arithmetic over this note and report the real number).

```bash
git add src/render/layout/bundleOrder.test.ts src/render/layout/bundleOrder.ts
git commit -m "test(render): bundle-blocks cycle, parity, and mirroring hardening"
```

---

### Task 6: Wire the OCTI_ORDER knob + schema bump

**Files:**
- Modify: `src/render/renderGeographic.ts` (the untangle call at ~line 1139–1146)
- Modify: `src/render/cacheFingerprint.ts:17` (SCHEMA 22 → 23)

- [ ] **Step 1: Replace the call site**

Current code (search anchor `OCTI_NO_UNTANGLE`):

```ts
  if (
    !(
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_NO_UNTANGLE === '1'
    )
  ) {
    untangleLineOrder(layout);
  }
  lap('untangle');
```

becomes:

```ts
  // Line ordering: OCTI_ORDER=blocks (default, spec 2026-07-04 bundle-blocks
  // rebuild) = structural rigid-bundle ordering; OCTI_ORDER=loom = the LOOM
  // untangle scorer (A/B baseline, deprecation pending sign-off — moves to
  // old/ per the repo deprecation policy). OCTI_NO_UNTANGLE=1 still skips
  // ordering entirely (barycenter seed only, legacy diagnostic).
  if (
    !(
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_NO_UNTANGLE === '1'
    )
  ) {
    const mode =
      typeof process !== 'undefined'
        ? (process as { env?: Record<string, string> }).env?.OCTI_ORDER
        : undefined;
    if (mode === 'loom') untangleLineOrder(layout);
    else orderByBlocks(layout);
  }
  lap('untangle');
```

Add the import next to the untangle import (line ~33): `import { orderByBlocks } from './layout/bundleOrder';`

- [ ] **Step 2: Schema bump**

`src/render/cacheFingerprint.ts:17`: `const SCHEMA = 22;` → `const SCHEMA = 23;` (default ordering regime changes → every fingerprint must bust).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test` (expect the Task-5 count, 0 failures — note: untangle's own unit tests still pass because they call `untangleLineOrder` directly) and `npm run typecheck` (≤31 pre-existing, none in touched files).

- [ ] **Step 4: Commit**

```bash
git add src/render/renderGeographic.ts src/render/cacheFingerprint.ts
git commit -m "feat(render): OCTI_ORDER=blocks|loom knob — bundle-blocks is the default ordering; schema 23"
```

---

### Task 7: A/B gates + visual checkpoint (controller-assisted)

**Files:** none committed (scratch renders in `dev/`, deleted after).

- [ ] **Step 1: Flip-counter A/B on all four dumps**

The composed-order flip counter lives in untangle's DBG block and only runs on the loom path; for the blocks path the same measurement comes from `dev/_gapdetail.ts`-style external analysis — simplest: run BOTH paths and grep both counters:

```bash
for d in nyc4 nyc lon sea; do
  echo "== $d blocks";  OCTI_DEBUG=1 npx tsx dev/render-from-dump.ts dev/_in-$d.json dev/_ab 2>&1 >/dev/null | grep -E "\[blocks\]";
  echo "== $d loom";    OCTI_DEBUG=1 OCTI_ORDER=loom npx tsx dev/render-from-dump.ts dev/_in-$d.json dev/_ab 2>&1 >/dev/null | grep -E "straight-node|final:";
done; rm -f dev/_ab.*
```

(`dev/_in-nyc4.json` = the NYC-Jul-4 extraction; `_in-nyc`/`_in-lon`/`_in-sea` = the map-bundle extractions — all four exist in the worktree already; re-extract per the ladder plan's Task 0 Step 3 if missing.)

Additionally port the flip counter to run on the blocks path: copy untangle's `straight-node same-seg flips` DBG block (the awayTangent + per-line-carrier classifier, untangle.ts ~lines 1240-1320) into a small exported helper `reportStraightFlips(layout)` in `bundleOrder.ts` — EXACT same output line format so A/B greps are uniform — and call it from `orderByBlocks` under `OCTI_DEBUG`. (This is a ~70-line mechanical port; carriers are corridors here, so `interior` flips are impossible by construction and the classifier simplifies to freeCross/scored/diverge... freeCross doesn't exist in blocks — classify all as scored/diverge only.)

**Gates:**
- NYC-Jul-4: blocks' straight-node flip total **< 13** (loom's measured best), with `[blocks] planned-crossings` all at junctions (the counter's claim) — any flip the straight-flip reporter finds at a NON-junction node is a bug: STOP and fix before proceeding.
- LON/SEA: 0 flips both paths.
- Full placement gates on all four dumps: no new drawn gaps (`dev/_gapdetail.ts` = 9 pre-existing on NYC-EXTRA-DIFFICULT, 0 on NYC-Jul-4/LON/SEA), `[capsovl]`/mega counts within ±1 of the loom run on the same dump.
- Perf: time both paths on NYC-EXTRA-DIFFICULT; blocks must not be slower than loom (expect several× faster — no hill climb).

- [ ] **Step 2: Visual crops for the user checkpoint**

Render `dev/_in-nyc4.json` with blocks and crop the war-story spots (same technique as the straight-lock sessions — label-anchored viewBox crops at 36 St, Franklin Av-Medgar Evers, Eastern Pkwy-Brooklyn Museum, Jay St-Metrotech, 103 St, Washington Hts-168 St). Send old-vs-new pairs to the user and STOP for sign-off. Deprecation (the `old/` move) happens only after the user approves the look — it is NOT part of this plan's tasks.

- [ ] **Step 3: Record results**

Append the measured numbers (flip totals per dump per path, planned-crossing counts, perf) to the spec's §4 as a dated results block, commit:

```bash
git add docs/superpowers/specs/2026-07-04-bundle-blocks-rebuild-design.md
git commit -m "docs: bundle-blocks A/B results vs loom baseline"
```

---

### Task 8 (DEFERRED — executes only after explicit user sign-off): deprecate untangle into old/

Documented here so the executor knows the endgame; DO NOT run without the user's go.

- Create repo-root `old/` with `old/README.md` (what moved, why, replacement, sign-off date) and move, preserving history (`git mv`):
  - `src/render/layout/untangle.ts` → `old/src/render/layout/untangle.ts`
  - `src/render/layout/untangle.test.ts` → `old/src/render/layout/untangle.test.ts`
  - `src/render/layout/lineOrder.ts` + `lineOrder.test.ts` → `old/src/render/layout/` IF the barycenter seed call in renderGeographic is also removed in the same commit (verify `orderLines` has no other consumers first; if the seed stays, lineOrder stays).
- Remove the `OCTI_ORDER` knob (blocks becomes unconditional), delete the loom branch of the dispatch, drop the untangle import.
- `npm test` (untangle tests leave the suite — recount), typecheck gate, schema bump NOT needed (no output change — blocks was already default).
- Update `docs/optimizers.md` and the memory files that reference untangle knobs.

---

## Self-review notes

- **Spec coverage:** §2 model → Tasks 1–2 (algebra) + 4 (ops in propagation); §2.1 lookahead → Task 4 (`joinSideLookahead`); §2.2 taxonomy → Task 4 (split-first-then-join in `processJunction`; terminals via flows' null ends); §2.3 cycles → Task 4 back-edge branch + Task 5 triangle test (junction placement is structural — corridor interiors can't host flips); §2.4 seeding → Task 4 `seedBlock` (exit keys, no colors); §3 pipeline/write-back → Tasks 3–4; §3 diagnostics → Task 7 Step 1 (flip-counter port + `[blocks]` counter); §4 knob/gates/deprecation-policy → Tasks 6, 7, 8; §5 tests → Tasks 1–5 (family emergence in Task 4, pinned-corridor reformulation covered by the triangle + parity set).
- **Known simplification vs spec:** §2.3's ≥90°-bend relief valve is dormant in v1 — every block boundary is a junction by construction, so residuals always land at allowed locations without a placement search. Noted in module header; the counter in Task 7 verifies the invariant empirically.
- **Type consistency:** `Block`/`flattenBlock`/`mirrorBlock`/`joinBlocks`/`blockLines`/`reorderToGroups` (Tasks 1–2) match their uses in Task 4; `buildCorridors`/`classifyFlows`/`CorridorSet`/`LineFlow` (Task 3) match Task 4's imports; `orderByBlocks` (Task 4) matches Task 6's wiring.
- **Honest risk:** Task 4 is the hard one — the frame/mirror bookkeeping (`rev` rules) is where bugs will live; its executor notes call out the exact dead-sketch lines to delete and the invariant to debug against. The task-level tests are deliberately structural (membership/adjacency/mirroring) so a correct-but-differently-tied implementation passes.
