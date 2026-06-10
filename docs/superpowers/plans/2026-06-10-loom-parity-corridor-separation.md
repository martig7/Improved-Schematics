# LOOM Parity: Corridor Separation + Tacoma Clump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the topo merge from welding geographically distinct corridors (blue/pink center separation), and make the SW "Tacoma" clump read like LOOM's sparse radial star via a grid-coarseness + thinner-line-width sweep.

**Architecture:** One surgical change in the merge loop (`inputFromBuilder` re-feeds RDP-simplified real corridor geometry instead of endpoint chords), then an empirical parameter sweep (grid divisor × line width) judged by quantitative probes left by the investigation, then a conditional capsule cleanup. Even station redistribution and `combineDeg2` stay exactly as they are.

**Tech Stack:** TypeScript, node:test (`pnpm test`), tsx for dev probes, @resvg/resvg-js for rasterization. Canonical input: `improvedschematics-input.json` (live game dump, project root). Spec: `docs/superpowers/specs/2026-06-10-loom-parity-corridor-separation-design.md`.

**Context for a zero-context engineer:**
- The smoothed pipeline lives in `src/render/renderGeographic.ts` (`renderSmoothed`) → `src/render/layout/topo.ts` (`buildSupportGraph`: iterative geometric merge of route corridors) → `src/render/layout/octi.ts` (grid octilinearization) → `src/render/renderOctilinear.ts`.
- The merge runs up to 8 rounds (`runMergeRounds` in topo.ts). Round 1 consumes the transit graph; rounds 2+ re-consume the merged builder via `inputFromBuilder`. Today rounds 2+ see only straight endpoint chords — that's the bug: two bowed parallel corridors between the same junction pair become identical chords and weld.
- Renders for verification: `npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump` (writes `dev/_dump.svg` / `.png`, ~60–90 s). NYC regression: `npx tsx dev/_checkpoint.ts`. All dev scripts run from the repo root with `npx tsx`.
- Probes from the investigation (already in `dev/`, runnable as-is): `_parity-q1-support.ts` (blue/pink shared-corridor length), `_parity-sw-anatomy.ts` + `_parity-sw-mult.ts` (Tacoma multiplicity/sawtooth/transects), `_parity-dhat-svgscan.ts` (same-coordinate different-color overdraw guard).
- Env knobs (all default-off diagnostics): `OCTI_DEBUG=1`, `OCTI_DIVISOR=<n>`, `OCTI_DHAT=<px>`, `OCTI_NO_COMBINE=1`.

---

### Task 1: Geometry-preserving merge refeed

**Files:**
- Modify: `src/render/layout/topo.ts` (functions `inputFromBuilder`, `runMergeRounds`)
- Test: `src/render/layout/topo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/render/layout/topo.test.ts` (the file already imports `runMergeRounds`, `graphFrom` is defined mid-file, and `PARAMS` is a `TopoParams` with `dHat: 20, step: 5`; place this test after the existing `runMergeRounds` tests so both helpers are in scope):

```ts
test('merge rounds keep bowed parallel corridors separate (no chord-refeed weld)', () => {
  // Two routes between the same junction pair, bowing 120px apart mid-span —
  // far beyond dHat=20. Round 1 keeps them apart; the old endpoint-chord
  // refeed welded them in round 2.
  const g = graphFrom(
    {
      J1: [0, 0],
      A1: [100, 60],
      A2: [200, 60],
      B1: [100, -60],
      B2: [200, -60],
      J2: [300, 0],
    },
    [
      { id: 'a1', from: 'J1', to: 'A1', lines: ['LA'] },
      { id: 'a2', from: 'A1', to: 'A2', lines: ['LA'] },
      { id: 'a3', from: 'A2', to: 'J2', lines: ['LA'] },
      { id: 'b1', from: 'J1', to: 'B1', lines: ['LB'] },
      { id: 'b2', from: 'B1', to: 'B2', lines: ['LB'] },
      { id: 'b3', from: 'B2', to: 'J2', lines: ['LB'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  let weldedLen = 0;
  for (const e of h.edgeList()) {
    if (e.lineIds.has('LA') && e.lineIds.has('LB')) weldedLen += polylineLength(e.points);
  }
  // Junction-adjacent welds are fine (the routes genuinely meet at J1/J2);
  // the 200px bowed interior must stay two corridors.
  assert.ok(weldedLen < 80, `bowed parallels welded: ${weldedLen}px shared`);
});

test('merge rounds still weld genuinely close parallels', () => {
  // Same shape but the corridors run 8px apart — inside dHat=20. These MUST
  // merge into one corridor carrying both lines.
  const g = graphFrom(
    {
      J1: [0, 0],
      A1: [100, 4],
      A2: [200, 4],
      B1: [100, -4],
      B2: [200, -4],
      J2: [300, 0],
    },
    [
      { id: 'a1', from: 'J1', to: 'A1', lines: ['LA'] },
      { id: 'a2', from: 'A1', to: 'A2', lines: ['LA'] },
      { id: 'a3', from: 'A2', to: 'J2', lines: ['LA'] },
      { id: 'b1', from: 'J1', to: 'B1', lines: ['LB'] },
      { id: 'b2', from: 'B1', to: 'B2', lines: ['LB'] },
      { id: 'b3', from: 'B2', to: 'J2', lines: ['LB'] },
    ],
  );
  const h = runMergeRounds(g, PARAMS);
  let weldedLen = 0;
  let total = 0;
  for (const e of h.edgeList()) {
    const len = polylineLength(e.points);
    total += len;
    if (e.lineIds.has('LA') && e.lineIds.has('LB')) weldedLen += len;
  }
  assert.ok(weldedLen > total * 0.5, `close parallels failed to weld: ${weldedLen}/${total}px`);
});
```

`polylineLength` is already imported at the top of the test file.

- [ ] **Step 2: Run the new tests to verify the first fails**

Run: `pnpm test 2>&1 | Select-String -Pattern 'bowed|genuinely close|pass |fail '`
Expected: `bowed parallel corridors` test FAILS (welded length ≈ 200px+ with the chord refeed); `genuinely close` test PASSES (guards against over-correcting).

- [ ] **Step 3: Implement the geometry-preserving refeed**

In `src/render/layout/topo.ts`, replace the whole `inputFromBuilder` function (currently documented with "Use endpoint chords only"):

```ts
/** Re-feed merged corridors into another collapse round. Feed RDP-simplified
 *  REAL geometry, not endpoint chords: two bowed corridors between the same
 *  junction pair otherwise become near-identical straight chords and weld
 *  regardless of dHat (the blue/pink center conjoining). RDP at eps keeps the
 *  vertex count low enough that re-walking does not re-densify or fragment
 *  the graph (measured: 237 -> 231 corridor edges on the live Seattle dump). */
export function inputFromBuilder(h: HBuilder, eps: number): MergeInput {
  return {
    edges: h.edgeList().map((e) => {
      const a = h.nodePos(e.a);
      const b = h.nodePos(e.b);
      const points = simplifyRdp(e.points, eps);
      points[0] = a.slice() as Pixel;
      points[points.length - 1] = b.slice() as Pixel;
      return {
        fromId: e.a,
        toId: e.b,
        a,
        b,
        points,
        lineIds: e.lineIds,
      };
    }),
  };
}
```

`simplifyRdp` is module-private in the same file — no import needed. In `runMergeRounds`, update the call site:

```ts
const input = h === null ? inputFromGraph(g, params.projectGeo) : inputFromBuilder(h, params.dHat);
```

(eps = dHat, NOT dHat/2 — the investigation measured dHat/2 strictly worse: 299 edges / 47 spurious pairs vs 231 / 30.)

- [ ] **Step 4: Run the full suite**

Run: `pnpm test 2>&1 | Select-Object -Last 8`
Expected: all tests pass (127 = 125 existing + 2 new). If `contractDegree2 does NOT collapse when line sets differ` or any merge test regresses, the refeed is feeding stale endpoints — re-check the endpoint pinning in Step 3.

- [ ] **Step 5: Verify Q1 acceptance on the live dump**

Run: `npx tsx dev/_parity-q1-support.ts 2>&1 | Select-Object -Last 20`
Expected: blue(6b681564)+pinkH(a3f11a38) shared support-corridor length ≤ 60px (was ~344px); blue+pinkI(bbf5a87e) ≤ 70px (was ~100px). If the probe's output format differs, look for the per-pair shared-length lines it prints.

- [ ] **Step 6: Render the dump and eyeball the three windows**

Run: `npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump`
Then: `npx tsx dev/_parity-dhat-svgscan.ts 2>&1 | Select-Object -Last 10` (expected: zero same-coordinate different-color path pairs — guards the overdraw bug)
Then view crops (pattern from `dev/_crop-dump.ts`: replace the SVG `viewBox` and rasterize):
- center window `viewBox="880 1130 360 400"` — blue and pink should now be two corridors,
- SW window `viewBox="300 1900 900 800"` — expect visibly fewer welded multi-lane cyan ribbons,
- whole map — no fragmentation (no doubled parallel strands where the baseline had clean single corridors). Known acceptable residuals (from the simulation): small new welds around route pairs 4+2, 2+X, C+J; one new missing-vs-LOOM weld B+3.

- [ ] **Step 7: NYC + geojson regressions**

Run: `npx tsx dev/_checkpoint.ts` and `npx tsx dev/render-sea-compare.ts 2>&1 | Select-Object -Last 3`
Expected: both complete; view `dev/_chk-nyc-smoothed.png` — NYC unregressed (clean octilinear, all routes present).

- [ ] **Step 8: Commit**

```powershell
git add src/render/layout/topo.ts src/render/layout/topo.test.ts
git commit -m @'
fix(topo): re-feed merge rounds with RDP-simplified real geometry

Endpoint-chord refeed welded bowed parallel corridors between shared
junction pairs at any dHat (blue/pink center conjoining; most spurious
Tacoma cyan welds). RDP at eps=dHat keeps re-walk cheap with no
fragmentation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Sweep infrastructure (line-width knob + sweep driver)

**Files:**
- Modify: `src/render/constants.ts` (diagnostic line-width override)
- Create: `dev/_sweep-spacing.ts`

- [ ] **Step 1: Add the diagnostic line-width env override**

In `src/render/constants.ts`, find the `LINE_WIDTH` constant (it is the px stroke width; `LINE_GAP` sits next to it; lane spacing = `LINE_WIDTH + LINE_GAP`). Replace the literal with:

```ts
/** Diagnostic override for the spacing sweep (IS_LINE_WIDTH env); the literal
 *  default is the production value. Browser-safe: process may be undefined. */
const LINE_WIDTH_DEFAULT = 5;
export const LINE_WIDTH =
  (typeof process !== 'undefined' && Number((process as { env?: Record<string, string> }).env?.IS_LINE_WIDTH)) ||
  LINE_WIDTH_DEFAULT;
```

If the current literal is not 5, keep whatever it is as `LINE_WIDTH_DEFAULT`. IMPORTANT: grep for other places deriving from line width — `Grep pattern="lineWidth" path=src/render` — and confirm `renderSmoothed`'s `dHat = Math.max(8, theme.lineWidth * 4)`. Thinner lines must NOT shrink the merge radius (spec: dHat stays 16), so in `src/render/renderGeographic.ts` change BOTH `renderSmoothed`'s and the topo-geographic path's derivation (two occurrences of `Math.max(8, theme.lineWidth * 4)`) to:

```ts
// dHat is a corridor-merge radius, not a stroke property: keep it at the
// tuned 16px even when the theme draws thinner lines (sweep-validated).
const dHat = Math.max(16, theme.lineWidth * 4);
```

- [ ] **Step 2: Confirm nothing changed at defaults**

Run: `pnpm test 2>&1 | Select-Object -Last 5` and `pnpm typecheck 2>&1 | Select-Object -Last 2`
Expected: all pass; typecheck clean. (At lineWidth 5, `max(16, 20)` = 20 ≠ old `max(8,20)`=20 — unchanged; at thinner widths it pins to 16.)

- [ ] **Step 3: Write the sweep driver**

Create `dev/_sweep-spacing.ts`:

```ts
// Throwaway: joint grid-divisor x line-width sweep for Tacoma spacing
// (spec 2026-06-10-loom-parity-corridor-separation-design.md section 2).
// Spawns dev/render-from-dump.ts per config; writes full map + center + SW
// crops per config as dev/_sw-<divisor>-<lw>*.png.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const DIVISORS = ['2.5', '1.6', '1.2', '1.0'];
const WIDTHS = ['5', '3.5', '2.5'];

for (const d of DIVISORS) {
  for (const w of WIDTHS) {
    const tag = `_sw-${d.replace('.', '')}-${w.replace('.', '')}`;
    const t0 = Date.now();
    execFileSync('npx', ['tsx', 'dev/render-from-dump.ts', 'improvedschematics-input.json', `dev/${tag}`], {
      env: { ...process.env, OCTI_DIVISOR: d, IS_LINE_WIDTH: w, OCTI_DEBUG: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true,
      timeout: 8 * 60_000,
    });
    const svg = readFileSync(`dev/${tag}.svg`, 'utf-8');
    for (const [suffix, box] of [
      ['-center', '880 1130 360 400'],
      ['-swclump', '300 1900 900 800'],
    ] as const) {
      const cropped = svg.replace(/viewBox="[^"]*"/, `viewBox="${box}"`);
      writeFileSync(
        `dev/${tag}${suffix}.png`,
        new Resvg(cropped, { fitTo: { mode: 'width', value: 880 }, background: 'white' }).render().asPng(),
      );
    }
    console.log(`${tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
console.log('done');
```

- [ ] **Step 4: Run the sweep (~10–20 min for 12 configs)**

Run: `npx tsx dev/_sweep-spacing.ts` (background it if the harness supports it; per-config timeout 8 min)
Expected: 12 × 3 PNGs under `dev/`. No config should time out; if `1.0` divisors blow up runtime, note and continue.

- [ ] **Step 5: Score the configs**

For each config run the quantitative probes with matching env, e.g.:
`$env:OCTI_DIVISOR='1.6'; $env:IS_LINE_WIDTH='3.5'; npx tsx dev/_parity-sw-mult.ts` (then clear: `Remove-Item Env:OCTI_DIVISOR, Env:IS_LINE_WIDTH`)
Acceptance targets (spec): cyan multiplicity ≤ 1.1 (mostly from Task 1 already), sawtooth ≤ 1.3, transect corridor spacing ≥ 6 line-widths, near-duplicate drawn pairs ≈ 0. VIEW the `-swclump` and `-center` crops for every config; record a table (config → multiplicity / spacing / violations / runtime / visual verdict). The decision rule: smallest divisor change that meets spacing ≥ 6 line-widths without detour chaos; prefer keeping divisor 2.5 + thinner lines if it already passes.

- [ ] **Step 6: Commit the sweep tooling (not results)**

```powershell
git add src/render/constants.ts src/render/renderGeographic.ts dev/_sweep-spacing.ts
git commit -m @'
feat(sweep): line-width diagnostic knob + spacing sweep driver

dHat decoupled from lineWidth (pinned >=16) so thinner strokes do not
shrink the merge radius.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Apply the chosen spacing defaults

**Files:**
- Modify: `src/render/constants.ts` (`LINE_WIDTH_DEFAULT`)
- Modify: `src/render/renderGeographic.ts` (divisor policy in `renderSmoothed`)

- [ ] **Step 1: Set the winning defaults**

From Task 2's table: set `LINE_WIDTH_DEFAULT` to the chosen width, and in `renderSmoothed` update the divisor policy (current shape:)

```ts
const divisor =
  (typeof process !== 'undefined' && Number((process as { env?: Record<string, string> }).env?.OCTI_DIVISOR)) ||
  (support.edges.size > 800 ? 1.2 : 2.5);
```

Replace `2.5` (and `1.2` if the sweep says so) with the winning values, updating the comment block above it with the sweep evidence (date, dump, chosen numbers).

- [ ] **Step 2: Full regression battery**

Run, in order:
- `pnpm test 2>&1 | Select-Object -Last 5` → all pass
- `pnpm typecheck 2>&1 | Select-Object -Last 2` → clean
- `npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dump` → view full + center + SW crops
- `npx tsx dev/_parity-q1-support.ts` → Q1 numbers still pass (≤ 60px / ≤ 70px)
- `npx tsx dev/_parity-sw-mult.ts` and `npx tsx dev/_parity-sw-anatomy.ts` → spec targets met
- `npx tsx dev/_parity-dhat-svgscan.ts` → zero overdraw pairs
- `npx tsx dev/_checkpoint.ts` → view `dev/_chk-nyc-smoothed.png`; thinner lines change NYC's look — verify bundles remain legible (lane gaps scale with LINE_WIDTH automatically via offsets.ts)
- `npx tsx dev/render-sea-compare.ts` → geojson path still renders

- [ ] **Step 3: Commit**

```powershell
git add src/render/constants.ts src/render/renderGeographic.ts
git commit -m @'
feat(render): adopt sweep-chosen line width + grid divisor for corridor spacing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: Conditional capsule cleanup (skip if criteria already met)

**Files:**
- Modify: `src/render/stops.ts` (only if needed)

- [ ] **Step 1: Measure**

Count capsule glyphs in the SW window of the new `dev/_dump.svg`: capsules are the two-`<line>` pill groups emitted by `src/render/stops.ts` (border stroke `2r+3` + fill stroke `2r`, round caps). Quick count:
`Select-String -Path dev/_dump.svg -Pattern 'stroke-linecap="round"' | Measure-Object` compared against the pre-change count from the investigation crops (~15 in the SW window). **Skip condition:** if the SW window shows ≤ 5 capsules and the clump reads clean in the crop, mark this task complete and move on.

- [ ] **Step 2 (only if needed): Render short capsules as plain station dots**

In `src/render/stops.ts`, where the capsule's farthest-pair axis is computed, add before emitting the two `<line>` elements:

```ts
// A capsule whose axis is barely longer than a dot is corridor-adjacency
// noise (one station group straddling corridors octi placed a cell apart),
// not a real multi-platform complex: draw a plain interchange dot instead.
const axisLen = Math.hypot(bx - ax, by - ay);
if (axisLen < LINE_WIDTH * 2.5) {
  // fall through to the single-circle branch
}
```

Adapt names to the actual locals (`ax/ay/bx/by` are the farthest-pair endpoints in that function; the single-circle branch already exists for 1-node stops). Re-render the dump, re-view the SW crop.

- [ ] **Step 3: Tests + commit (only if Step 2 ran)**

Run: `pnpm test 2>&1 | Select-Object -Last 5` → pass.

```powershell
git add src/render/stops.ts
git commit -m @'
fix(stops): draw sub-dot-length capsules as plain interchange dots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 5: Final verification + handoff

**Files:**
- Modify: `C:\Users\darkd\.claude\projects\C--Users-darkd-Downloads-Improved-Schematics\memory\loom-octi-pipeline.md` (memory note)

- [ ] **Step 1: Build the mod**

Run: `pnpm build 2>&1 | Select-Object -Last 3`
Expected: vite build clean; `dist/` is junction-linked into the game's mods folder, nothing to copy.

- [ ] **Step 2: In-game visual checkpoint**

Ask the user to close/reopen the Improved Schematic panel (the game hot-loads the mod per panel open; no restart). Verify together: blue/pink separated in the center; Tacoma clump reads as separated corridors; overall map unharmed. The panel toolbar version marker should still read v0.2.1 (bump if another build marker is wanted).

- [ ] **Step 3: Update memory**

Append to the memory file's parity section: refeed fix (eps=dHat, measured numbers), chosen line width + divisor with sweep evidence, capsule outcome, and that dHat is now pinned ≥16 independent of lineWidth.

- [ ] **Step 4: Close out**

Mark the plan's tasks complete; update the session task list; offer `superpowers:finishing-a-development-branch` (merge to master per user's standing preference) when the user is satisfied with the in-game result.
