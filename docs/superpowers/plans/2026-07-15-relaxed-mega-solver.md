# Relaxed Mega-Solver (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placement-path mega box with a relaxed, overlap-allowing, guaranteed-non-null `solveRows` mode so over-dense stations seat as real dots; remove the `curve`/`box` **option** (the "Hubs" toggle) end to end, keeping the `curve` pill as the sole internal residual rendering.

**Architecture:** `solveRows` (`rowPlace.ts`) gains a `relaxed` mode that (1) drops the no-overlap floor to 0 so overlap is priced not vetoed, (2) never returns null via an ultimate single-row fallback, and (3) — in a later, determinism-gated phase — seats rows at free (non-octilinear) angles. `renderOctilinear.ts` calls it as the final escalation stage in place of flagging `mega`. The `megaFallback` option and the Curve/Box UI toggle are deleted; the residual `boxStation` cases render the existing `curve` pill (today's default), so they see zero visual change. The `mega` flag, the `box` rendering, and the `boxStation` overlap passes are left for Part 2.

**Tech Stack:** TypeScript, Node built-in test runner via `tsx --test` (NOT vitest, NOT `tsc`), esbuild transpile-only build. Deterministic render pipeline (no `Date.now`/`Math.random`; `Math.sqrt` not `Math.hypot`; quantized trig).

**Phasing:** Tasks 1-7 are the low-risk **overlap-first** phase (octilinear states + overlap + never-null); the map's megas disappear here and it is shippable. Tasks 8-10 add **free-angle** rows and are gated on the ULP determinism harness — if free-angle cannot pass cross-V8, ship Tasks 1-7 alone.

---

## File Structure

- `src/render/layout/rowPlace.ts` — the solver. Add `RowOpts.relaxed`; gate `hardFloor`, `buildStates` angle enumeration, `pairEval` parallel detection, and the two null-return sites on it. All relaxed logic is behind `if (relaxed)` so the octilinear path stays byte-identical.
- `src/render/layout/tests/rowPlace.test.ts` — new relaxed-mode tests (never null; overlap only when forced; free-angle seat; determinism).
- `src/render/renderOctilinear.ts` — wire the relaxed final seat into the escalation ladder's mega tail; delete the `megaFallbacks` counter, `reportMegaFallbacks`/`reportBoxRegime` calls, the `megaFallback` arg + its `renderStations` default.
- `src/render/stations/placement.ts` — residual `isMega` always renders the `curve` pill; delete the `box` return, `megaBB`, the `debugMegaBox` call, `PlacementCtx.megaFallback`, and the dead `median` helper.
- `src/render/stations/tests/placement.test.ts` — drop the mega→box test; keep mega→curve.
- `src/render/types.ts`, `src/render/schematic.ts`, `src/render/renderGeographic.ts`, `src/render/stations/render.ts` — delete `megaFallback` plumbing.
- `src/render/debug/renderOctilinear.debug.ts` — delete `reportMegaFallbacks` and `reportBoxRegime`.
- `src/ui/SchematicPanel.tsx`, `src/ui/DetailInset.tsx` — delete the Hubs Curve/Box toggle, state, persistence, and dep-array entries.

**Determinism note (applies throughout Tasks 8-9):** free-angle `u = [cos, sin]` is not correctly-rounded cross-V8. Every `u` component MUST be quantized to 1e-6 (mirroring the existing `atan2` quantization). Verify with `dev/ulpRun.ts`/`_ulpcheck.ts`, not only local byte-identity.

---

## Task 1: Add `RowOpts.relaxed` and drop the hard floor to 0

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (RowOpts ~18-53; `hardFloor` ~155)
- Test: `src/render/layout/tests/rowPlace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `rowPlace.test.ts`:

```ts
test('relaxed: an in-band-and-below pinch that boxes today seats non-null', () => {
  // two horizontal lanes 2px apart — below the hard floor (minGap 4.85), so the
  // octilinear solve boxes (null). Relaxed drops the floor to 0: the single
  // 2-member bundle keeps its overlapping row (deficit priced, not vetoed).
  const curves = [lane(0, 0), lane(2, 0)];
  assert.equal(solveRows(curves, [[0, 1]], OPTS), null, 'octilinear boxes the 2px pinch');
  const sol = solveRows(curves, [[0, 1]], { ...OPTS, relaxed: true });
  assert.ok(sol, 'relaxed must seat the pinch');
  const d = Math.hypot(sol.pos[0][0] - sol.pos[1][0], sol.pos[0][1] - sol.pos[1][1]);
  assert.ok(d < MINGAP, `relaxed seat should be sub-floor overlap: ${d}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: FAIL — `relaxed` is not a valid `RowOpts` field (TS) / the relaxed call still returns null.

- [ ] **Step 3: Add the `relaxed` field to `RowOpts`**

In `rowPlace.ts`, inside `interface RowOpts` (after `softW?: number;`, ~line 52):

```ts
  /** Relaxed non-octilinear overlap mode (over-dense fallback). Drops the
   *  no-overlap floor to 0 (overlap priced by softW, never vetoed), enumerates
   *  free-angle rows, and guarantees a non-null result via an ultimate
   *  single-row fallback. Off for every normal seat (byte-identical path). */
  relaxed?: boolean;
```

- [ ] **Step 4: Gate `hardFloor` on `relaxed`**

In `solveRows`, replace the `hardFloor` line (~155):

```ts
  const softBand = opts.softBand ?? 0;
  const softW = opts.softW ?? 5000;
  const relaxed = opts.relaxed ?? false;
  const hardFloor = relaxed ? 0 : minGap - softBand;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: the new test PASSES; every existing rowPlace test still PASSES (octilinear path unchanged: `relaxed` defaults false, `hardFloor` identical).

- [ ] **Step 6: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/tests/rowPlace.test.ts
git commit -F <msgfile>   # "feat(rowPlace): relaxed mode drops the no-overlap floor to 0"
```

---

## Task 2: Ultimate never-null fallback

The relaxed solve must never return null. Two sites return null today: the empty-states aggregate (~266) and the terminal no-pairing (~669). Structural rejects (collinearity, anti-parallel, along-line overlap, V-corner, extCap) survive `hardFloor = 0`, so both sites can still be reached — the fallback covers them.

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (add `ultimateFallback`; guard both null sites)
- Test: `src/render/layout/tests/rowPlace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('relaxed: coincident lanes never return null (ultimate fallback)', () => {
  // the exact fixture that boxes today (two identical lanes, no feasible pairing)
  const a = through([[-2, 0], [2, 0]], [0, 0]);
  const b = through([[-2, 0], [2, 0]], [0, 0]);
  assert.equal(solveRows([a, b], [[0], [1]], OPTS), null, 'octilinear boxes');
  const sol = solveRows([a, b], [[0], [1]], { ...OPTS, relaxed: true });
  assert.ok(sol, 'relaxed must never return null');
  assert.equal(sol.pos.length, 2);
  assert.equal(sol.order.length, 2);
});

test('relaxed: never returns null across adversarial fixtures', () => {
  const fixtures: Array<[ReturnType<typeof lane>[], number[][]]> = [
    [[lane(0, 0), lane(2, 0)], [[0, 1]]],                    // pinch
    [[through([[-2, 0], [2, 0]], [0, 0]), through([[-2, 0], [2, 0]], [0, 0])], [[0], [1]]], // coincident
    [[lane(0, 0), lane(0.3, 0), lane(0.6, 0)], [[0], [1], [2]]], // three near-coincident bundles
  ];
  for (const [curves, groups] of fixtures) {
    const sol = solveRows(curves, groups, { ...OPTS, relaxed: true });
    assert.ok(sol, `relaxed returned null for groups ${JSON.stringify(groups)}`);
    assert.equal(sol.pos.filter(Boolean).length, curves.length, 'every mark seated');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: FAIL — the relaxed calls return null (no fallback yet).

- [ ] **Step 3: Add the `ultimateFallback` helper**

In `solveRows`, right after `const anchorPos = curves.map((c) => curvePoint(c, c.anchorT));` (~158):

```ts
  // Ultimate non-null seat for relaxed mode: every mark at its own lane anchor
  // (its natural crossing point), bundles concatenated in lane order, no corners.
  // A large sentinel cost keeps any real chain preferred; this only ever returns
  // when no feasible chain exists at all.
  const ultimateFallback = (): RowSolution => {
    const pos: Pixel[] = new Array(n);
    const order: number[] = [];
    for (const grp of groups) for (const gi of grp) { pos[gi] = anchorPos[gi]; order.push(gi); }
    return { pos, order, cornerAfter: new Map(), cost: Number.MAX_SAFE_INTEGER };
  };
```

- [ ] **Step 4: Guard the empty-states null (~266)**

Replace:

```ts
  if (bundleStates.some((st) => st.length === 0)) {
    debugNoFeasibleRow(groups, bundleStates, statsArr, anchorPos, g, minGap, opts.dbgLabel, hyp);
    return null;
  }
```

with:

```ts
  if (bundleStates.some((st) => st.length === 0)) {
    debugNoFeasibleRow(groups, bundleStates, statsArr, anchorPos, g, minGap, opts.dbgLabel, hyp);
    if (relaxed) return ultimateFallback();
    return null;
  }
```

- [ ] **Step 5: Guard the terminal no-pairing null (~669)**

Replace:

```ts
  if (!best) {
    debugNoPairing(dbgMinNonAdj, g, minGap, opts.dbgLabel);
    return null;
  }
```

with:

```ts
  if (!best) {
    debugNoPairing(dbgMinNonAdj, g, minGap, opts.dbgLabel);
    if (relaxed) return ultimateFallback();
    return null;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: both new tests PASS; all existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/tests/rowPlace.test.ts
git commit -F <msgfile>   # "feat(rowPlace): relaxed mode never returns null (ultimate fallback)"
```

---

## Task 3: Wire the relaxed final seat into the escalation ladder

Replace the single-bundle mega tail (`renderOctilinear.ts` ~2205-2218) with a relaxed `solveRows` call (guaranteed non-null), committed and hull-booked like a normal seat. Keep the multi-bundle platform split.

**Files:**
- Modify: `src/render/renderOctilinear.ts` (mega tail ~2205-2218; `megaFallbacks` init ~1795; `reportMegaFallbacks` call ~2223; import ~8)

- [ ] **Step 1: Replace the mega tail with the relaxed seat**

Find the single-bundle tail after the platform-split `if (clusters.length >= 2) { ... continue; }` block (the lines that currently read):

```ts
          // spec v2 §3: total fallback — the mega box covers all bundles.
          // Structural residual: a bundle whose member lanes are coincident
          // (interlined on one drawn line) or pinch below minGap inside the
          // slide window admits zero feasible row states — the row-line ×
          // lane-curve intersection degenerates there — so the station boxes
          // (the mega branch in stops.ts renders it).
          megaFallbacks++;
          for (const mk of s.marks) mk.mega = true;
          // Regime probe (OCTI_PLACE_DEBUG): deg = incident DRAWN edges (octi
          // ports/directions used), ldeg = total lines through the node. deg<=8
          // with ldeg>deg means lines are welded onto few corridors → fan-fold /
          // over-weld (fix = de-weld). deg>8 means genuine 8-direction saturation
          // (fix = split the hub; we cannot add directions without breaking octi).
          reportBoxRegime({ layout, edges: layout.edges, nodeId: s.nodeId, marks: s.marks, ldeg: ldegOf(s.nodeId), groups });
```

Replace that block with:

```ts
          // Relaxed final seat (never null): the octilinear ladder exhausted, so
          // take a guaranteed non-octilinear, overlap-allowed seat instead of a
          // mega box. Hull penetration and true-stacking become heavy proximity
          // (never a veto), so the solve seats with least overlap and the
          // ultimate fallback is only a backstop.
          const relaxedSol = solveRows(solveCurves, groups, {
            ...ropts,
            relaxed: true,
            blocked: undefined,
            proximity: (p: Pixel) => {
              let pen = ropts.proximity(p);
              const hd = hullClearance(p);
              if (hd < 0) pen += 1000 * -hd;
              for (const q of placedDots) {
                const dd = hyp(p[0] - q[0], p[1] - q[1]);
                if (dd < xMaskStack) pen += 1000 * (xMaskStack - dd);
              }
              return pen;
            },
          })!; // relaxed mode is guaranteed non-null
          for (let k = 0; k < relaxedSol.order.length; k++) {
            const i = relaxedSol.order[k];
            s.marks[i].pos = relaxedSol.pos[i];
            s.marks[i].chain = k;
            const corner = relaxedSol.cornerAfter.get(k);
            if (corner) s.marks[i].cornerAfter = corner;
          }
          // Hull bookkeeping so later stations mask against this seat (mirrors the
          // verify block's push; capsHullOf is declared after this loop).
          const rvVerts: Pixel[] = [];
          for (let k = 0; k < relaxedSol.order.length; k++) {
            rvVerts.push(relaxedSol.pos[relaxedSol.order[k]]);
            const c = relaxedSol.cornerAfter.get(k);
            if (c) rvVerts.push(c);
          }
          const rvHull: Hull = [];
          for (let k = 1; k < rvVerts.length; k++) rvHull.push({ a: rvVerts[k - 1], b: rvVerts[k], half: r + 3 });
          if (rvHull.length === 0) rvHull.push({ a: rvVerts[0], b: rvVerts[0], half: r + 3 });
          placedHulls.push({ nodeId: s.nodeId, hull: rvHull });
```

- [ ] **Step 2: Delete the `megaFallbacks` counter and its report**

Delete the counter init (~1795):

```ts
    let megaFallbacks = 0; // spec v2 §3: stations boxed for infeasibility
```

Delete the report call (~2223):

```ts
    reportMegaFallbacks(megaFallbacks);
```

- [ ] **Step 3: Drop the now-unused debug imports**

In the import at line 8, remove `reportBoxRegime, reportMegaFallbacks,` (leave `reportCapsOvlStats, reportCapsAudit, ...` and the rest intact):

```ts
  reportCapsOvlStats, reportCapsAudit,
```

- [ ] **Step 4: Verify the build and existing tests**

Run: `npx tsx --test "src/**/*.test.ts"`
Expected: PASS. (No unit test targets this wiring directly; `mega` flag, `isBoxed`, `boxStation`, `megas` all remain and compile.)

- [ ] **Step 5: Verify the output changed only at former-mega stations**

Run the byte-identity harness before and after is not possible post-hoc; instead diff against the committed baseline. Capture current hashes:

Run: `BI_ONLY=SEA,SF,NYC npx tsx dev/_byte-identity.ts | tee /tmp/bi_after.txt` (background — renders are slow)
Expected: hashes differ ONLY on maps that contain mega stations (SEA/SF), and the differences localize to former-mega nodes. Maps with no megas stay byte-identical. Confirm by rendering one former-mega station (see Task 7).

- [ ] **Step 6: Commit**

```bash
git add src/render/renderOctilinear.ts
git commit -F <msgfile>   # "feat(octi): seat over-dense stations with the relaxed solver, not a mega box"
```

---

## Task 4: `placement.ts` residual renders the curve pill; delete the box branch

**Files:**
- Modify: `src/render/stations/placement.ts` (`PlacementCtx.megaFallback` ~20; `SceneGeom.megaBB` ~72; `isMega` block ~154-211; `median` ~55-59; `debugMegaBox` import ~12)
- Test: `src/render/stations/tests/placement.test.ts` (~28-41)

- [ ] **Step 1: Update the placement tests first**

In `placement.test.ts`, DELETE the mega→box test entirely:

```ts
test('mega marks with megaFallback box -> box, no dots', () => {
  const marks = [mk('A', 0, 0, { mega: true }), mk('B', 12, 4, { mega: true }), mk('C', 4, 12, { mega: true })];
  const s = buildScene('n1', marks, { megaFallback: 'box' });
  assert.equal(s.capsule.kind, 'box');
  assert.equal(s.lines.length, 0);
});
```

REPLACE the mega→curve test (which passes `{ megaFallback: 'curve' }`) with a no-option version:

```ts
test('mega marks -> smooth pill, dots kept (residual curve)', () => {
  const marks = [mk('A', 0, 0, { mega: true }), mk('B', 12, 4, { mega: true }), mk('C', 4, 12, { mega: true })];
  const s = buildScene('n1', marks, {});
  assert.equal(s.capsule.kind, 'pill');
  assert.equal((s.capsule as { smooth: boolean }).smooth, true);
  assert.equal(s.lines.length, 3);
});
```

Also change the shared `ctx` (~line 6) from `const ctx = { megaFallback: 'curve' as const };` to:

```ts
const ctx = {};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/render/stations/tests/placement.test.ts`
Expected: FAIL — `buildScene`'s `ctx` still requires `megaFallback`; `{ megaFallback: 'box' }` no longer valid once removed, and the box branch still returns `box`.

- [ ] **Step 3: Remove `PlacementCtx.megaFallback`**

In `placement.ts`, delete the field (~line 20) from `interface PlacementCtx`:

```ts
  megaFallback: 'box' | 'curve';
```

- [ ] **Step 4: Remove `megaBB` from `SceneGeom` and update the comment**

Delete the `megaBB` field (~72). Reword the doc comment above `SceneGeom` (~61-67) to drop the "both mega variants / megaFallback toggle" language, e.g.:

```ts
// Repaint memo of the pure mark-geometry pieces of a scene: the farthest-pair
// axis, the pill spine, and the residual squircle spine. Marks are final when
// paint starts and the cached geometry reuses the SAME array objects across
// repaints, so array identity keys everything that depends only on mark
// positions. A deserialized cache refills the memo on its first paint.
interface SceneGeom {
  ai: number;
  best: number;
  pill?: { points: Point[]; anchor: Point };
  megaSpine?: { points: Point[]; anchor: Point };
}
```

- [ ] **Step 5: Collapse the `isMega` block to the curve pill only**

Replace the whole `isMega` block (~154-211) with:

```ts
  // Over-dense residual: the relaxed solver seats normal stations, but the
  // no-overlap-floor last resort can still flag a colliding small station.
  // Render it as the squircle pill (per-line dots kept), the prior default.
  const isMega = marks.some((m) => m.mega);
  if (isMega) {
    if (!gm.megaSpine) {
      let pi = 0, pj = 0, pbest = -1;
      for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) {
        const dx = marks[i].pos[0] - marks[j].pos[0], dy = marks[i].pos[1] - marks[j].pos[1];
        const dd = dx * dx + dy * dy;
        if (dd > pbest) { pbest = dd; pi = i; pj = j; }
      }
      const A = marks[pi].pos, B = marks[pj].pos;
      let axx = B[0] - A[0], axy = B[1] - A[1];
      const alen = Math.sqrt(axx * axx + axy * axy) || 1;
      axx /= alen; axy /= alen;
      const orderedPos = marks
        .map((m, i) => ({ p: m.pos as Point, t: (m.pos[0] - A[0]) * axx + (m.pos[1] - A[1]) * axy, i }))
        .sort((u, v) => (u.t - v.t) || (u.i - v.i))
        .map((u) => u.p);
      const spine = rdpSimplify(orderedPos, 0.75) as Point[];
      const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
      const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
      gm.megaSpine = { points: spine, anchor: [cx, cy] };
    }
    const ms = gm.megaSpine;
    return { nodeId, lines, capsule: { kind: 'pill', points: ms.points.map((p): Point => [p[0], p[1]]), smooth: true }, anchor: [ms.anchor[0], ms.anchor[1]], dotRadius };
  }
```

- [ ] **Step 6: Delete the now-dead `median` helper and `debugMegaBox` import**

Delete `median` (~55-59) and the import `import { debugMegaBox } from '../debug/stops.debug';` (~12). If `SPACING` (~17) is now unused, delete it and prune its `LINE_GAP`/`LINE_WIDTH` import only if nothing else uses them (grep first).

- [ ] **Step 7: Drop `megaFallback` from the rectRows test's `buildScene` ctx**

`placement.rect.test.ts` passes `megaFallback: 'curve'` into `buildScene`'s ctx at ~lines 25, 34, 48, 68, 76, 86. With `PlacementCtx.megaFallback` gone (Step 3) these are excess-property TS errors. Remove `megaFallback: 'curve'` (or `megaFallback: 'curve' as const`) from each of those ctx objects; leave every other ctx field. (`index.test.ts` passes it to `renderStations`, not `buildScene` — that one is handled in Task 5.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx --test src/render/stations/tests/placement.test.ts src/render/stations/tests/placement.rect.test.ts`
Expected: PASS. (`index.test.ts` still references `megaFallback` on the `renderStations` ctx until Task 5; do not run it here.)

- [ ] **Step 9: Commit**

```bash
git add src/render/stations/placement.ts src/render/stations/tests/placement.test.ts src/render/stations/tests/placement.rect.test.ts
git commit -F <msgfile>   # "refactor(stations): residual renders the curve pill; delete the mega box branch"
```

---

## Task 5: Delete the `megaFallback` option plumbing

Remove `megaFallback` from every renderer surface. The single consumer (placement `ctx`) no longer reads it, so this is pure deletion.

**Files:**
- Modify: `src/render/types.ts` (field ~85, default ~191, two doc refs ~88/~138)
- Modify: `src/render/schematic.ts` (~92)
- Modify: `src/render/renderGeographic.ts` (~1461, ~1501, ~1526)
- Modify: `src/render/stations/render.ts` (~12, ~47)
- Modify: `src/render/renderOctilinear.ts` (arg ~361-364; `renderStations` call ~3891)

- [ ] **Step 1: `types.ts`**

Delete the `megaFallback` doc + field (~80-85) and the `DEFAULT_OPTIONS.megaFallback: 'box',` line (~191). Reword the two doc comments that name it (`stationDesign` ~88, `landmass` ~138) to drop "like megaFallback":

```ts
   *  Draw-time only — never changes the layout and is excluded from the cache
```
```ts
   *  Draw-time only. Excluded from the cache fingerprint, so toggling it just
```

- [ ] **Step 2: `schematic.ts`**

Delete the `megaFallback: opts.megaFallback,` line (~92).

- [ ] **Step 3: `renderGeographic.ts`**

Remove `megaFallback?: 'box' | 'curve';` from the `drawSmoothed` opts param type (~1461); delete the `megaFallback: opts.megaFallback ?? 'curve',` args line (~1501); remove `megaFallback: opts.megaFallback,` from the `renderSmoothed → drawSmoothed` call (~1526).

- [ ] **Step 4: `stations/render.ts`**

Delete `megaFallback: 'box' | 'curve';` from `RenderStationsCtx` (~12) and `megaFallback: ctx.megaFallback,` from the `buildScene` ctx (~47).

- [ ] **Step 4b: `stations/tests/index.test.ts`**

The renderStations integration test passes `{ dark, showBullets, megaFallback: 'curve' }` as the ctx (~47). With `RenderStationsCtx.megaFallback` gone this is an excess-property error — remove `megaFallback: 'curve'` from that ctx object, leaving `dark`/`showBullets` (and any other fields).

- [ ] **Step 5: `renderOctilinear.ts`**

Delete the `megaFallback` arg doc + field (~361-364). In the `renderStations` call (~3891), remove `megaFallback: args.megaFallback ?? 'curve',`.

- [ ] **Step 6: Verify the build and full suite**

Run: `npx tsx --test "src/**/*.test.ts"`
Expected: PASS. Grep to confirm no stray reader remains in the render layer:

Run: `grep -rn "megaFallback" src/render` — expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add src/render/types.ts src/render/schematic.ts src/render/renderGeographic.ts src/render/stations/render.ts src/render/renderOctilinear.ts src/render/stations/tests/index.test.ts
git commit -F <msgfile>   # "refactor(render): remove the megaFallback option (box/curve is no longer a choice)"
```

---

## Task 6: Delete `reportMegaFallbacks` and `reportBoxRegime`

**Files:**
- Modify: `src/render/debug/renderOctilinear.debug.ts` (~164-191)

- [ ] **Step 1: Delete both functions**

Delete `reportBoxRegime` (~164-185, with its doc comment) and `reportMegaFallbacks` (~187-191, with its doc comment).

- [ ] **Step 2: Verify no references remain**

Run: `grep -rn "reportBoxRegime\|reportMegaFallbacks" src` — expected: no matches (their imports/calls were removed in Task 3).
Run: `npx tsx --test "src/**/*.test.ts"` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/render/debug/renderOctilinear.debug.ts
git commit -F <msgfile>   # "chore(debug): drop the mega-box regime/fallback probes (path removed)"
```

---

## Task 7: Delete the "Hubs" Curve/Box UI toggle

Every edit removes ONLY `megaFallback`; leave every co-listed property/dep intact.

**Files:**
- Modify: `src/ui/SchematicPanel.tsx` (constant ~119; `RestoredSettings` ~236; state ~305; `switchMode` ~511; seed `visual` ~542; svg useMemo opts+dep ~806/~819; `writeModeSettings`+dep ~880/~883; saved settings+dep ~1052/~1077; `applyBundle` type ~1097; restore ~1131; throttle dep ~1682; button ~1787-1795; DetailInset prop ~2461)
- Modify: `src/ui/DetailInset.tsx` (prop ~66-68; destructure ~111; drawResim opts ~270; dep ~371)

- [ ] **Step 1: Delete the button**

In `SchematicPanel.tsx`, delete the whole toggle block (~1787-1795):

```tsx
        {mode === 'smoothed' && smoothedReady && (
          <button
            onClick={() => requestToggle(() => setMegaFallback((v) => (v === 'box' ? 'curve' : 'box')))}
            style={toggleStyle(megaFallback === 'curve')}
            title="Dense-hub fallback shape when a bundle can't seat octilinearly: Box (rectangle) or Curve (squircle)"
          >
            {megaFallback === 'curve' ? 'Hubs: Curve' : 'Hubs: Box'}
          </button>
        )}
```

(Do NOT touch the adjacent "Warp boxes"/"Regenerate" buttons. `requestToggle`/`toggleStyle` are shared — leave them.)

- [ ] **Step 2: Delete the constant, state, and restore/seed lines**

Delete: `DEFAULT_MEGA_FALLBACK` const + comment (~119-120); the `const [megaFallback, setMegaFallback] = useState...` + its 2-line comment (~305-307); `setMegaFallback(v.megaFallback ?? DEFAULT_MEGA_FALLBACK);` (~511); `if (s.megaFallback === 'box' || s.megaFallback === 'curve') setMegaFallback(s.megaFallback);` (~1131); the `megaFallback={megaFallback}` prop on `<DetailInset>` (~2461).

- [ ] **Step 3: Remove `megaFallback` from the two settings type declarations**

Delete `megaFallback?: 'box' | 'curve';` from `RestoredSettings` (~236) and from the inline `applyBundle` settings type (~1097).

- [ ] **Step 4: Remove `megaFallback` from the four object literals and five dep arrays**

Remove the single `megaFallback` / `megaFallback: shared.megaFallback` entry from: the seed `visual` object (~542); the svg `drawSmoothedSchematic` opts (~806); `writeModeSettings(...)` (~880); the saved `settings` object (~1052). Remove `megaFallback` from the dep arrays at ~819, ~883, ~1077, ~1682 (SchematicPanel). Every other entry in each stays.

- [ ] **Step 5: `DetailInset.tsx`**

Delete the `megaFallback` prop doc + field (~66-68); remove `megaFallback,` from the destructure (~111); remove `megaFallback` from the `drawSmoothedSchematic` opts (~270); remove `megaFallback` from the effect dep array (~371).

- [ ] **Step 6: Verify no references remain and the UI compiles**

Run: `grep -rn "megaFallback\|MEGA_FALLBACK" src/ui` — expected: no matches.
Run: `npx tsx --test "src/**/*.test.ts"` — expected: PASS (UI has no unit tests; this confirms the render layer still builds under the transpiler).

- [ ] **Step 7: Commit**

```bash
git add src/ui/SchematicPanel.tsx src/ui/DetailInset.tsx
git commit -F <msgfile>   # "refactor(ui): remove the Hubs Curve/Box toggle"
```

---

## Task 8: Free-angle rows in `buildStates` (determinism-gated)

Enumerate rows at a quantized angle fan around the bundle perpendicular instead of the four octilinear axes, when `relaxed`. Octilinear mode (`relaxed` false) stays byte-identical.

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (fan constants near `AXES` ~65-73; `buildStates` enumeration ~189-249)
- Test: `src/render/layout/tests/rowPlace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('relaxed free-angle: a 22.5° bundle seats off the octilinear axes', () => {
  // three lanes whose perpendicular is ~22.5° (between two octilinear axes):
  // the octilinear rest would pay a 45°-step rotation, free-angle seats along
  // the natural angle, so the dots are NOT axis-aligned.
  const t = Math.tan(Math.PI / 8); // 22.5°
  const mkLane = (k: number): ReturnType<typeof through> =>
    through([[-60, -60 * t + k * 6], [60, 60 * t + k * 6]], [0, k * 6]);
  const curves = [mkLane(0), mkLane(1), mkLane(2)];
  const sol = solveRows(curves, [[0, 1, 2]], { ...OPTS, relaxed: true });
  assert.ok(sol, 'free-angle must seat');
  // adjacent dot deltas are neither axis-aligned nor 45°: assert a non-octilinear
  // direction (dx and dy both clearly non-zero and |dx| != |dy|)
  const dx = sol.pos[1][0] - sol.pos[0][0], dy = sol.pos[1][1] - sol.pos[0][1];
  assert.ok(Math.abs(dx) > 0.5 && Math.abs(dy) > 0.5 && Math.abs(Math.abs(dx) - Math.abs(dy)) > 0.5,
    `expected a non-octilinear row direction, got d=(${dx},${dy})`);
});

test('relaxed free-angle: deterministic (same input twice → identical seat)', () => {
  const curves = [lane(0, 0), lane(2, 0), lane(4, 0)];
  const a = solveRows(curves, [[0], [1], [2]], { ...OPTS, relaxed: true })!;
  const b = solveRows(curves, [[0], [1], [2]], { ...OPTS, relaxed: true })!;
  assert.deepEqual(a.pos, b.pos);
  assert.deepEqual([...a.cornerAfter], [...b.cornerAfter]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: FAIL — the seat is still octilinear (axis-aligned), so the first test fails.

- [ ] **Step 3: Add fan constants near `AXES`**

After the `AXES` block (~73):

```ts
// Relaxed free-angle fan: symmetric offsets (in REL_STEP units) around the
// bundle perpendicular. offset 0 = the natural angle (rot 0). Quantize the
// resulting unit vector to 1e-6 so cos/sin (not correctly-rounded cross-V8)
// stay bit-identical, mirroring the atan2 quantization in buildStates.
const REL_FAN: ReadonlyArray<number> = [-2, -1, 0, 1, 2];
const REL_STEP = QUARTER / 2; // 22.5° between fan angles; fan spans ±45°
const quantU = (ang: number): Pixel => [
  Math.round(Math.cos(ang) * 1e6) / 1e6,
  Math.round(Math.sin(ang) * 1e6) / 1e6,
];
```

- [ ] **Step 4: Enumerate the fan in `buildStates`**

Replace the axis loop header and its `u`/`rot` derivation. The current loop (~189-196, 239-240) reads:

```ts
      for (let axis = 0; axis < 4; axis++) {
        if (stats) stats.tried++;
        const u = AXES[axis];
```
…and later…
```ts
        const dIdx = (((axis - restIdx) % 4) + 4) % 4;
        const rot = Math.min(dIdx, 4 - dIdx); // 45° steps from rest: 0..2
```

Restructure to iterate a mode-dependent list, computing `u`, `rot`, and the stored `axis` up front:

```ts
      const enumList = relaxed ? REL_FAN : [0, 1, 2, 3];
      for (const fi of enumList) {
        if (stats) stats.tried++;
        let u: Pixel;
        let rot: number;
        let axis: number;
        if (relaxed) {
          u = quantU(perpAng + fi * REL_STEP);
          rot = Math.abs(fi) * REL_STEP / QUARTER; // angular deviation in 45° units
          axis = -1; // free-angle sentinel (parallelism uses |cross|, not this)
        } else {
          u = AXES[fi];
          const dIdx = (((fi - restIdx) % 4) + 4) % 4;
          rot = Math.min(dIdx, 4 - dIdx);
          axis = fi;
        }
```

Then DELETE the old `const dIdx` / `const rot` lines (~239-240) since `rot` is now computed above, and leave the rest of the body unchanged (`dots`, `feas`, `pr`, the `cost` expression already reads `rot`, and the pushed state reads `axis`/`u`). Note `buildStates` must see `relaxed`, `perpAng`, `REL_FAN`, `REL_STEP`, `quantU` — all in scope (`relaxed`/`perpAng` are locals; the constants are module-level).

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: both new tests PASS; existing tests PASS (octilinear `fi` = 0..3 with `axis = fi`, identical `u`/`rot`, byte-identical).

- [ ] **Step 6: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/tests/rowPlace.test.ts
git commit -F <msgfile>   # "feat(rowPlace): relaxed mode enumerates free-angle rows (quantized u)"
```

---

## Task 9: Free-angle pairing in `pairEval`

Two free-angle rows almost never share the integer `axis`, so parallel detection must use the row directions, not `P.axis === Q.axis`. The V-branch divides by `cross = P.u × Q.u`, which explodes for near-parallel free angles — route those to the collinear branch.

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (`pairEval` parallel/V split ~313-335)
- Test: `src/render/layout/tests/rowPlace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('relaxed free-angle: near-parallel rows join without an extCap blowup', () => {
  // two 2-member bundles whose free-angle rows come out near-parallel; the pair
  // must join end-to-end (collinear branch), not divide by a ~0 cross.
  const curves = [lane(0, -20), lane(2, -20), lane(0, 20), lane(2, 20)];
  const sol = solveRows(curves, [[0, 1], [2, 3]], { ...OPTS, relaxed: true });
  assert.ok(sol, 'near-parallel free-angle pair must seat non-null');
  assert.equal(sol.pos.filter(Boolean).length, 4);
});
```

- [ ] **Step 2: Run to verify it fails or is flaky**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: FAIL or a wildly displaced corner — near-parallel rows take the V-branch and divide by `cross ≈ 0`.

- [ ] **Step 3: Hoist `cross` and gate the parallel branch**

In `pairEval`, the `u`/outward setup ends just before `if (P.axis === Q.axis) {`. Insert the cross computation and replace the branch condition:

```ts
    const cross = P.u[0] * Q.u[1] - P.u[1] * Q.u[0];
    const parallel = relaxed ? Math.abs(cross) < 1e-3 : P.axis === Q.axis;
    let corner: Pixel;
    let ext1: number;
    let ext2: number;
    if (parallel) {
```

Inside the `else` (V) branch, DELETE the now-duplicate `const cross = P.u[0] * Q.u[1] - P.u[1] * Q.u[0];` line (~330) — reuse the hoisted `cross`. Everything else in both branches is unchanged. (Octilinear stays byte-identical: `parallel` = `P.axis === Q.axis`, and the hoisted `cross` equals the value the V-branch computed before.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/render/layout/tests/rowPlace.test.ts`
Expected: the new test PASSES; all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/tests/rowPlace.test.ts
git commit -F <msgfile>   # "fix(rowPlace): detect parallel free-angle rows by cross, not axis index"
```

---

## Task 10: Verification checkpoint

- [ ] **Step 1: Full suite**

Run: `npx tsx --test "src/**/*.test.ts"`
Expected: PASS (all suites).

- [ ] **Step 2: Byte-identity diff (background — renders are slow)**

Run: `npx tsx dev/_byte-identity.ts > /tmp/bi_head.txt` on the commit BEFORE this branch's first solver change (checkout the base, run, restore), and again on HEAD. Diff.
Expected: maps with no mega/curve-residual stations are byte-identical; every changed hash traces to a former-mega station now seated (SEA/SF families).

- [ ] **Step 3: Former-mega render (visual)**

Render a map with a known mega (SEA or SF) via the dev harness, rasterize to PNG, and inspect the former-mega hub: it must show real per-line dots seated (overlap only where forced), not a blob. Surface the PNG at the checkpoint.

- [ ] **Step 4: Cross-V8 determinism (free-angle gate)**

Run the ULP harness (`dev/ulpRun.ts` / `dev/_ulpcheck.ts`) over a mega-bearing dump.
Expected: zero cross-engine divergence on the relaxed seats. If free-angle diverges and cannot be quantized clean, revert Tasks 8-9 (keep Tasks 1-7: overlap-first still removes megas and allows overlap) and record the outcome.

- [ ] **Step 5: `mega` still type-consistent**

Run: `grep -rn "\.mega\b" src/render/renderOctilinear.ts` — expected: `isBoxed`, `boxStation`, `megas`, the dot filters, and `addStop` still reference `mega` (fed by the residual `boxStation` passes). These are intentionally retained for Part 2.

- [ ] **Step 6: Final commit / branch state**

No code change; this task is verification. Leave the branch `feature/relaxed-mega-solver` ready for the in-game check and the Part 2 design.

---

## Notes for Part 2 (separate design)

- `mega` flag + `curve` residual + the `box` capsule kind + the Tokyu/London `designs.test.ts` box tests all remain after Part 1.
- Part 2 reworks `boxStation` (mega-slide ~2417 goes dead once placement megas are gone; no-overlap-floor ~3185 needs a non-boxing resolution — its replacement strategy is the Part 2 design question), then deletes `mega`, the `curve` residual, and the `box` kind.
- `mapCache` VERSION: unchanged in Part 1 (`megaFallback` was draw-time / not in the key; the `mega`/StopMark shape is unchanged). Re-evaluate a bump in Part 2 if the serialized `StopMark` shape changes.
