# Capsule Seat Cleanliness (I10) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The capsule seat solve pays a graded, dominant cost for placing a
marker where its own line is painted UNDER another line (occluded ink), per
spec `docs/superpowers/specs/2026-07-18-capsule-seat-cleanliness-design.md`.
The fanzone stop-mark census classifies its intrusions by occlusion
(visible / occluded-avoidable / occluded-certified / lone-stop) and the
`occluded-avoidable` class gates at 0.

**Architecture:** A new pure oracle module (`src/render/layout/seatInk.ts`)
snapshots post-fan lane ink into a spatial hash with per-line stroke ranks
(from a hoisted `computePaintGroups`) and answers `dirtAt(p, lineId)`. The
renderer composes it into the existing `ropts.proximity` closure (rowPlace.ts
untouched), records per-mark dirt at commit, and the census re-queries final
positions to classify.

**Tech stack:** TypeScript, Node built-in test runner (`npx tsx --test`),
existing census plumbing (`OCTI_FANZONE`), byte-identity harness
(`dev/_byte-identity.ts`, gitignored), corpus census runner
(`dev/_fanzone_census.ts`, gitignored).

---

### Task 1: seatInk oracle module with tests

**Files:**
- Create: `src/render/layout/seatInk.ts`
- Test: `src/render/layout/tests/seatInk.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover, on hand-built fixtures (spacing 6, threshold 4.5):

1. A foreign strand with HIGHER rank within the threshold of `p` →
   `dirtAt > 0`, graded: dirt at distance 1 > dirt at distance 4; dirt
   beyond threshold = 0.
2. The same strand with LOWER rank (paints below) → 0.
3. Own line's strand (any rank) → 0.
4. Same-color higher-rank strand → 0 (invisible occlusion).
5. Two occluders → dirt = MAX depth, not sum.
6. Join-curve samples count: a quadratic `{a, apex, b}` of a higher-ranked
   line passing near `p` → dirt > 0.

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { buildSeatInkOracle } from '../seatInk';
import type { Pixel } from '../types';

const SP = 6;
const mk = (over: Partial<Parameters<typeof buildSeatInkOracle>[0]> = {}) =>
  buildSeatInkOracle({
    segments: [
      { lineId: 'under', pts: [[0, 10], [100, 10]] as Pixel[] },
      { lineId: 'over', pts: [[0, 12], [100, 12]] as Pixel[] },
    ],
    joinCurves: [],
    strokeRank: new Map([['seat', 1], ['under', 0], ['over', 2]]),
    colorOf: new Map([['seat', '#f00'], ['under', '#0f0'], ['over', '#00f']]),
    spacing: SP,
    ...over,
  });
// dirtAt([50, 10], 'seat'): 'over' at distance 2 (< 4.5) and rank 2 > 1 -> dirty;
// 'under' at distance 0 but rank 0 < 1 -> clean.
```

(Exact assertions per the six cases; keep fixtures minimal.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/render/layout/tests/seatInk.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/render/layout/seatInk.ts`**

```ts
// Seat-ink cleanliness oracle (invariant I10, spec 2026-07-18): a candidate
// stop-dot position is dirty when the mark's own line is OCCLUDED there — a
// strand of a different-colored line with a HIGHER stroke rank (painted
// later, so visually on top) lies within the sub-pitch threshold. Graded by
// the proximity deficit; the seat solve adds it as a soft cost, never a veto.

import type { Pixel } from './types';

export interface SeatInkArgs {
  /** Post-fan lane pieces: every drawn polyline with its owning line. */
  segments: Array<{ lineId: string; pts: Pixel[] }>;
  /** Fan join curves, sampled into strands (quadratic a/apex/b). */
  joinCurves: Array<{ lineId: string; a: Pixel; apex: Pixel; b: Pixel }>;
  /** Global stroke rank per line (paint order position; higher = on top). */
  strokeRank: Map<string, number>;
  /** Line color per line (same-color occlusion is invisible: excluded). */
  colorOf: Map<string, string>;
  spacing: number;
}

export interface SeatInkOracle {
  /** Occlusion depth at p for a mark of `lineId`: max over occluding
   *  strands of (threshold - distance), 0 when the line is top ink. */
  dirtAt(p: Pixel, lineId: string): number;
  /** Sub-pitch threshold (0.75 * spacing), exposed for census parity. */
  threshold: number;
}

export function buildSeatInkOracle(args: SeatInkArgs): SeatInkOracle {
  const threshold = 0.75 * args.spacing;
  const cell = Math.max(8, Math.ceil(threshold * 2));
  interface Seg { ax: number; ay: number; bx: number; by: number; rank: number; color: string; lineId: string }
  const grid = new Map<string, Seg[]>();
  const put = (s: Seg) => {
    const x0 = Math.floor((Math.min(s.ax, s.bx) - threshold) / cell);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + threshold) / cell);
    const y0 = Math.floor((Math.min(s.ay, s.by) - threshold) / cell);
    const y1 = Math.floor((Math.max(s.ay, s.by) + threshold) / cell);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = gx + ',' + gy;
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(s);
      }
    }
  };
  const addPoly = (lineId: string, pts: Pixel[]) => {
    const rank = args.strokeRank.get(lineId);
    if (rank === undefined) return;
    const color = (args.colorOf.get(lineId) ?? '').toLowerCase();
    for (let i = 1; i < pts.length; i++) {
      put({ ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1], rank, color, lineId });
    }
  };
  // deterministic construction order (queries take a max, but keep sorted
  // insertion anyway so the structure itself is reproducible)
  for (const s of args.segments) addPoly(s.lineId, s.pts);
  for (const jc of args.joinCurves) {
    const pts: Pixel[] = [];
    for (let k = 0; k <= 6; k++) {
      const u = k / 6;
      const w = 1 - u;
      pts.push([
        w * w * jc.a[0] + 2 * w * u * jc.apex[0] + u * u * jc.b[0],
        w * w * jc.a[1] + 2 * w * u * jc.apex[1] + u * u * jc.b[1],
      ]);
    }
    addPoly(jc.lineId, pts);
  }
  const dirtAt = (p: Pixel, lineId: string): number => {
    const myRank = args.strokeRank.get(lineId) ?? -Infinity;
    const myColor = (args.colorOf.get(lineId) ?? '').toLowerCase();
    const gx = Math.floor(p[0] / cell);
    const gy = Math.floor(p[1] / cell);
    let worst = 0;
    const segs = grid.get(gx + ',' + gy);
    if (!segs) return 0;
    const t2 = threshold * threshold;
    for (const s of segs) {
      if (s.lineId === lineId) continue;
      if (s.rank <= myRank) continue;      // paints below: my ink is on top
      if (s.color === myColor) continue;   // invisible occlusion
      const vx = s.bx - s.ax, vy = s.by - s.ay;
      const len2 = vx * vx + vy * vy;
      let t = len2 > 1e-12 ? ((p[0] - s.ax) * vx + (p[1] - s.ay) * vy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = p[0] - (s.ax + vx * t), dy = p[1] - (s.ay + vy * t);
      const d2 = dx * dx + dy * dy;
      if (d2 >= t2) continue;
      const depth = threshold - Math.sqrt(d2);
      if (depth > worst) worst = depth;
    }
    return worst;
  };
  return { dirtAt, threshold };
}
```

Note the padded insertion (`± threshold` on the bbox): a query only reads its
OWN cell, and padding guarantees every segment within `threshold` of any
point in that cell is present. One map lookup per query instead of nine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/render/layout/tests/seatInk.test.ts` → all pass.

- [ ] **Step 5: Full suite, commit**

Run: `npm test` → 679 + new all pass.
Commit: `feat(seat): seat-ink occlusion oracle (I10)` (message via temp file).

### Task 2: hoist computePaintGroups; derive stroke ranks

**Files:**
- Modify: `src/render/renderOctilinear.ts`

- [ ] **Step 1: Hoist the paint-group computation**

Today `arcOfEdge` + `computePaintGroups` run at the end of
`computeRibbonGeometry` (search for "Bundle-coherent paint layers"). Move
both to just AFTER the fan-builder block and its `orderOf` re-filter (search
for "re-filter the drawn order"), keeping the variable names. The emission
site keeps using the hoisted `paintGroups` value. Derive the rank once:

```ts
// Global stroke rank = paint position (group index major, in-group index
// minor). A higher-ranked line's stroke paints later, i.e. on top.
const strokeRank = new Map<string, number>();
{
  let r = 0;
  for (const g of paintGroups) for (const id of g) strokeRank.set(id, r++);
}
```

- [ ] **Step 2: Verify nothing between the two sites mutates `orderOf`**

Grep `orderOf.set` / `orderOf.delete` in the file; the only mutations must
sit above the hoisted call (slot synthesis, sliver suppression, fan
absorption re-filter). If the marker machinery mutates it anywhere, STOP and
re-scope (the spec's rank-stability risk).

- [ ] **Step 3: Byte-identity gate (pure refactor)**

Run `dev/_byte-identity.ts` over the map dumps (both modes, background).
Expected: byte-identical everywhere. The hoist must not change output.

- [ ] **Step 4: Commit**

`refactor(paint): hoist paint-group computation above marker placement`

### Task 3: wire the oracle into the seat solve

**Files:**
- Modify: `src/render/renderOctilinear.ts`
- Modify: `src/render/layout/types.ts` (StopMark)
- Modify: `src/render/mapCache.ts` (VERSION 30 → 31)

- [ ] **Step 1: Build the oracle before the placement queue**

In the stations block, right before the placement-order comment (search
"rigid-row marker placement"), snapshot the ink and build:

```ts
// Seat-ink oracle (I10): built from the post-fan lane pieces, BEFORE any
// marker pass mutates them. Seat costs and the census both read it.
const seatInk = buildSeatInkOracle({
  segments: [...segPath.keys()].sort().map((k) => ({
    lineId: k.slice(k.indexOf('|') + 1),
    pts: segPath.get(k)!,
  })),
  joinCurves,
  strokeRank,
  colorOf: new Map([...lineById].map(([id, l]) => [id, l.color])),
  spacing,
});
const seatInkW = (() => {
  const v = envNum('OCTI_SEATINK_W');
  return Number.isFinite(v) && v >= 0 ? v : 300;
})();
```

`seatInkW` default 300/px: above the comfort scale (40), below the
hull-penetration scale (1000/px) and the gap-deficit scale (5000/px), per
the spec's cost hierarchy. `OCTI_SEATINK_W=0` is the A/B kill switch
(drawn output must then match current behavior).

- [ ] **Step 2: Add the per-dot cost**

The station `ropts.proximity` closure needs the mark's line id, which the
current signature `(p: Pixel) => number` does not carry. Extend the
callback signature to `(p: Pixel, memberIdx?: number) => number` in
`RowOpts` (rowPlace.ts: threading the DOT'S member index through
`buildStates`' proximity call — a one-line change at the call site
`proximity(dots[gi])` → `proximity(dots[gi], group[gi])`, plus pairEval's
corner-clearance loops keep calling it without the index). In
renderOctilinear's `ropts.proximity`, add:

```ts
if (memberIdx !== undefined) {
  pen += seatInkW * seatInk.dirtAt(p, s.marks[memberIdx].lineId);
}
```

Every ladder tier (primary, far-attach, best-effort, relaxed) spreads
`ropts` or wraps `ropts.proximity`, so all inherit — verify each wrapper
forwards the second argument.

- [ ] **Step 3: Record per-mark dirt at commit**

At the placement loop's commit point (`for (const mk of s.marks)
placedDots.push(mk.pos)`), record `mk.seatDirt = seatInk.dirtAt(mk.pos,
mk.lineId)` — covers capsule marks AND single-mark units uniformly. Add
`seatDirt?: number` to the gathered-mark type, thread it through `addStop`
(one more optional parameter, same style as `outward`), and add the field
to `StopMark` in `layout/types.ts` with a doc comment (OPTIONAL: geometry
serialized before it existed deserializes without it).

- [ ] **Step 4: mapCache VERSION 30 → 31** (drawn mark positions change).

- [ ] **Step 5: Tests + robustness gate**

- `npm test` → all pass.
- `npx tsx dev/robustness-check.ts dev/_robustness`: all 8 columns at or
  below the current row values (base 0/0/0/0/50/0/0, growth2 5/0/3/1/57/2/1,
  growth45 0/0/2/0/20/0/0, nosplit 1/1/0/1/34/0/0, warp05 3/2/1/0/34/0/0,
  warp09 3/0/2/0/55/0/0); contig column MUST stay 0.
- A/B: one dump rendered with `OCTI_SEATINK_W=0` matches the pre-change
  SVG byte-for-byte (proves the wiring is cost-only).

- [ ] **Step 6: Commit**

`feat(seat): occlusion-aware seat cost + per-mark dirt recording (I10)`

### Task 4: census classification

**Files:**
- Modify: `src/render/debug/renderOctilinear.debug.ts` (`reportStopSeating`)
- Modify: `src/render/renderOctilinear.ts` (call site)

- [ ] **Step 1: Extend `reportStopSeating`**

New args: `dirtAt: (p: Pixel, lineId: string) => number` (the oracle,
re-queried at FINAL mark positions). Marks carry `seatDirt` already. Inside
the existing intrusion loop, classify each flagged mark:

```ts
const finalDirt = d.dirtAt(m.pos, m.lineId);
const cls =
  finalDirt <= 0 ? 'visible'
  : marks.length === 1 ? 'lone-stop'
  : (m.seatDirt ?? 0) > 0 ? 'occluded-certified'
  : 'occluded-avoidable';
```

Print the class on each intrusion line; keep the existing summary line
`[fanzone] N stop-mark intrusions` VERBATIM (scripts grep it) and add one
breakdown line:
`[fanzone] classes: V visible, A occluded-avoidable, C occluded-certified, L lone-stop`.

- [ ] **Step 2: Wire the call site** — pass `seatInk.dirtAt` through (the
  oracle is in scope; the reporters run inside `computeRibbonGeometry`).
  When stations are off (`seatInk` not built), pass `() => 0`.

- [ ] **Step 3: `npm test`, then commit**

`feat(census): occlusion classes in the fanzone stop-mark census (I10)`

### Task 5: corpus verification, tuning, baselines

- [ ] **Step 1: Full-recompute corpus census** (background, ~10 min)

`RECOMPUTE=1 npx tsx dev/_fanzone_census.ts` (extend the scratch runner to
also capture the class-breakdown line and the clips/loops/zigs/tapers/
spikes/stairs/contig summaries with all census env flags set).

Gates:
- `occluded-avoidable` = 0 in every city. Nonzero = a bug (rank drift,
  oracle blind spot, post-seat slide) — diagnose before any tuning.
- Occluded totals materially below today's 64-line baseline; `visible`
  absorbs the legitimate capsule-group seats.
- Clips/loops/zigs/non-contig 0 everywhere; tapers ≤ 2 (HOR); spikes ≤
  NYC 50 / SF 37 / SEA 13 / HOR 32 / DEN 5 / LON 7; stairs ≤ SF 1; twist
  census 0 (`dev/_twist_census.ts` if in doubt).

- [ ] **Step 2: Visual scrutiny**

Before/after crops (dev/_i10_crop.ts) of: WTC/Rector cluster (NYC
3470,5165), Court Sq, Times Sq (3212,4077), Montgomery (SF 4383,4515),
Bar Ilan (HOR 4168,3569), Neve Sha'anan (2615,3665). Full-map PNG diff per
city to bound seat churn. Surface the crops to the user.

- [ ] **Step 3: Weight tuning (only if needed)**

If churn is excessive or occluded counts barely move, adjust `seatInkW`
once, re-run Step 1, and revert if the trade worsens (one invariant at a
time; falsified work gets reverted, per repo discipline).

- [ ] **Step 4: Record + report**

Update the auto-memory (new per-class pinned baselines per city, weight
chosen) and report the numbers + crops to the user for sign-off. Deprecation
sweep (legacy ladder to `old/`) stays with the junction-fan-rebuild signoff,
not this task.
