# Micro-Edge Chains C1: Detection + Census — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect junction-dominated edge chains and report them through the fan-zone census, with zero behavior change, so C2's rails can be planned against verified chain scope.

**Architecture:** A pure detection module (`src/render/chains.ts`) computes chains from edges, base polylines, drawn lane counts, and spacing. The renderer calls it once before the fan and passes the result to the census. Gate: every current taper-intrusion edge lies inside a detected chain, and no runaway chains (see the over-detection risk, spec §4).

**Tech Stack:** TypeScript, Node built-in test runner (`npx tsx --test`), existing census plumbing (`OCTI_FANZONE`).

---

### Task 1: chain detection module with tests

**Files:**
- Create: `src/render/chains.ts`
- Test: `src/render/tests/chains.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { detectChains, type ChainEdgeRef } from '../chains';
import type { Pixel } from '../layout/types';

const SP = 6;

function args(
  edges: ChainEdgeRef[],
  bases: Record<string, Pixel[]>,
  lanes: Record<string, number>,
) {
  return {
    edges,
    basePoly: (id: string) => bases[id],
    laneCount: (id: string) => lanes[id] ?? 0,
    spacing: SP,
  };
}

test('chains: a dominated run between two anchors is one chain', () => {
  // corridor A--(60px)--B--(10px)--C--(8px)--D--(60px)--E, 3 lanes wide:
  // reach at each interior node ~ (6+6+12)/1 = 24 for the 90-degree pairs
  // is irrelevant here (no turns), so domination comes from collinear
  // bias-seam runs; use a mid-corridor 90-degree branch to give B and C
  // genuine reach instead: the two interior edges are far shorter than
  // reach(from)+reach(to) and chain together.
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'm1', from: 'B', to: 'C' },
    { id: 'm2', from: 'C', to: 'D' },
    { id: 'b', from: 'D', to: 'E' },
    { id: 'br', from: 'C', to: 'X' }, // branch giving C a turn pair
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [60, 0]],
    m1: [[60, 0], [70, 0]],
    m2: [[70, 0], [78, 0]],
    b: [[78, 0], [138, 0]],
    br: [[70, 0], [70, 40]],
  };
  const chains = detectChains(args(edges, bases, { a: 3, m1: 3, m2: 3, b: 3, br: 1 }));
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].edgeIds, ['m1', 'm2']);
  assert.equal(chains[0].anchorA, 'a');
  assert.equal(chains[0].anchorB, 'b');
});

test('chains: an isolated long edge is not chained', () => {
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'l', from: 'B', to: 'C' },
    { id: 'b', from: 'C', to: 'D' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [80, 0]],
    l: [[80, 0], [200, 0]],
    b: [[200, 0], [280, 0]],
  };
  const chains = detectChains(args(edges, bases, { a: 2, l: 2, b: 2 }));
  assert.equal(chains.length, 0);
});

test('chains: the walk continues through a branch node along the collinear edge', () => {
  // B--(9px)--C with a diagonal branch at C; the chain continues onto the
  // collinear m2, not the branch.
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'm1', from: 'B', to: 'C' },
    { id: 'm2', from: 'C', to: 'D' },
    { id: 'diag', from: 'C', to: 'X' },
    { id: 'b', from: 'D', to: 'E' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [70, 0]],
    m1: [[70, 0], [79, 0]],
    m2: [[79, 0], [88, 0]],
    diag: [[79, 0], [110, 31]],
    b: [[88, 0], [160, 0]],
  };
  const chains = detectChains(args(edges, bases, { a: 4, m1: 4, m2: 4, diag: 2, b: 4 }));
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].edgeIds, ['m1', 'm2']);
});

test('chains: a chain ending at a terminus (no far anchor) still reports with one anchor', () => {
  const edges: ChainEdgeRef[] = [
    { id: 'a', from: 'A', to: 'B' },
    { id: 'm1', from: 'B', to: 'C' },
    { id: 'br', from: 'B', to: 'X' },
  ];
  const bases: Record<string, Pixel[]> = {
    a: [[0, 0], [80, 0]],
    m1: [[80, 0], [90, 0]],
    br: [[80, 0], [80, 40]],
  };
  const chains = detectChains(args(edges, bases, { a: 3, m1: 3, br: 1 }));
  assert.equal(chains.length, 1);
  assert.equal(chains[0].anchorA, 'a');
  assert.equal(chains[0].anchorB, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/render/tests/chains.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/render/chains.ts`**

```ts
// Micro-edge chain detection (invariant I3, chains spec section 2.1): a
// chain is a maximal run of consecutive edges dominated by junction
// geometry, bounded by anchor edges that own their frames. Detection is
// purely theoretical (half widths and turn angles; it runs before any
// construction exists to measure) and deterministic (sorted iteration).

import type { Pixel } from './layout/types';

export interface ChainEdgeRef {
  id: string;
  from: string;
  to: string;
}

export interface Chain {
  /** Interior (dominated) edges in corridor order. */
  edgeIds: string[];
  /** Bounding anchor edge at each end; null at a terminus. */
  anchorA: string | null;
  anchorB: string | null;
  /** Total interior arc, px. */
  arc: number;
}

export interface ChainArgs {
  edges: ChainEdgeRef[];
  basePoly: (edgeId: string) => Pixel[] | undefined;
  /** Drawn lane count per edge (0 = undrawn, excluded). */
  laneCount: (edgeId: string) => number;
  spacing: number;
}

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export function detectChains(args: ChainArgs): Chain[] {
  const { edges, basePoly, laneCount, spacing } = args;
  interface Info {
    id: string; from: string; to: string;
    arc: number; endDir: Map<string, Pixel>; half: number;
  }
  const infos = new Map<string, Info>();
  const atNode = new Map<string, string[]>();
  for (const e of [...edges].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const n = laneCount(e.id);
    if (n <= 0) continue;
    const base = basePoly(e.id);
    if (!base || base.length < 2) continue;
    let arc = 0;
    for (let i = 1; i < base.length; i++) arc += hyp(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]);
    // direction pointing away from each endpoint into the edge
    const dirFrom: Pixel = (() => {
      const l = hyp(base[1][0] - base[0][0], base[1][1] - base[0][1]) || 1;
      return [(base[1][0] - base[0][0]) / l, (base[1][1] - base[0][1]) / l];
    })();
    const k = base.length;
    const dirTo: Pixel = (() => {
      const l = hyp(base[k - 2][0] - base[k - 1][0], base[k - 2][1] - base[k - 1][1]) || 1;
      return [(base[k - 2][0] - base[k - 1][0]) / l, (base[k - 2][1] - base[k - 1][1]) / l];
    })();
    infos.set(e.id, {
      id: e.id, from: e.from, to: e.to, arc,
      endDir: new Map([[e.from, dirFrom], [e.to, dirTo]]),
      half: ((n - 1) / 2) * spacing,
    });
    for (const nd of [e.from, e.to]) {
      if (!atNode.has(nd)) atNode.set(nd, []);
      atNode.get(nd)!.push(e.id);
    }
  }
  // Theoretical reach at a node: max over incident drawn edge pairs of
  // (halfA + halfB + 2*spacing) / max(sin(turn), 0.5), the fan builder's
  // own formula.
  const reachAt = new Map<string, number>();
  for (const [nd, ids] of atNode) {
    let best = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = infos.get(ids[i])!;
        const B = infos.get(ids[j])!;
        const da = A.endDir.get(nd)!;
        const db = B.endDir.get(nd)!;
        const den = Math.abs(da[0] * db[1] - da[1] * db[0]);
        best = Math.max(best, (A.half + B.half + 2 * spacing) / Math.max(den, 0.5));
      }
    }
    reachAt.set(nd, best);
  }
  const dominated = (e: Info): boolean => e.arc < (reachAt.get(e.from) ?? 0) + (reachAt.get(e.to) ?? 0);
  // Chain walk: from every dominated edge not yet claimed, extend in both
  // directions through the most-collinear dominated continuation at each
  // node (dot >= 0.7; a genuine turn ends the chain interior).
  const claimed = new Set<string>();
  const chains: Chain[] = [];
  const continuation = (edgeId: string, nd: string): { next: string | null; anchor: string | null } => {
    const cur = infos.get(edgeId)!;
    const away = cur.endDir.get(nd)!; // points INTO cur from nd
    const inDir: Pixel = [-away[0], -away[1]]; // travel direction arriving at nd
    let best: { id: string; dot: number } | null = null;
    for (const cand of atNode.get(nd) ?? []) {
      if (cand === edgeId) continue;
      const ci = infos.get(cand)!;
      const out = ci.endDir.get(nd)!;
      const dot = inDir[0] * out[0] + inDir[1] * out[1];
      if (dot < 0.7) continue;
      if (!best || dot > best.dot || (dot === best.dot && cand < best.id)) best = { id: cand, dot };
    }
    if (!best) return { next: null, anchor: null };
    return dominated(infos.get(best.id)!)
      ? { next: best.id, anchor: null }
      : { next: null, anchor: best.id };
  };
  for (const id of [...infos.keys()].sort()) {
    const info = infos.get(id)!;
    if (claimed.has(id) || !dominated(info)) continue;
    const run: string[] = [id];
    claimed.add(id);
    let anchorA: string | null = null;
    let anchorB: string | null = null;
    // extend from the 'from' end backward
    let nd = info.from;
    let cur = id;
    for (;;) {
      const c = continuation(cur, nd);
      if (c.next === null) { anchorA = c.anchor; break; }
      if (claimed.has(c.next)) break;
      run.unshift(c.next);
      claimed.add(c.next);
      const ci = infos.get(c.next)!;
      nd = ci.from === nd ? ci.to : ci.from;
      cur = c.next;
    }
    // extend from the 'to' end forward
    nd = info.to;
    cur = id;
    for (;;) {
      const c = continuation(cur, nd);
      if (c.next === null) { anchorB = c.anchor; break; }
      if (claimed.has(c.next)) break;
      run.push(c.next);
      claimed.add(c.next);
      const ci = infos.get(c.next)!;
      nd = ci.from === nd ? ci.to : ci.from;
      cur = c.next;
    }
    chains.push({
      edgeIds: run,
      anchorA, anchorB,
      arc: run.reduce((s, eid) => s + infos.get(eid)!.arc, 0),
    });
  }
  return chains;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/render/tests/chains.test.ts`
Expected: 4 pass. If the first fixture's interior edges are not both
dominated, adjust the fixture's branch geometry (the domination inputs
are laneCount and angles, not tuned constants) until the intent holds —
do not weaken the criterion.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all pass (662 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/render/chains.ts src/render/tests/chains.test.ts
# commit message via temp file (repo rule):
#   feat(chains): junction-dominated chain detection (C1)
git commit -F <msgfile>
```

### Task 2: census wiring

**Files:**
- Modify: `src/render/renderOctilinear.ts` (before the fan call, where `edgePolyline`, `orderOf`, `spacing` are in scope)
- Modify: `src/render/debug/renderOctilinear.debug.ts`

- [ ] **Step 1: Add `reportChains` to the debug module**

```ts
/** OCTI_FANZONE: chain report (spec C1). Prints each detected chain and
 *  whether every taper-intrusion edge lies inside one (the C1 gate). */
export function reportChains(d: {
  chains: Array<{ edgeIds: string[]; anchorA: string | null; anchorB: string | null; arc: number }>;
  nodePx: Map<string, Pixel>;
  edgeById: Map<string, { id: string; from: string; to: string }>;
}): void {
  if (envStr('OCTI_FANZONE') !== '1') return;
  for (const c of d.chains) {
    const first = d.edgeById.get(c.edgeIds[0]);
    const p = first ? d.nodePx.get(first.from) : undefined;
    console.warn(
      `[chains] ${c.edgeIds.join('>')} arc=${c.arc.toFixed(0)}` +
      ` anchors=${c.anchorA ?? 'terminus'}..${c.anchorB ?? 'terminus'}` +
      (p ? ` at=(${p[0].toFixed(0)},${p[1].toFixed(0)})` : ''),
    );
  }
  console.warn(`[chains] ${d.chains.length} chains`);
}
```

- [ ] **Step 2: Call detection + report in the renderer**

Immediately before the `if (useFanJoins)` block:

```ts
const chains = detectChains({
  edges: layout.edges,
  basePoly: (id) => {
    const e = edgeById.get(id);
    return e ? edgePolyline(e) : undefined;
  },
  laneCount: (id) => orderOf.get(id)?.length ?? 0,
  spacing,
});
reportChains({ chains, nodePx, edgeById });
```

(`chains` is otherwise unused in C1; C2 consumes it.)

- [ ] **Step 3: Full suite + commit**

Run: `npm test` → all pass. Commit as
`feat(census): chain report in the fan-zone census (C1)`.

### Task 3: corpus gate

- [ ] **Step 1: Render the 6-city corpus with `OCTI_FANZONE=1`** (background; renders are slow)

```bash
for m in NYC-jul-16-2 SF-jul-16 HOR LON-jul-16 SEA-jul-11-2 DEN; do
  OCTI_FANZONE=1 npx tsx dev/_airrepro.ts testdata/improvedschematics-map-$m.json out/$m > out/$m.log 2>&1
done
```

- [ ] **Step 2: Verify the C1 gates**

1. Every edge named in a `[fanzone] taper ... intrudes` line appears in
   some `[chains]` line of the same city (the 6 known sites, including
   the trio's edge and the band-exchange edge).
2. No runaway chains: inspect the largest chains per city; a chain
   spanning a whole legitimate corridor (many station spacings with no
   junction congestion) fails the scope check and the domination
   criterion needs tightening BEFORE C2 is planned.
3. Censuses unchanged: clips/loops/zigs identical to the pre-C1 corpus
   (detection is read-only).

- [ ] **Step 3: Record the verdict**

Update the auto-memory (chain counts per city, gate outcomes) and report
to the user with the numbers. C2 planning starts from this data.
