# Course windows survive the degree-2 collapse — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Course-economy windows form across `combineDeg2`-collapsed hops, mirroring the loop-cycle survivor regime, so the switchback/staircase penalty covers dense-knot approaches it is currently blind to.

**Architecture:** Extract the traversal-to-node-sequence walk out of `tryDraw` into an exported pure helper that runs on the ORIGINAL support graph (where traversals and edge ids agree); the octi caller filters each sequence to collapse survivors and passes them into `tryDraw` beside `loopCycles`; `tryDraw`'s window slicing and pricing consume the sequences unchanged.

**Tech Stack:** TypeScript, node:test via tsx, existing octi debug census (`OCTI_BLOCKAGE=1`).

Baseline numbers to capture BEFORE any edit (Task 0) gate the artifact sweep in Task 4.

---

### Task 0: Capture the before-baseline

**Files:** none (probe run only)

- [ ] **Step 0.1: Record per-dump baseline census.** For each reference dump, run a smoothed render with `OCTI_BLOCKAGE=1 OCTI_AUDIT=1` and record: course-window count (blockage final census), hook `spliced=` count, the `finish()` cut counters, and the zigzag census lines. Save the raw output to the scratchpad for the Task 4 diff.

### Task 1: Extract `courseNodeSeqs` (TDD)

**Files:**
- Modify: `src/render/layout/octi.ts` (new exported helper near `detectLoopCycles`)
- Test: `src/render/layout/tests/octi.test.ts`

- [ ] **Step 1.1: Write the failing test.** A traversal over three edges through two degree-2 interior nodes must yield ONE unbroken node sequence on a graph that carries all three edges, and the survivor filter against a collapsed graph (interior nodes absent) must keep one joined sequence over the surviving endpoints:

```ts
test('courseNodeSeqs joins a traversal run and survives a deg-2 collapse filter', () => {
  // n0 -e1- n1 -e2- n2 -e3- n3, one line riding all three edges
  const mk = (id: string, from: string, to: string) => [id, { id, from, to, points: [[0, 0], [1, 0]] as Pixel[], lineIds: new Set(['L']) }] as const;
  const h: any = {
    nodes: new Map(['n0', 'n1', 'n2', 'n3'].map((n, i) => [n, { id: n, pos: [i * 10, 0] }])),
    edges: new Map([mk('e1', 'n0', 'n1'), mk('e2', 'n1', 'n2'), mk('e3', 'n2', 'n3')]),
    lineTraversals: new Map([['L', [
      { edgeId: 'e1', reversed: false },
      { edgeId: 'e2', reversed: false },
      { edgeId: 'e3', reversed: false },
    ]]]),
  };
  const seqs = courseNodeSeqs(h);
  assert.deepEqual(seqs, [['n0', 'n1', 'n2', 'n3']]);
  // survivor filter: the collapsed graph kept only the endpoints; the run
  // must stay ONE joined sequence over them, not fragment
  const surviving = new Set(['n0', 'n3', 'x']);
  const filtered = seqs.map((s) => s.filter((nd) => surviving.has(nd))).filter((s) => s.length > 2);
  assert.deepEqual(filtered, []); // 2 survivors < 3: correctly dropped, no phantom window
  const surviving2 = new Set(['n0', 'n2', 'n3']);
  const filtered2 = seqs.map((s) => s.filter((nd) => surviving2.has(nd))).filter((s) => s.length > 2);
  assert.deepEqual(filtered2, [['n0', 'n2', 'n3']]);
});
```

- [ ] **Step 1.2: Run it, confirm it fails** (`courseNodeSeqs` does not exist): `npx tsx --test src/render/layout/tests/octi.test.ts`.
- [ ] **Step 1.3: Implement the helper.** Move the sequence walk VERBATIM from `tryDraw` (the block building `seqs` from `h.lineTraversals`, including the `prevEnd` break semantics and the `seq.length > 2` keep rule) into:

```ts
/** Per-run node sequences of every line's traversal, walked on a graph whose
 *  edges the traversal ids actually reference (the ORIGINAL support graph).
 *  A missing edge or a discontinuity ends the run, so on the original graph
 *  a break means a genuine service break, never a collapse artifact. */
export function courseNodeSeqs(h: SupportGraph): string[][] {
  const seqs: string[][] = [];
  for (const steps of h.lineTraversals.values()) {
    let seq: string[] = [];
    let prevEnd: string | null = null;
    for (const s of steps) {
      const e = h.edges.get(s.edgeId);
      if (!e) { if (seq.length > 2) seqs.push(seq); seq = []; prevEnd = null; continue; }
      const a = s.reversed ? e.to : e.from;
      const b = s.reversed ? e.from : e.to;
      if (prevEnd !== a) { if (seq.length > 2) seqs.push(seq); seq = [a]; }
      seq.push(b);
      prevEnd = b;
    }
    if (seq.length > 2) seqs.push(seq);
  }
  return seqs;
}
```

- [ ] **Step 1.4: Run the test to green.**
- [ ] **Step 1.5: Commit** (`git commit -F` a temp file): `refactor(octi): extract course node-sequence walk into courseNodeSeqs`.

### Task 2: Route survivor sequences into `tryDraw`

**Files:**
- Modify: `src/render/layout/octi.ts` (caller beside `detectLoopCycles`; `tryDraw` signature + window block)

- [ ] **Step 2.1: Build survivor sequences at the caller.** Next to `const loopCycles = detectLoopCycles(h, dg);` add:

```ts
// Course windows: like loop cycles, derived on the ORIGINAL graph where
// traversals and edge ids agree, then filtered to the nodes that survived
// contraction and the deg-2 collapse. A window can therefore span a
// collapsed hop; walking hC by traversal edge id cannot represent that
// (every absorbed edge would silently break the sequence).
const courseSeqs = courseNodeSeqs(h)
  .map((seq) => seq.filter((nd) => hC.nodes.has(nd)))
  .filter((seq) => seq.length > 2);
```

- [ ] **Step 2.2: Thread the parameter.** `tryDraw(hC, grid, opts, info, loopCycles, courseSeqs)`; add `courseSeqs: string[][]` to the signature.
- [ ] **Step 2.3: Replace the internal builder.** Inside `tryDraw`'s course-window block, delete the `seqs` construction (now in `courseNodeSeqs`) and iterate `courseSeqs` instead (`for (const seq of courseSeqs)`), keeping the span slicing, revisit skip, reference ratio, and penalty code untouched. Update the block comment to state the derivation site and the invariant (no consumer of the collapsed graph walks `lineTraversals` by edge id).
- [ ] **Step 2.4: Check the diagnostic bypass.** With `opts.combineDeg2 === false`, `hC === hP`; the survivor filter keeps planarized-graph nodes. Confirm planarization can rename nodes; if `hP` node ids differ from `h` node ids, filter against `hP.nodes` (which IS `hC` here) — the code above already does exactly that, so only confirm `h`-derived node ids survive into `hP` (they do for stations; helper nodes never appear in traversal sequences). Note findings in the commit message if any subtlety surfaced.
- [ ] **Step 2.5: Run the full octi suite:** `npx tsx --test src/render/layout/tests/octi.test.ts` — green.
- [ ] **Step 2.6: Commit:** `fix(octi): course windows survive the deg-2 collapse (survivor-filtered sequences)`.

### Task 3: Full suite + determinism

- [ ] **Step 3.1:** `npm test` — 100% green (expect 492+ after Task 1's test).
- [ ] **Step 3.2:** Render-twice determinism on one dump: `DUMP=<dump> npx tsx dev/_detcheck.ts` — IDENTICAL.

### Task 4: Artifact regression sweep (gates the land)

**Files:** none (probe runs; scratchpad diff against Task 0)

- [ ] **Step 4.1: After-census.** Re-run the Task 0 probe matrix on the same dumps. Required outcomes:
  - course-window count RISES on every dump (coverage expanded);
  - zigzag/reversal census, hook `spliced=`, and `finish()` cut counters are flat or falling on every dump; any rise = stop and investigate before landing (falsification per the spec).
- [ ] **Step 4.2: Visual checkpoints.** Before/after renders at two dense knots on two dumps (use the stash trick: render after, `git stash push src/`, render before, pop). Judge for switchbacks/staircases; attach the pairs.
- [ ] **Step 4.3: If all gates pass, update the spec doc's status line and report the numbers.**

### Self-review notes

- Types used exist: `SupportGraph` (`layout/types.ts`), `Pixel`; `courseNodeSeqs` returns `string[][]` consumed by Task 2's filter — names consistent across tasks.
- No placeholder steps; every code step shows the code; the Task 1 test fails first for a real reason (missing export).
- Spec coverage: helper extraction (spec Mechanics 1) = Task 1; survivor filter + threading (Mechanics 2-3) = Task 2; formation census + artifact sweep + visual + suite/determinism (spec Verification 1-5) = Tasks 0/3/4. The spec's "temporary break counter" is satisfied structurally: the new builder walks the original graph, so a missing-edge break is unrepresentable; Task 0/4's window-count diff provides the measurable before/after instead.
