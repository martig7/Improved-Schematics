# Escalation-Ladder Rewrite + Far-Attach Capsules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `computeRibbonGeometry`'s 4-stage marker-placement escalation (up to ~9 `solveRows` calls) into 2 solve stages (≤3 calls), folding in a corridor-bounded "far-attach" rescue that joins a far-apart station group's per-bundle rows into ONE continuous capsule by sliding them along their corridors until they align.

**Architecture:** Three additive `RowOpts` options in the rigid-row solver (`slideRange` per-bundle slide bounds, `latTol` parallel-join tolerance, `softBand`/`softW` soft sub-floor gap band), then a rewrite of the caller's ladder: PRIMARY solve (wide window, hull masks baked in, soft band replacing the box-rescue walk) → FAR-ATTACH (coarse corridor solve + fine re-anchored polish, only on primary failure with spread-out bundles) → VERIFY (existing hull check, retry deleted) → platform split → mega box. Spec: `docs/superpowers/specs/2026-07-04-escalation-ladder-rewrite-design.md`.

**Tech Stack:** TypeScript, node:test via `tsx --test`, offline render harness (`dev/render-from-dump.ts`, resvg).

**Base:** branch `cursor/c4b3d42d` (per-station platform nodes + platform-split fallback) merged into the working branch. All line numbers below are for the MERGED tree; use the quoted code as the search anchor, not the line number.

**Typecheck caveat (discovered in Task 0):** the base branch has 31 PRE-EXISTING `npm run typecheck` errors (all in `imageMerge.ts`, `topo.ts`, `renderGeographic.ts`). Wherever a step says `npm run typecheck && npm test`, read it as: run `npm run typecheck`, confirm the error count is still ≤31 and none of the errors touch files you changed, then run `npm test` (which must be 0 failures). Do NOT fix the pre-existing errors.

---

### Task 0: Merge base branch, commit spec, capture baseline

**Files:**
- Modify: (merge) — brings `renderOctilinear.ts` platform-split queue, per-station graph nodes, SCHEMA 18
- Create: `docs/superpowers/specs/2026-07-04-escalation-ladder-rewrite-design.md` (already written)
- Create: `dev/_base-id.log`, `dev/_base-tod.log` (baseline diagnostics, NOT committed)

- [ ] **Step 1: Merge `cursor/c4b3d42d` into the working branch**

```bash
git merge cursor/c4b3d42d -m "merge: per-station platform nodes + platform-split fallback (base for ladder rewrite)"
```

Expected: clean merge (the worktree branch has no local commits beyond the shared history). If conflicts appear, stop and resolve with the `cursor/c4b3d42d` side preferred for `renderOctilinear.ts`/`topo.ts`/`graph.ts`.

- [ ] **Step 2: Verify the merged tree is green**

```bash
npm run typecheck && npm test
```

Expected: PASS (0 failures).

- [ ] **Step 3: Capture placement baseline from the three city dumps**

The canonical dumps are v2 map bundles in the MAIN checkout root (`C:\Users\darkd\Downloads\Improved Schematics\improvedschematics-map-{NYC-EXTRA-DIFFICULT,LON-3,SEA-2}.json`); the render input lives under their `inputDump` key. Extract once, then render:

```bash
for c in "nyc:improvedschematics-map-NYC-EXTRA-DIFFICULT.json" "lon:improvedschematics-map-LON-3.json" "sea:improvedschematics-map-SEA-2.json"; do
  n=${c%%:*}; f=${c#*:}
  node -e "const j=JSON.parse(require('fs').readFileSync('C:/Users/darkd/Downloads/Improved Schematics/$f','utf8')); require('fs').writeFileSync('dev/_in-$n.json', JSON.stringify(j.inputDump));"
  OCTI_PLACE_DEBUG=1 npx tsx dev/render-from-dump.ts dev/_in-$n.json dev/_base-$n 2> dev/_base-$n.log
done
grep -c "platform-split" dev/_base-nyc.log dev/_base-lon.log dev/_base-sea.log || true
grep "mega-box fallbacks" dev/_base-*.log || true
grep -c "capsovl" dev/_base-*.log || true
```

Record the counts in the task notes (they are the comparison target for Task 6). Keep the `dev/_base-*` PNG/SVG outputs for the visual diff.

- [ ] **Step 4: Commit the spec**

```bash
git add docs/superpowers/specs/2026-07-04-escalation-ladder-rewrite-design.md docs/superpowers/plans/2026-07-04-escalation-ladder-rewrite.md
git commit -m "docs: escalation-ladder rewrite + far-attach capsule spec/plan"
```

---

### Task 1: `RowOpts.slideRange` — per-bundle asymmetric slide bounds

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (RowOpts interface ~line 16; `buildStates` ~line 143; call site ~line 237)
- Test: `src/render/layout/rowPlace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/render/layout/rowPlace.test.ts` (reuses the file's existing `PITCH`/`MINGAP`/`OPTS` constants and `Pixel` import):

```ts
// vertical through-lane at x, spanning ±300px of the anchor (window 400 —
// far larger than the legacy ±24/±48 solve windows)
const laneVFar = (x: number, ay = 0) =>
  buildLaneCurve(
    [[[x, ay - 300], [x, ay + 300]] as Pixel[], [[x, ay + 300], [x, ay - 300]] as Pixel[]],
    [x, ay],
    400,
  );

test('slideRange: corridor states beyond arcLimit are reachable', () => {
  // two vertical lanes 5.5px apart; every dot within |y| < 79.5 is vetoed, so
  // the only feasible rows sit far beyond the ±24 arcLimit window — reachable
  // only through the per-bundle slideRange override
  const curves = [laneVFar(0), laneVFar(PITCH)];
  const blocked = (p: Pixel) => Math.abs(p[1]) < 79.5;
  assert.equal(
    solveRows(curves, [[0, 1]], { ...OPTS, blocked }),
    null,
    'everything inside the arcLimit window is vetoed',
  );
  const sol = solveRows(curves, [[0, 1]], {
    ...OPTS,
    blocked,
    step: 4,
    slideRange: [[-150, 150]],
  });
  assert.ok(sol, 'slideRange must reach the far seat');
  for (const p of sol.pos) {
    assert.ok(Math.abs(p[1]) >= 79.5 && Math.abs(p[1]) <= 150 + 1e-6, `dot at ${p}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test src/render/layout/rowPlace.test.ts
```

Expected: FAIL — TypeScript/runtime rejects `slideRange` (unknown option) or the second solve returns null.

- [ ] **Step 3: Implement `slideRange`**

In `src/render/layout/rowPlace.ts`:

(a) Add to `RowOpts` (after `extCap`):

```ts
  /** Per-bundle asymmetric slide bounds [minS, maxS] along the carrier curve
   *  (indexed like `groups`), overriding ±arcLimit for that bundle. The far
   *  corridor tier bounds each bundle at half its incident corridor so a
   *  sliding row never invades the neighbouring stop's territory. */
  slideRange?: Array<[number, number]>;
```

(b) In `buildStates`, change the signature to take the bundle index and replace the symmetric slide loop. Current code:

```ts
  const buildStates = (group: number[], stats?: BundleStat): RowState[] => {
```

becomes

```ts
  const buildStates = (group: number[], bi: number, stats?: BundleStat): RowState[] => {
```

and the loop header block

```ts
    const m = Math.max(0, Math.round(arcLimit / step));
    const states: RowState[] = [];
    for (let j = -m; j <= m; j++) {
      const s = j * step;
```

becomes

```ts
    const range = opts.slideRange?.[bi];
    const lo = range ? range[0] : -arcLimit;
    const hi = range ? range[1] : arcLimit;
    const jLo = Math.ceil(lo / step - 1e-9);
    const jHi = Math.floor(hi / step + 1e-9);
    const states: RowState[] = [];
    for (let j = jLo; j <= jHi; j++) {
      const s = j * step;
```

(No-override behavior is bit-identical: `lo = -arcLimit, hi = arcLimit` yields the same `j` set as `-m..m`.)

(c) Update the call site (~line 237):

```ts
  const bundleStates = groups.map((grp, i) => {
```

— inside, pass the index through: `buildStates(grp, i, st)` (match the existing call's stats argument).

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test src/render/layout/rowPlace.test.ts && npm run typecheck
```

Expected: all PASS (existing tests unaffected — defaults reproduce the old loop).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/rowPlace.test.ts
git commit -m "feat(render): RowOpts.slideRange — per-bundle corridor slide bounds for the rigid-row solver"
```

---

### Task 2: `RowOpts.latTol` — relaxable parallel-join collinearity

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (RowOpts; `pairEval` ~line 332)
- Test: `src/render/layout/rowPlace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `rowPlace.test.ts`:

```ts
test('latTol: far parallel-corridor bundles attach into one aligned chain', () => {
  // bundle A: vertical lanes at x=0/5.5 anchored at y=0; bundle B: vertical
  // lanes at x=200/205.5 anchored at y=37. Rows are horizontal; on the 4px
  // far grid the closest the two rows can get to collinear is 1px (37 mod 4),
  // outside the strict 0.75px tolerance — so strict solves attach via a
  // rotated/elbow join (rows misaligned), while latTol 3 admits the straight
  // end-to-end bridge and the DP prefers it (shorter ext, no rotation).
  const curves = [laneVFar(0), laneVFar(PITCH), laneVFar(200, 37), laneVFar(200 + PITCH, 37)];
  const groups = [[0, 1], [2, 3]];
  const far = {
    ...OPTS,
    extCap: 300,
    step: 4,
    slideRange: [[-100, 100], [-100, 100]] as Array<[number, number]>,
  };
  const strict = solveRows(curves, groups, far);
  assert.ok(strict, 'strict solve still attaches (elbow/rotated join)');
  const ysStrict = strict.pos.map((p) => p[1]);
  assert.ok(
    Math.max(...ysStrict) - Math.min(...ysStrict) > 3,
    `strict join should be misaligned: ${ysStrict}`,
  );
  const sol = solveRows(curves, groups, { ...far, latTol: 3 });
  assert.ok(sol, 'relaxed latTol must attach the bundles');
  assert.equal(sol.order.length, 4);
  const ys = sol.pos.map((p) => p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 1.5, `rows not aligned: ${ys}`);
  assert.equal(sol.cornerAfter.size, 1, 'one parallel-join corner between the rows');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test src/render/layout/rowPlace.test.ts
```

Expected: FAIL — `latTol` unknown / alignment assertion fails.

- [ ] **Step 3: Implement `latTol`**

In `rowPlace.ts`:

(a) Add to `RowOpts` (after `slideRange`):

```ts
  /** Parallel end-to-end join lateral tolerance in px (default 0.75). The far
   *  coarse pass relaxes this to ~0.75·step so grid-quantized rows can pair;
   *  the fine polish pass restores the strict default. */
  latTol?: number;
```

(b) In `solveRows`, next to the existing option reads (`const { minGap, arcLimit, ... } = opts;`), add:

```ts
  const latTol = opts.latTol ?? 0.75;
```

(c) In `pairEval`, the parallel-rows branch currently reads:

```ts
      const lat = Math.abs((e2[0] - e1[0]) * -P.u[1] + (e2[1] - e1[1]) * P.u[0]);
      if (lat >= 0.75) return null;
```

Change the second line to:

```ts
      if (lat >= latTol) return null;
```

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test src/render/layout/rowPlace.test.ts && npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/rowPlace.test.ts
git commit -m "feat(render): RowOpts.latTol — relaxable parallel-join collinearity for coarse far grids"
```

---

### Task 3: Soft sub-floor gap band (`softBand`/`softW`)

**Files:**
- Modify: `src/render/layout/rowPlace.ts` (RowOpts; state pinch ~line 202; `pairEval` floors ~lines 315–319 and 365–370; `stationFloorsOk` ~lines 389–413)
- Test: `src/render/layout/rowPlace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `rowPlace.test.ts`:

```ts
test('softBand: an in-band pinch seats with the deficit priced into cost', () => {
  // two horizontal lanes 3.6px apart (< minGap 4.85, above hard floor 3.35).
  // blocked() confines dots to |x| <= 1 so the 45° escape row (gap 5.09) is
  // vetoed and the solver must take the sub-floor perpendicular seat.
  const curves = [lane(0, 0), lane(3.6, 0)];
  const blocked = (p: Pixel) => Math.abs(p[0]) > 1;
  assert.equal(
    solveRows(curves, [[0, 1]], { ...OPTS, blocked }),
    null,
    'hard floor boxes the 3.6px pinch',
  );
  const sol = solveRows(curves, [[0, 1]], { ...OPTS, blocked, softBand: 1.5 });
  assert.ok(sol, '3.6px gap is inside the soft band');
  const d = Math.hypot(sol.pos[0][0] - sol.pos[1][0], sol.pos[0][1] - sol.pos[1][1]);
  assert.ok(d < MINGAP, `seat should be sub-floor: ${d}`);
  assert.ok(sol.cost >= 5000 * (MINGAP - 3.6) - 50, `deficit not priced: ${sol.cost}`);
});

test('softBand: a clear seat still beats any sub-floor seat', () => {
  // same 3.6px lanes but UNBLOCKED: the 45° row crosses at 3.6/sin45 ≈ 5.09
  // ≥ minGap — a clear seat exists, so the solver must never pay the band
  const curves = [lane(0, 0), lane(3.6, 0)];
  const sol = solveRows(curves, [[0, 1]], { ...OPTS, softBand: 1.5 });
  assert.ok(sol);
  const d = Math.hypot(sol.pos[0][0] - sol.pos[1][0], sol.pos[0][1] - sol.pos[1][1]);
  assert.ok(d >= MINGAP - 1e-6, `clear seat expected, got gap ${d}`);
});

test('softBand: a true pinch below the hard floor still boxes', () => {
  // 2px < hardFloor 3.35 — the band must not unbox genuine coincidence
  const curves = [lane(0, 0), lane(2, 0)];
  assert.equal(solveRows(curves, [[0, 1]], { ...OPTS, softBand: 1.5 }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsx --test src/render/layout/rowPlace.test.ts
```

Expected: FAIL — `softBand` unknown option.

- [ ] **Step 3: Implement the soft band**

In `rowPlace.ts`:

(a) Add to `RowOpts` (after `latTol`):

```ts
  /** Soft sub-floor gap band (px, default 0 = hard floor everywhere). Dot
   *  gaps in [minGap − softBand, minGap) are feasible but charged softW per
   *  px of deficit — replaces the caller's box-rescue slack WALK with one
   *  solve. softW (default 5000/px) dominates every other cost scale, so a
   *  fully-clear chain always outbids an overlapping one and the least
   *  deficit wins among overlaps (the walk's minimum-slack semantics). */
  softBand?: number;
  softW?: number;
```

(b) In `solveRows`, next to `latTol`:

```ts
  const softBand = opts.softBand ?? 0;
  const softW = opts.softW ?? 5000;
  const hardFloor = minGap - softBand;
```

(c) State pinch (in `buildStates`) — current:

```ts
          if (stats && mg > stats.bestMinGap) stats.bestMinGap = mg; // this state crossed all lanes
          if (mg < minGap) { feas = false; if (stats) stats.pinch++; }
```

becomes:

```ts
          if (stats && mg > stats.bestMinGap) stats.bestMinGap = mg; // this state crossed all lanes
          if (mg < hardFloor) { feas = false; if (stats) stats.pinch++; }
```

and the state cost line

```ts
          cost: slideW * Math.abs(s) + rotW * rot + proxPen,
```

needs the deficit term. `mg` is scoped inside the `dots.length > 1` block, so hoist it: replace `let mg = Infinity;` computation's surrounding block so `mg` is declared before the `if (dots.length > 1)` (initialize `let mg = Infinity;` at the top of the feasibility section, keep the inner loop assigning it), then:

```ts
          cost: slideW * Math.abs(s) + rotW * rot + proxPen + softW * Math.max(0, minGap - mg),
```

(`mg = Infinity` for 1-dot rows ⇒ `minGap − Infinity < 0` ⇒ term 0.)

(d) `pairEval` cross-row dot floor — current:

```ts
    for (const p of P.dots) {
      for (const q of Q.dots) {
        if (hyp(p[0] - q[0], p[1] - q[1]) < minGap) return null;
      }
    }
```

becomes:

```ts
    let softPen = 0;
    for (const p of P.dots) {
      for (const q of Q.dots) {
        const d = hyp(p[0] - q[0], p[1] - q[1]);
        if (d < hardFloor) return null;
        if (d < minGap) softPen += softW * (minGap - d);
      }
    }
```

(e) `pairEval` corner clearance — current:

```ts
    for (const d of P.dots) {
      if (hyp(corner[0] - d[0], corner[1] - d[1]) < minGap) return null;
    }
    for (const d of Q.dots) {
      if (hyp(corner[0] - d[0], corner[1] - d[1]) < minGap) return null;
    }
    const turnPen = turnW * (1 + (o1x * o2x + o1y * o2y)); // ≥0; 0 = straight join
    return { cost: ext1 + ext2 + turnPen, corner };
```

becomes:

```ts
    for (const d of P.dots) {
      const dd = hyp(corner[0] - d[0], corner[1] - d[1]);
      if (dd < hardFloor) return null;
      if (dd < minGap) softPen += softW * (minGap - dd);
    }
    for (const d of Q.dots) {
      const dd = hyp(corner[0] - d[0], corner[1] - d[1]);
      if (dd < hardFloor) return null;
      if (dd < minGap) softPen += softW * (minGap - dd);
    }
    const turnPen = turnW * (1 + (o1x * o2x + o1y * o2y)); // ≥0; 0 = straight join
    return { cost: ext1 + ext2 + turnPen + softPen, corner };
```

(f) `stationFloorsOk` — replace all three `< minGap - 1e-9` comparisons with `< hardFloor - 1e-9` (non-adjacent floors reject at the hard floor; band deficits here are accepted unranked — spec §2.1 approximation, note it in the function's comment).

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test src/render/layout/rowPlace.test.ts && npm run typecheck && npm test
```

Expected: all PASS, including the pre-existing `OCTI_PLACE_DEBUG classifies a pinched box` test (2px < hardFloor at default `softBand: 0` and with any band ≤ 1.5).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/rowPlace.ts src/render/layout/rowPlace.test.ts
git commit -m "feat(render): soft sub-floor gap band in the rigid-row solver — one solve replaces the box-rescue walk"
```

---

### Task 4: Rewrite the escalation ladder in `computeRibbonGeometry`

**Files:**
- Modify: `src/render/renderOctilinear.ts`
  - constants block near `WIDE_ARC` (~line 249): add far-tier knobs
  - placement loop: replace everything from the `ropts` construction through the overlap-retry block (search anchors: `const ropts = {` … `else retried = ' retry-unseatable';`)
  - `capOvlStats` declaration and its debug print: drop `retried`/`retriedOk`

The platform-split `else` branch and the mega-box fallback are UNCHANGED. The grouping code (`curves` at `CHAIN_ARC_LIMIT`, `markAxis`, union-find, `groups`) is UNCHANGED — the 24px curves are still what the axis/grouping logic reads; only the SOLVE now uses fresh wider curves.

- [ ] **Step 1: Add the far-tier constants**

Immediately after the `WIDE_ARC` definition (`const WIDE_ARC = CHAIN_ARC_LIMIT * WIDE_MULT;`), insert:

```ts
  // Far-attach corridor tier (escalation stage 2 of the rewritten ladder):
  // when the PRIMARY solve fails and a multi-bundle station's bundles spread
  // beyond the primary window (far-apart platforms of one station group,
  // possible since per-station graph nodes), each bundle's row may slide
  // along its own corridor — coarse grid, half-corridor bounds — and the
  // chain DP joins the aligned rows into ONE capsule. OCTI_FAR_SLIDE=0
  // disables the tier (A/B: platform-split fallback only). OCTI_FAR_STEP =
  // coarse slide grid px (default 4); OCTI_FAR_CAP = lane-curve window cap px
  // (default 400) — bounds both the search and its cost.
  const farSlideOn =
    (typeof process === 'undefined' ? undefined : (process as { env?: Record<string, string> }).env?.OCTI_FAR_SLIDE) !== '0';
  const FAR_STEP = (() => {
    const v = typeof process !== 'undefined' ? Number((process as { env?: Record<string, string> }).env?.OCTI_FAR_STEP) : NaN;
    return Number.isFinite(v) && v >= 1 ? v : 4;
  })();
  const FAR_CAP = (() => {
    const v = typeof process !== 'undefined' ? Number((process as { env?: Record<string, string> }).env?.OCTI_FAR_CAP) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 400;
  })();
```

- [ ] **Step 2: Replace the ladder**

Delete from `const ropts = {` (the placement options object, currently followed by `let sol = solveRows(curves, groups, ropts); let wide ...`) down through the END of the overlap-retry block (the lines `} else retried = ' retry-unseatable';` and its closing brace before `if ((ev.selfOvl || ev.crossOvl || retried) && capPlaceDebug) {`). Keep `evalSol` — it is INSIDE the deleted range in source order, so re-insert it as shown below. Replace with:

```ts
        // ---- escalation ladder (rewritten 2026-07-04, spec: escalation-
        // ladder-rewrite): TWO solve stages instead of four.
        //  1. PRIMARY — one wide-window solve with the placed-hull masks baked
        //     in (was: separate overlap retry) and a soft sub-floor gap band
        //     (was: the box-rescue slack walk of up to 6 re-solves).
        //  2. FAR-ATTACH — corridor-bounded coarse solve + fine polish, only
        //     when PRIMARY fails and the bundles spread beyond the window:
        //     slides each platform's row along its own corridor until the
        //     rows align, then joins them into ONE capsule (long parallel
        //     bridges are paid for in cost, not vetoed).
        //  3. VERIFY — seat-time hull-overlap check (masked retry deleted;
        //     the masks are in the solve now).  Then: platform split → mega.
        let cx0 = 0, cy0 = 0;
        for (const mk of s.marks) { cx0 += mk.pos[0]; cy0 += mk.pos[1]; }
        cx0 /= s.marks.length; cy0 /= s.marks.length;
        // max cross-bundle anchor spread: far-tier trigger + mask/ext radius
        let spread = 0;
        for (let bi = 0; bi < groups.length; bi++) {
          for (let bj = bi + 1; bj < groups.length; bj++) {
            for (const i of groups[bi]) {
              for (const j of groups[bj]) {
                const d = hyp(s.marks[i].pos[0] - s.marks[j].pos[0], s.marks[i].pos[1] - s.marks[j].pos[1]);
                if (d > spread) spread = d;
              }
            }
          }
        }
        // placed-hull masks (hoisted from the deleted overlap retry): veto a
        // dot whose ring would sit inside a placed capsule hull; comfort ramp
        // outside. Prefiltered to the station's vicinity + spread.
        const nearHulls: Hull = [];
        for (const ph of placedHulls) {
          for (const sg of ph.hull) {
            if (segSegDist([cx0, cy0], [cx0, cy0], sg.a, sg.b) < 400 + spread) nearHulls.push(sg);
          }
        }
        const hullClearance = (p: Pixel): number => {
          let md = Infinity;
          for (const sg of nearHulls) {
            const d = segSegDist(p, p, sg.a, sg.b) - (sg.half + r);
            if (d < md) md = d;
          }
          return md;
        };
        const ropts = {
          minGap: intraGap,
          arcLimit: WIDE_ARC,
          extCap: extCapMult * spacing,
          // soft sub-floor band: gaps down to (minGap − boxRescueMax) seat
          // with a heavy per-px deficit penalty instead of re-solving at
          // walked-down floors. OCTI_BOX_RESCUE keeps its name/default (1.5;
          // 0 restores the hard floor everywhere).
          softBand: boxRescueMax,
          dbgLabel: s.nodeId, // OCTI_PLACE_DEBUG: per-box root-cause classifier
          blocked: (p: Pixel) => {
            for (const q of placedDots) {
              if (hyp(p[0] - q[0], p[1] - q[1]) < xMaskStack) return true; // true-stacking veto
            }
            return hullClearance(p) < 0; // ring inside a placed capsule hull
          },
          proximity: (p: Pixel) => {
            let pen = 0;
            for (const q of placedDots) {
              const d = hyp(p[0] - q[0], p[1] - q[1]);
              if (d < xMaskComfort) pen += xMaskWeight * (xMaskComfort - d) / xMaskComfort;
            }
            const hd = hullClearance(p);
            if (hd >= 0 && hd < xMaskComfort) pen += xMaskWeight * (xMaskComfort - hd) / xMaskComfort;
            return pen;
          },
        };
        // PRIMARY: one wide-window fine-grid solve
        const solveCurves = s.marks.map((mk) =>
          buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, WIDE_ARC),
        );
        let sol = solveRows(solveCurves, groups, ropts);
        // FAR-ATTACH: corridor-bounded align + join (one coarse + one polish)
        if (!sol && farSlideOn && groups.length >= 2 && spread > WIDE_ARC) {
          const farCurves = s.marks.map((mk) =>
            buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, FAR_CAP),
          );
          // each bundle may slide to the MIDPOINT of its incident corridor on
          // either side (half the windowed carrier extent, floored at the
          // primary window), never off the lane geometry
          const slideRange = groups.map((grp) => {
            const carrier = farCurves[grp[0]];
            const total = carrier.cum[carrier.cum.length - 1];
            const lo = Math.max(-carrier.anchorT, -Math.max(WIDE_ARC, carrier.anchorT / 2));
            const hi = Math.min(total - carrier.anchorT, Math.max(WIDE_ARC, (total - carrier.anchorT) / 2));
            return [lo, hi] as [number, number];
          });
          const farOpts = {
            ...ropts,
            arcLimit: FAR_CAP,
            step: FAR_STEP,
            slideRange,
            // coarse grid can't hit the strict 0.75px collinearity — relax to
            // ~3/4 step (≥ the grid's worst-case residual); polish restores it
            latTol: Math.max(0.75, FAR_STEP * 0.75),
            // long bridges are payable: extension bound covers the spread
            extCap: Math.max(extCapMult * spacing, spread + 2 * spacing),
          };
          sol = solveRows(farCurves, groups, farOpts);
          if (sol) {
            // fine polish: re-anchor every lane curve at its coarse dot and
            // re-solve locally at strict tolerances — drives parallel joins
            // to sub-pixel collinearity (lat moves ≤1px per px of slide, so
            // the ±2·FAR_STEP window brackets exact alignment).
            const coarse = sol;
            const fineCurves = s.marks.map((mk, i) =>
              buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), coarse.pos[i], 2 * FAR_STEP),
            );
            sol = solveRows(fineCurves, groups, {
              ...farOpts,
              arcLimit: 2 * FAR_STEP,
              step: 0.5,
              slideRange: undefined,
              latTol: undefined,
            });
          }
          if (capPlaceDebug) {
            console.error(
              `[far-attach] ${s.nodeId} spread=${spread.toFixed(0)} bundles=${groups.length}` +
              ` -> ${sol ? 'ATTACHED' : 'failed'}`,
            );
          }
        }
```

Then re-insert the VERIFY block. It is the old overlap-check block with the retry sub-block removed — keep `evalSol` exactly as it was (the `near`/`verts`/`hull`/`selfOvl`/`crossOvl` closure), and after `let ev = evalSol(sol);` keep only:

```ts
          let ev = evalSol(sol);
          capOvlStats.capsules++;
          if (ev.selfOvl) capOvlStats.self++;
          if (ev.crossOvl) capOvlStats.cross++;
          const reject = capNoOvlOn && (ev.selfOvl || ev.crossOvl !== null);
          if ((ev.selfOvl || ev.crossOvl) && capPlaceDebug) {
            let cx = 0, cy = 0;
            for (const v of ev.verts) { cx += v[0]; cy += v[1]; }
            console.error(
              `[capsovl] ${reject ? 'REJECT' : 'overlap'} ${s.nodeId} marks=${s.marks.length} at=(${(cx / ev.verts.length).toFixed(0)},${(cy / ev.verts.length).toFixed(0)})${ev.selfOvl ? ' self' : ''}${ev.crossOvl ? ` cross(${ev.crossOvl})` : ''}${reject ? ' → split/mega' : ''}`,
            );
          }
          if (reject) { capOvlStats.rejected++; sol = null; }
          else placedHulls.push({ nodeId: s.nodeId, hull: ev.hull });
```

(`let ev` becomes single-assignment; `wantSelf`/`wantCross`/`retried`, the `ropts2` retry, and its 3 extra solves are gone. Note the debug string's arrow now says `split/mega`.)

- [ ] **Step 3: Clean up `capOvlStats` and stale references**

- Change the declaration `const capOvlStats = { capsules: 0, self: 0, cross: 0, rejected: 0, retried: 0, retriedOk: 0 };` to `const capOvlStats = { capsules: 0, self: 0, cross: 0, rejected: 0 };`
- Grep for the stats debug print (`grep -n "retriedOk\|capOvlStats" src/render/renderOctilinear.ts`) and drop the `retried`/`retriedOk` fields from any print string.
- Delete the now-unused `boxRescueMax` slack-walk comment paragraph ("Box-rescue: rather than fall back…") and replace with a one-liner: `// Soft sub-floor band width (px) fed to solveRows.softBand — see the ladder comment. OCTI_BOX_RESCUE keeps its historic name; 0 = hard floor.`
- Verify no references remain to the deleted `wide` variable: `grep -n "let wide\|wide =" src/render/renderOctilinear.ts` should only match unrelated code.

- [ ] **Step 4: Typecheck + full test suite**

```bash
npm run typecheck && npm test
```

Expected: PASS. (`schematic.test.ts` is structural, not golden-based; `rowPlace.test.ts` unaffected.)

- [ ] **Step 5: Commit**

```bash
git add src/render/renderOctilinear.ts
git commit -m "feat(render): rewrite marker-placement escalation — 2 solve stages, far-attach corridor capsules"
```

---

### Task 4b: Best-effort seating for split platform units (least-bad instead of mega)

A re-queued split unit is a single bundle; its only failure modes are overlap vetoes (blocked masks / verify reject) and structural degeneracy (coincident lanes, no-crossing). Overlap failures take a least-penetration seat instead of a mega box; structural failures still box.

**Files:**
- Modify: `src/render/renderOctilinear.ts`
  - `StMarks` interface (search `interface StMarks`): add the split marker
  - platform-split branch (search `platform-split`): tag units
  - ladder (Task 4 code): best-effort re-solve + verify bypass

- [ ] **Step 1: Tag split units**

(a) Add to `StMarks`:

```ts
      /** set on platform-split units (and the shrunken primary): the original
       *  group nodeId — enables best-effort seating and taxicab connectors */
      splitBase?: string;
```

(b) In the platform-split branch, the unit construction

```ts
              const unit: StMarks = {
                nodeId: s.nodeId + '::plat' + platSeq++,
                members: s.members,
                marks: clusters[c].map((i) => s.marks[i]),
              };
```

gains `splitBase: s.nodeId,` after `members`, and immediately before `placeQueue.push(s); // re-solve the shrunken primary cluster` add:

```ts
            s.splitBase = s.nodeId;
```

- [ ] **Step 2: Add the best-effort re-solve**

In the Task 4 ladder code, directly after the far-attach block (after its closing `}`), insert:

```ts
        // BEST-EFFORT (split units only): a re-queued platform unit that
        // still has no seat is almost always OVERLAP-vetoed — every candidate
        // row sits inside a placed capsule hull or stacked on placed dots.
        // Take the least-bad seat: the hull veto becomes a heavy proximity
        // penalty (least penetration wins), the true-stacking veto stays
        // hard, and the verify stage below records instead of rejecting.
        // Structural failures (coincident interlined lanes → pinch, or
        // no-crossing) still return null here and fall to the mega box.
        let bestEffort = false;
        if (!sol && s.splitBase) {
          bestEffort = true;
          sol = solveRows(solveCurves, groups, {
            ...ropts,
            blocked: (p: Pixel) => {
              for (const q of placedDots) {
                if (hyp(p[0] - q[0], p[1] - q[1]) < xMaskStack) return true;
              }
              return false; // hull veto lifted — priced below instead
            },
            proximity: (p: Pixel) => {
              let pen = ropts.proximity(p);
              const hd = hullClearance(p);
              if (hd < 0) pen += 1000 * -hd; // inside a placed hull: heavy, not fatal
              return pen;
            },
          });
          if (capPlaceDebug) {
            console.error(`[split-fit] ${s.nodeId} best-effort -> ${sol ? 'seated' : 'still null (structural)'}`);
          }
        }
```

- [ ] **Step 3: Verify stage records instead of rejecting for best-effort seats**

In the Task 4 VERIFY block, change

```ts
          const reject = capNoOvlOn && (ev.selfOvl || ev.crossOvl !== null);
```

to

```ts
          const reject = capNoOvlOn && !bestEffort && (ev.selfOvl || ev.crossOvl !== null);
```

and in the `[capsovl]` debug string add the marker: after `marks=${s.marks.length}` insert `${bestEffort ? ' best-effort' : ''}`.

- [ ] **Step 4: Typecheck + tests + commit**

```bash
npm run typecheck && npm test
git add src/render/renderOctilinear.ts
git commit -m "feat(render): best-effort seating for split platform units — least-bad seat instead of mega for overlap-only failures"
```

---

### Task 4c: Taxicab connectors between split platform units

Join the split units of one station group with thin axis-aligned transfer connectors (NYC free-transfer-bar style) so the complex reads as one station. Pure geometry in a new module; render wiring computes connectors AFTER all marker-adjust passes (endpoints track final positions).

**Files:**
- Create: `src/render/layout/splitConnect.ts`
- Create: `src/render/layout/splitConnect.test.ts`
- Modify: `src/render/renderOctilinear.ts` (immediately before the `renderStops(...)` call, search `const stopParts = renderStops`)

- [ ] **Step 1: Write the failing tests**

Create `src/render/layout/splitConnect.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSplitConnectors } from './splitConnect';
import type { Pixel } from './types';

test('MST joins N units with N-1 connectors at nearest dot pairs', () => {
  // three units in an L: 0-1 (100px) and 1-2 (80px) are the MST edges
  const units = [
    { id: 'a', dots: [[0, 0]] as Pixel[] },
    { id: 'b', dots: [[100, 0]] as Pixel[] },
    { id: 'c', dots: [[100, 80]] as Pixel[] },
  ];
  const cs = planSplitConnectors(units, []);
  assert.equal(cs.length, 2);
  // both edges are axis-aligned already: no elbow corner
  for (const c of cs) assert.equal(c.corner, null, `unexpected elbow: ${JSON.stringify(c)}`);
});

test('elbow corner picks the L that grazes other markers least', () => {
  const units = [
    { id: 'a', dots: [[0, 0]] as Pixel[] },
    { id: 'b', dots: [[100, 60]] as Pixel[] },
  ];
  // a foreign marker sits at (100, 10) — near candidate corner (100, 0);
  // the connector must take the other elbow, via (0, 60)
  const cs = planSplitConnectors(units, [[100, 10]]);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].corner, [0, 60]);
});

test('nearest dot pair is chosen, not centroids', () => {
  const units = [
    { id: 'a', dots: [[0, 0], [0, 50]] as Pixel[] },
    { id: 'b', dots: [[30, 50], [30, 100]] as Pixel[] },
  ];
  const cs = planSplitConnectors(units, []);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].a, [0, 50]);
  assert.deepEqual(cs[0].b, [30, 50]);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx tsx --test src/render/layout/splitConnect.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `splitConnect.ts`**

```ts
// Taxicab transfer connectors between the platform-split units of one
// station group (spec 2026-07-04 escalation-ladder-rewrite §2.4): when a
// far-apart group cannot be one capsule (far-attach failed → platform
// split), thin axis-aligned connectors join its capsules so the complex
// still reads as one station. Pure geometry: MST over unit centroids,
// nearest-dot endpoints, single-elbow L paths whose corner grazes foreign
// markers least. Deterministic (sorted inputs, total tie-breaks, sqrt-only
// arithmetic) — offline==in-game holds.

import type { Pixel } from './types';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface SplitUnit {
  id: string;      // placement-unit nodeId (used only for deterministic order)
  dots: Pixel[];   // the unit's FINAL mark positions (post all slide passes)
}

export interface SplitConnector {
  a: Pixel;              // endpoint on the first unit (a dot center)
  b: Pixel;              // endpoint on the second unit
  corner: Pixel | null;  // elbow vertex, or null when a/b are axis-aligned
}

/** Plan the connectors for ONE group's split units. `foreign` = final mark
 *  positions of every OTHER station near the group (elbow-avoidance). */
export function planSplitConnectors(
  units: SplitUnit[],
  foreign: Pixel[],
): SplitConnector[] {
  const us = units
    .filter((u) => u.dots.length > 0)
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (us.length < 2) return [];
  const cents: Pixel[] = us.map((u) => {
    let x = 0, y = 0;
    for (const d of u.dots) { x += d[0]; y += d[1]; }
    return [x / u.dots.length, y / u.dots.length];
  });
  // Prim's MST over centroids (unit counts are tiny); tie-break smallest j
  const inTree = new Set<number>([0]);
  const edges: Array<[number, number]> = [];
  while (inTree.size < us.length) {
    let bi = -1, bj = -1, bd = Infinity;
    for (const i of inTree) {
      for (let j = 0; j < us.length; j++) {
        if (inTree.has(j)) continue;
        const d = hyp(cents[i][0] - cents[j][0], cents[i][1] - cents[j][1]);
        if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && (bj === -1 || j < bj || (j === bj && i < bi)))) {
          bd = d; bi = i; bj = j;
        }
      }
    }
    inTree.add(bj);
    edges.push([bi, bj]);
  }
  const out: SplitConnector[] = [];
  for (const [i, j] of edges) {
    // nearest dot pair between the two units (total tie-break by index order)
    let a = us[i].dots[0], b = us[j].dots[0], best = Infinity;
    for (const pa of us[i].dots) {
      for (const pb of us[j].dots) {
        const d = hyp(pa[0] - pb[0], pa[1] - pb[1]);
        if (d < best - 1e-9) { best = d; a = pa; b = pb; }
      }
    }
    if (Math.abs(a[0] - b[0]) < 0.5 || Math.abs(a[1] - b[1]) < 0.5) {
      out.push({ a, b, corner: null }); // already axis-aligned (within jitter)
      continue;
    }
    // two taxicab elbows; pick the corner farther from every foreign marker
    const c1: Pixel = [b[0], a[1]];
    const c2: Pixel = [a[0], b[1]];
    const clearOf = (c: Pixel): number => {
      let md = Infinity;
      for (const f of foreign) {
        const d = hyp(c[0] - f[0], c[1] - f[1]);
        if (d < md) md = d;
      }
      return md;
    };
    const d1 = clearOf(c1);
    const d2 = clearOf(c2);
    const corner =
      d1 > d2 + 1e-9 ? c1 :
      d2 > d1 + 1e-9 ? c2 :
      c1[0] < c2[0] || (c1[0] === c2[0] && c1[1] <= c2[1]) ? c1 : c2; // total tie-break
    out.push({ a, b, corner });
  }
  return out;
}
```

- [ ] **Step 4: Run the unit tests**

```bash
npx tsx --test src/render/layout/splitConnect.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Wire into the render**

In `renderOctilinear.ts`, add the import near the other layout imports:

```ts
import { planSplitConnectors } from './layout/splitConnect';
```

Immediately BEFORE the `const stopParts = renderStops(` line (final mark positions are settled by then), insert:

```ts
  // ---- taxicab connectors between split platform units -------------------
  // Computed from FINAL mark positions (all slide/de-overlap passes done).
  // Drawn under the capsules in the capsule border color: thin transfer
  // bars that reunite a platform-split station group visually.
  const connectorParts: string[] = [];
  {
    const byBase = new Map<string, StMarks[]>();
    for (const st of gathered) {
      if (!st.splitBase || st.marks.length === 0) continue;
      let arr = byBase.get(st.splitBase);
      if (!arr) byBase.set(st.splitBase, (arr = []));
      arr.push(st);
    }
    const connStroke = dark ? '#e4e4e7' : '#111111'; // capsule border colors (stops.ts)
    const connW = +(LINE_WIDTH * 0.9).toFixed(1);
    const f = (n: number) => n.toFixed(1);
    for (const [base, sts] of byBase) {
      if (sts.length < 2) continue;
      const memberSet = new Set(sts);
      const foreign: Pixel[] = [];
      for (const o of gathered) {
        if (memberSet.has(o)) continue;
        for (const m of o.marks) foreign.push(m.pos);
      }
      const conns = planSplitConnectors(
        sts.map((st) => ({ id: st.nodeId, dots: st.marks.map((m) => m.pos) })),
        foreign,
      );
      for (const c of conns) {
        const d = c.corner
          ? 'M ' + f(c.a[0]) + ' ' + f(c.a[1]) + ' L ' + f(c.corner[0]) + ' ' + f(c.corner[1]) + ' L ' + f(c.b[0]) + ' ' + f(c.b[1])
          : 'M ' + f(c.a[0]) + ' ' + f(c.a[1]) + ' L ' + f(c.b[0]) + ' ' + f(c.b[1]);
        connectorParts.push(
          '<path d="' + d + '" fill="none" stroke="' + connStroke + '" stroke-width="' + connW +
          '" stroke-linecap="round" stroke-linejoin="round" data-split-connector="' + escapeXml(base) + '"/>',
        );
        stopsPrims?.push({
          kind: 'path', d, fill: 'none', stroke: connStroke, strokeWidth: connW,
          lineCap: 'round', lineJoin: 'round', layer: 'stops', worldScale: true,
        });
      }
    }
  }
```

Then find where `stopParts` is spread/joined into the output parts and emit `connectorParts` immediately BEFORE it (connectors render under the capsules and dots). If `stopsPrims` is only defined when a scene sink exists, keep the `?.` call as written; if `dark`/`escapeXml` are not in scope at that point, hoist the same values the `renderStops` call site uses.

- [ ] **Step 6: Typecheck + full tests + commit**

```bash
npm run typecheck && npm test
git add src/render/layout/splitConnect.ts src/render/layout/splitConnect.test.ts src/render/renderOctilinear.ts
git commit -m "feat(render): taxicab transfer connectors reunite platform-split station groups"
```

---

### Task 5: Cache schema bump

**Files:**
- Modify: `src/render/cacheFingerprint.ts:17`

- [ ] **Step 1: Bump the schema**

```ts
const SCHEMA = 19; // bump to bust all fingerprints when the renderer's inputs change
```

(was 18 on the merged branch — placement output changes for every map with a previously-boxed or platform-split station, and the primary window change can shift seated stations.)

- [ ] **Step 2: Typecheck + test + commit**

```bash
npm run typecheck && npm test
git add src/render/cacheFingerprint.ts
git commit -m "chore(render): schema 19 — escalation ladder rewrite changes placement output"
```

---

### Task 6: Integration gates + visual checkpoint

**Files:**
- Create (not committed): `dev/_new-id.log`, `dev/_new-tod.log`, `dev/_new-id*.png`, `dev/_new-tod*.png`

- [ ] **Step 1: Render the three city dumps with diagnostics**

(`dev/_in-{nyc,lon,sea}.json` were extracted in Task 0 Step 3.)

```bash
for n in nyc lon sea; do
  OCTI_PLACE_DEBUG=1 npx tsx dev/render-from-dump.ts dev/_in-$n.json dev/_new-$n 2> dev/_new-$n.log
done
```

Expected: all three complete without exceptions.

- [ ] **Step 2: Compare against the Task 0 baseline**

```bash
for f in nyc lon sea; do
  echo "== $f =="
  echo "-- baseline --"; grep -E "mega-box fallbacks|platform-split|far-attach|split-fit|capsovl REJECT" dev/_base-$f.log | sort | uniq -c
  echo "-- new --";      grep -E "mega-box fallbacks|platform-split|far-attach|split-fit|capsovl REJECT" dev/_new-$f.log  | sort | uniq -c
done
```

Gates (all must hold):
- `[far-attach] … ATTACHED` count > 0 on at least one dump IF the baseline had platform-splits with spread bundles (otherwise note "no far-apart groups in these saves" and verify via the Task 6a synthetic check below).
- platform-split count ≤ baseline; **mega-box fallbacks < baseline** (best-effort seating should convert every overlap-only mega on split units; remaining megas must classify as PINCHED/NO-CROSSING under `OCTI_PLACE_DEBUG` — spot-check one).
- `[split-fit] … seated` present wherever a split unit previously mega-boxed for overlap reasons.
- `data-split-connector` paths present in the SVG for every group with ≥2 placed split units (`grep -c "data-split-connector" dev/_new-nyc.svg` etc. — compare against the platform-split log lines).
- `[capsovl] REJECT` and overlap counts ≤ baseline for NON-best-effort stations (best-effort seats may log overlaps by design — they are recorded, not rejected).
- Contiguity: `npx tsx dev/contig.ts "C:/Users/darkd/Downloads/Improved Schematics/improvedschematics-map-NYC-EXTRA-DIFFICULT.json"` (contig reads the v2 map bundle directly) and likewise LON-3/SEA-2 — 0 broken routes, matching a baseline contig run captured before Task 1 lands (run it now if Task 0 didn't).
- Typecheck gate: `npm run typecheck` has 31 PRE-EXISTING errors on the base branch (imageMerge.ts/topo.ts/renderGeographic.ts) — the gate is "no NEW errors beyond those 31", not zero.

- [ ] **Step 3 (6a, only if neither dump exercises far-attach): synthetic exercise**

Run the Task 2 `latTol` unit test scenario through the render path indirectly by re-running the unit suite (already green), and grep both logs for `far-attach` to confirm the tier is at least REACHED (`failed` lines count too). If the tier never fires on either dump, state that explicitly in the report — the unit tests carry the correctness claim.

- [ ] **Step 4: Visual checkpoint**

Send the baseline and new PNGs for both dumps to the user (side-by-side is fine), calling out: any station that changed from platform-split/mega to an attached capsule, and any seated station that visibly moved. Wait for user sign-off before merging anywhere.

- [ ] **Step 5: Perf sanity**

```bash
grep -i "ms\|time" dev/_new-id.log | tail -3
```

Compare wall time printed by `render-from-dump` (if present) or time the commands (`time npx tsx …`). Gate: new total render time ≤ baseline × 1.15. The far tier runs only on failures; the primary solve does strictly less work than the old ladder on failing stations and slightly more (±48 vs ±24 first pass) on easy ones.

- [ ] **Step 6: Final commit / wrap-up**

No code changes expected in this task; if gate failures forced fixes, they were committed in place. Then use superpowers:finishing-a-development-branch to decide merge/PR (user preference: merge to master after visual sign-off).

---

## Self-review notes

- **Spec coverage:** §2 ladder → Task 4; §2.4 best-effort seating → Task 4b; §2.4 taxicab connectors → Task 4c; §3 solver options → Tasks 1–3; §4 drift/schema → Task 5 + Task 6 gates; §5 knobs → Task 4 Step 1 (`OCTI_FAR_SLIDE/STEP/CAP`), `OCTI_BOX_RESCUE` re-pointed in Task 4 Step 2/3; §6 verification → Tasks 1–3 + 4c tests, Task 6.
- **Known approximation carried from spec §2.1:** `stationFloorsOk` rejects at the hard floor without pricing band deficits (non-adjacent rows only). Watch `[capsovl]`/overlap gates in Task 6 for regressions.
- **Type consistency:** `slideRange: Array<[number, number]>`, `latTol?: number`, `softBand?/softW?: number` used identically in Tasks 1–4; `buildStates(group, bi, stats)` matches its single call site; `StMarks.splitBase?: string` set in Task 4b, read in Task 4b (ladder) and Task 4c (connectors); `SplitUnit`/`SplitConnector` shapes match between Task 4c Steps 1/3/5.
- **Ordering note:** Task 4b's `bestEffort` flag must be declared before the VERIFY block Task 4 inserted (it is read there); the connectors (4c) intentionally run at render-emit time, after every marker-adjust pass, so endpoint positions are final.
