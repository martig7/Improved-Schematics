# Loop Hook Suppression + Connector Clamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the LON pink-triangle/hairpin loops (post-octi hook suppression) and the bundle-join spikes (node-connector lateral clamp), regression-gated on three city dumps.

**Architecture:** A pure helper extraction + clamp in `renderOctilinear.ts`'s node-connector; a new `src/render/layout/hookSuppress.ts` pass between `supportToLayout` and `orderLines` in `precomputeSmoothed`; schema 9. Spec: `docs/superpowers/specs/2026-07-02-loop-hook-and-spike-fix-design.md` (read it first — it contains the root-cause analysis, exact formulas, thresholds, and safety rules).

**Tech Stack:** TypeScript, `tsx --test`. Determinism: `+ − × ÷ √ min max`, id-ordered iteration. Test suite currently 357 pass; typecheck has 31 pre-existing errors (imageMerge/topo/renderGeographic) — add zero.

---

## Context for a zero-context engineer

- Branch: create `loop-spike-fix` from master (eed913f or later).
- Root-cause evidence and repro assets: `dev/_lon-input-extracted.json` (extracted LON input; full re-sim via `npx tsx dev/render-from-dump.ts dev/_lon-input-extracted.json <outPrefix>`), reference crops `dev/_lon-loop.png` / `dev/_lon-spike.png`, investigation probes `dev/_loopinv-*.ts` / `dev/_spikeinv-*` (read them — they contain working code for extracting support/layout state and SVG path vertices).
- The hook (LON): magenta line `ae6e2fb2` traversal `LIF(2244,1980) → mn1(2244,2112) → mn75(2288,2068) → Old Burlington(2187,2081)`; mn1/mn75 are synthetic (non-station) layout nodes. Yellow `949c0193` runs LIF→mn1→Marlborough with no fold — must NOT be spliced.
- The spike: connector cubic at `renderOctilinear.ts` ~2828-2941 (curve emitted ~2932-2938, `k` at ~2918). Yellow overshoot: pa=(1454.9,1389.3), pb=(1490.3,1394.9), dirA=45°SE, dirB=E, spacing 5.5, drawn overshoot 3.4px.
- Layout shape: `layout.edges` (id, from, to, course/geo?), `layout.nodes` Map, `layout.lineTraversals` Map<lineId, {edgeId, reversed}[]>; stations distinguishable via the stations set / marker data in `precomputeSmoothed` (see how `supportToLayout` + the spur-step cleanup at renderGeographic.ts ~940-965 walk traversals — mirror that idiom). READ the actual structures before coding; the plan intentionally defers exact field names to the code.

### Task 1: Connector clamp (`renderOctilinear.ts`)

**Files:** Modify `src/render/renderOctilinear.ts`; Create `src/render/layout/connectorClamp.ts` + `src/render/layout/connectorClamp.test.ts`

- [ ] **1.1** Read the connector block (~2828-2941). Extract the control-point math into `src/render/layout/connectorClamp.ts`:

```ts
import type { Pixel } from './types';

export interface ConnectorControls { c1: Pixel; c2: Pixel }

/** Tangent-matched cubic control points for a node-connector bridge, with a
 *  PER-END lateral clamp: a control point may not cross the far end's lane
 *  line (spec §1 — the uncapped longitudinal k let a 45° approach dive ~3.4px
 *  past the destination lane and read as a spike). kBase is the existing
 *  min(spacing*4, max(gap, spacing*2), lon) — this helper only LOWERS it. */
export function connectorControls(
  pa: Pixel, pb: Pixel, dirA: Pixel, dirB: Pixel, kBase: number,
): ConnectorControls {
  const d: Pixel = [pb[0] - pa[0], pb[1] - pa[1]];
  // outgoing-axis unit + normal (dirB is unit-length at the call site)
  const nB: Pixel = [-dirB[1], dirB[0]];
  const lat = Math.abs(d[0] * nB[0] + d[1] * nB[1]); // slot delta across the corridor
  const perpA = Math.abs(dirA[0] * nB[0] + dirA[1] * nB[1]);
  const kA = perpA > 0.15 ? Math.min(kBase, lat / perpA) : kBase;
  const nA: Pixel = [-dirA[1], dirA[0]];
  const latA = Math.abs(d[0] * nA[0] + d[1] * nA[1]);
  const perpB = Math.abs(dirB[0] * nA[0] + dirB[1] * nA[1]);
  const kB = perpB > 0.15 ? Math.min(kBase, latA / perpB) : kBase;
  return {
    c1: [pa[0] + dirA[0] * kA, pa[1] + dirA[1] * kA],
    c2: [pb[0] - dirB[0] * kB, pb[1] - dirB[1] * kB],
  };
}
```

- [ ] **1.2** TDD first — failing tests in `connectorClamp.test.ts` (write before the helper exists):

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { connectorControls } from './connectorClamp';

const SQ = Math.SQRT1_2;
// Max |perpendicular-to-dirB| excursion of the cubic vs the pb lane, sampled.
function overshoot(pa: [number, number], pb: [number, number], c1: [number, number], c2: [number, number], dirB: [number, number]): number {
  const nB = [-dirB[1], dirB[0]];
  const lanePB = pb[0] * nB[0] + pb[1] * nB[1];
  const lanePA = pa[0] * nB[0] + pa[1] * nB[1];
  const lo = Math.min(lanePA, lanePB), hi = Math.max(lanePA, lanePB);
  let worst = 0;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const u = 1 - t;
    const x = u*u*u*pa[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*pb[0];
    const y = u*u*u*pa[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*pb[1];
    const lane = x * nB[0] + y * nB[1];
    worst = Math.max(worst, Math.max(lo - lane, lane - hi, 0));
  }
  return worst;
}

test('connectorControls: LON spike geometry — overshoot collapses to < 0.5px', () => {
  const pa: [number, number] = [1454.9, 1389.3], pb: [number, number] = [1490.3, 1394.9];
  const dirA: [number, number] = [SQ, SQ], dirB: [number, number] = [1, 0];
  const { c1, c2 } = connectorControls(pa, pb, dirA, dirB, 22.0);
  assert.ok(overshoot(pa, pb, c1, c2, dirB) < 0.5, `overshoot ${overshoot(pa, pb, c1, c2, dirB)}`);
});

test('connectorControls: large lateral jog (NYC-scale) keeps the base tangent', () => {
  // 60px slot jump across the corridor: lat=60 >> kBase*perpA — clamp inactive.
  const pa: [number, number] = [0, 0], pb: [number, number] = [40, 60];
  const { c1 } = connectorControls(pa, pb, [SQ, SQ], [1, 0], 22.0);
  assert.ok(Math.abs(c1[0] - (0 + SQ * 22)) < 1e-9); // full kBase used
});

test('connectorControls: collinear ends unchanged', () => {
  const { c1, c2 } = connectorControls([0, 0], [50, 0], [1, 0], [1, 0], 22.0);
  assert.deepEqual(c1, [22, 0]);
  assert.deepEqual(c2, [28, 0]);
});
```

Run → FAIL (module missing) → implement 1.1 → PASS.

- [ ] **1.3** Swap the inline math in renderOctilinear.ts's connector to call `connectorControls(pa, pb, dirA, dirB, k)` (keep the existing k computation as kBase; delete only the c1/c2 lines it replaces). Import at top. Full suite (`npx tsx --test "src/**/*.test.ts"`, expect 357+3=360) + typecheck (zero new).
- [ ] **1.4** Commit: `feat(render): clamp node-connector tangents to the lane band (bundle-join spike fix)`

### Task 2: Hook suppression pass

**Files:** Create `src/render/layout/hookSuppress.ts` + `src/render/layout/hookSuppress.test.ts`; Modify `src/render/renderGeographic.ts` (insert call after the spur-step cleanup, before `orderLines`)

- [ ] **2.1** Read the layout structures (types in src/render/layout/types.ts, the traversal-walking idiom at renderGeographic.ts ~940-965, supportToLayout). Design `suppressHooks(layout: Layout, isStation: (nodeId: string) => boolean, opts?: { ratio?: number; fold?: number }): { spliced: number }` implementing spec §2 EXACTLY (detection: interior-synthetic runs, ratio > 1.7 AND fold dot < −0.2; splice: octilinear 2-segment shortcut edge, reuse per (A,E), remove line from hook edges, drop emptied edges, rewrite traversal; safety: A≠E, no station stops inside, ≤8 splices/line, id-ordered determinism; env OCTI_HOOK_RATIO/OCTI_HOOK_FOLD read at the CALL SITE in renderGeographic, passed as opts).
- [ ] **2.2** TDD — synthetic-layout tests written FIRST (build a minimal Layout literal; mirror the LON triangle numerically):
  - triangle A(2244,1980)→s1(2244,2112)→s2(2288,2068) with A,E=s2 real-flagged appropriately → spliced: new edge A↔s2, traversal rewritten, s1 edges lose the line;
  - straight-through synthetic run (yellow shape: dot ≈ +1) → untouched;
  - run containing a station stop for the line → untouched;
  - two lines sharing the same hook → ONE shortcut edge carrying both;
  - A==E closed loop → untouched;
  - determinism: run twice on structurally-equal inputs → deep-equal outputs.
- [ ] **2.3** Implement until green. Determinism discipline throughout.
- [ ] **2.4** Wire into `precomputeSmoothed` (after spur-step cleanup block, before `orderLines(layout)`): build `isStation` from the same station-node knowledge the marker path uses (nodes with marks — check how `gathered`/stations map to layout node ids; `supportM.stations` keys at ~line 998 is the likely source); log `[hooks] spliced=N` under OCTI_PLACE_DEBUG or OCTI_TRACE. Full suite + typecheck.
- [ ] **2.5** Commit: `feat(layout): suppress zero-progress synthetic hooks (LON pink-triangle fix)`

### Task 3: Schema 9 + dump verification

- [ ] **3.1** cacheFingerprint.ts SCHEMA 8→9 + history comment (connector clamp + hook suppression change drawn geometry/layouts; bust main + detail-inset caches). Fingerprint test passes.
- [ ] **3.2** LON full re-sim (`OCTI_PLACE_DEBUG=1 OCTI_TRACE=1 npx tsx dev/render-from-dump.ts dev/_lon-input-extracted.json dev/_lon-fixed`): triangle GONE (crop map-px ~(1345,1425) span 220 — compare dev/_lon-loop.png), spike GONE (probe the yellow `#fccc0a` / magenta `#b933ad` d-fragments near (1470-1520, 1385-1405): max overshoot < 1px — adapt dev/_spikeinv probes), `[hooks] spliced=N` reported (expect ≥ 3: magenta/green/orange), contig via dev/_contig-fresh.ts all-pass, `[capsaudit:final] cross=0 self=0`.
- [ ] **3.3** NYC-difficult re-sim (dev/_nyc-input-extracted.json): 38/38 contig, megaboxes ≤ 5, capsaudit 0/0, JFK crop sane. SEA re-sim (dev/_sea-input-extracted.json): megaboxes ≤ 1, capsaudit 0/0. Record all numbers; any regression = STOP and report, do not tune silently.
- [ ] **3.4** `npm test` + typecheck + `npm run build`. Commit schema bump: `chore(cache): schema 9 — hook suppression + connector clamp change layouts`

### Task 4: Finish

- [ ] **4.1** Report before/after crop paths for the controller's visual checkpoint (dev/_lon-loop.png vs the new crop; spike area likewise). Controller sends to user, dispatches final whole-branch review, then finishing-a-development-branch (merge to master per user preference).

## Self-review notes

- Spec §1 → Task 1; §2 → Task 2; schema/§3 → Task 3; verification → Tasks 3-4. Deliberate deviation from full no-placeholder rigor: Task 2's exact Layout field names are deferred to the code (the plan names the files/line anchors and the investigation probes that already walk these structures) — the implementer must READ before coding, per the plan's context section.
- Types consistent: `connectorControls`/`ConnectorControls`, `suppressHooks` signature used in Tasks 2.1/2.4.
