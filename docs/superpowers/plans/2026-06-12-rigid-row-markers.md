# Rigid-Row Station Markers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-dot chain-DP marker solver with the rigid-row model of `docs/superpowers/specs/2026-06-12-rigid-row-markers-design.md`: bundles place straight octilinear rows (slide + snapped rotation), dots are row×lane intersections, pairings derive elbow corners, and the only fallback is the mega box.

**Architecture:** New `src/render/layout/rowPlace.ts` (row states, feasibility, pairing enumeration, bundle-level chain DP, corner derivation) consuming the existing lane-curve geometry from `chainPlace.ts`. `renderOctilinear.ts` swaps its per-dot solve + repair loop for `solveRows` and deletes `solveChain` consumers; `chainPlace.ts` drops the per-dot solver (geometry layer stays). `stops.ts` gains corner vertices and a per-station mega flag. New octilinearity gate.

**Tech Stack:** TypeScript, node:test via `npm test` (NEVER vitest), renders via `dev/render-from-dump.ts`, gates `dev/_chk-*.ts`.

**Context for every task:** working tree has unrelated pre-existing modifications (dijkstra.*, routes.ts, transfers.ts, api.d.ts, package.json, pnpm-lock.yaml, .gitignore, many untracked dev/_*) — stage ONLY the files named in each task's commit step. Commit footer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (PowerShell here-string `@'...'@`, closing `'@` at column 0). tsc has pre-existing errors in imageMerge.ts/topo.ts/renderGeographic.ts — touched files must contribute none. Style: 2-space, single quotes, constraint-stating comments.

---

### Task 1: rowPlace — rigid-row solver

**Files:**
- Create: `src/render/layout/rowPlace.ts`
- Test: `src/render/layout/rowPlace.test.ts`

Interfaces (exact):

```ts
import type { Pixel } from './types';
import { type LaneCurve, curvePoint, curveTangent, octOff } from './chainPlace';

export interface RowOpts {
  minGap: number;        // 2r - 0.05
  arcLimit: number;      // slide window each side (24; caller escalates to 48)
  step?: number;         // slide grid, default 0.5
  extCap: number;        // max extension per row at a corner (6 * spacing)
  slideW?: number;       // W_S, default 0.05
  rotW?: number;         // W_ROT, default 20 (px per 45-degree step)
  blocked?: (p: Pixel) => boolean; // spec §6 mask — a row state is infeasible
                                   // if ANY of its dots is blocked (never dropped)
}

export interface RowSolution {
  /** per input mark index: dot position (row line × its lane curve) */
  pos: Pixel[];
  /** station-wide visiting order over mark indices (rows concatenated) */
  order: number[];
  /** corner vertex AFTER order[k] (chain position), for pair boundaries */
  cornerAfter: Map<number, Pixel>;
  cost: number;
}

/** Exact bundle-level solve per spec v2 §2. groups = mark indices per bundle
 *  in lane order; curves[i] = mark i's lane curve. Returns null when NO
 *  pairing/orientation admits a feasible configuration — caller falls back
 *  to the mega box (spec v2 §3). */
export function solveRows(
  curves: LaneCurve[],
  groups: number[][],
  opts: RowOpts,
): RowSolution | null;
```

Algorithm (follow exactly; helpers are module-private):

1. **Row states per bundle.** Carrier = `curves[group[0]]`. For each slide `s` on the grid over `[-arcLimit, +arcLimit]` and each axis `theta ∈ {0°, 45°, 90°, 135°}` (unit vectors): row anchor `A = curvePoint(carrier, carrier.anchorT + s)`; row line = `(A, u_theta)`. Compute each member dot as the intersection of the row LINE with the member's lane curve: walk the lane polyline segments, find crossings of the line (sign change of the lateral offset `(pt−A)·n`, `n = perp(u_theta)`), take the crossing nearest the member's own anchor; REQUIRE one within the window for every member, else the state is infeasible. Then: project dots onto `u_theta`; require strictly increasing in the group's lane order OR strictly decreasing (a reversed row is the same row); require consecutive projected gaps ≥ `minGap`; require `!blocked(dot)` for all dots. Rest axis = octilinear direction minimizing `octOff(angle(perp of mean lane tangent at anchors))` — i.e. compute the bundle's mean tangent at the member anchors (sign-normalized, as the grouping code does), take its perpendicular, snap to the nearest of the four axes; `rot(theta)` = minimal number of 45° steps between `theta` and the rest axis (0..2). State cost = `slideW * |s| + rotW * rot`.
   Cache per bundle: `states: Array<{ s, theta, dots: Pixel[], a: Pixel, b: Pixel, dir: Pixel, cost }>`, where `a`/`b` = outermost dot positions along the row (the row segment), `dir` = u_theta oriented a→b.
2. **Pair feasibility + cost** (for adjacent rows P=states of row1, Q=states of row2, with chosen facing ends): corner `P0` = intersection of the two row LINES. Parallel axes (same theta mod 180°): feasible iff lateral offset < 0.75px AND the facing end gap ≥ 0 — corner = midpoint of facing ends, ext = gap/2 each, capped. Non-parallel: V-not-T — `P0` must lie at-or-beyond the facing end of EACH row along its outward direction (dot ≥ −0.5 tolerance); `ext_row = distance(facing end, P0)` each ≤ `extCap`; `P0` must clear every dot of both rows by ≥ `minGap`. Pair cost = `ext1 + ext2`.
3. **Pairing enumeration + DP.** Enumerate row sequences and orientations exactly like `solveChain` did for groups (`g! * 2^g`, g ≤ 5; beyond: greedy — copy the existing pattern). For each pairing: chain DP over bundles, states from step 1, transitions from step 2; pick the global best across pairings (deterministic tie-break: first found). Single bundle: best unary state, no corners. Single-dot bundles: the "row" is the dot's lane crossing... a one-member group's states are (s, theta) with the single dot at `curvePoint(curve, anchorT + s)` — NOTE for one dot the row line direction still matters for corners; dots = [that point]; a=b=the point.
4. **Station-level post-checks** on the winning configuration: all-pairs dot floors (non-adjacent rows included), corner-vs-corner ≥ minGap, corner-vs-dot ≥ minGap for dots of NON-paired rows too. Violation ⇒ return null (caller may escalate window, then mega).
5. **Output:** order = concatenation of rows in pairing order (each row's members sorted by projection along its dir, honoring orientation); `cornerAfter.set(orderIndexOfLastDotOfRow_k, corner_k)`; pos per mark.

- [ ] **Step 1: failing tests** — write `rowPlace.test.ts` with (use a `lane(y)` helper building horizontal `LaneCurve`s via `buildLaneCurve` as chainPlace.test.ts does):
  - perpendicular rest: 3 parallel horizontal lanes at pitch, anchors staggered ±3px → dots exactly vertical (same x within 0.51), zero rotation (assert pair gaps ≈ pitch, all on lanes), cost ≤ slideW*small.
  - V-not-T: two bundles meeting at 90° (horizontal lanes + vertical lanes), anchors offset so the natural corner is beyond both rows → solution non-null, cornerAfter has 1 corner, corner beyond both rows' facing ends (assert via dot products).
  - parallel-collinear: two single-lane bundles on the SAME horizontal line, anchors 20px apart → joined with corner at the midpoint, ext ≤ 10 each.
  - infeasible → null: two bundles whose lanes are wholly coincident (identical lanes) so every cross-dot pair violates the floor → expect null (mega signal).
  - blocked mask: `blocked` vetoing the rest position forces a slide; never a violation.
  - determinism: deepEqual across two runs.
- [ ] **Step 2:** run `npx tsx --test src/render/layout/rowPlace.test.ts` — FAIL (module missing).
- [ ] **Step 3:** implement per the algorithm above.
- [ ] **Step 4:** tests pass; `npm test` all pass; `npx tsc --noEmit 2>&1 | Select-String 'rowPlace'` empty.
- [ ] **Step 5:** commit: `git add src/render/layout/rowPlace.ts src/render/layout/rowPlace.test.ts` + `git commit -m "feat(rows): rigid-row solver - octilinear rows, derived corners, mega signal"`

---

### Task 2: wire rowPlace into renderOctilinear; delete the per-dot solver

**Files:**
- Modify: `src/render/renderOctilinear.ts` (chain placement block)
- Modify: `src/render/layout/chainPlace.ts` (delete solveChain + its types; KEEP LaneCurve/buildLaneCurve/curvePoint/curveTangent/octOff/rdpSimplify)
- Modify: `src/render/layout/chainPlace.test.ts` (delete per-dot solver tests; keep geometry + octOff tests)
- Modify: `src/render/layout/types.ts` (StopMark: add `cornerAfter?: Pixel` and `mega?: boolean`)

- [ ] **Step 1:** In the chain placement block (read it first): keep curve building + union-find grouping + within-group lateral ordering exactly as-is. Replace the solve + §4 repair loop with:

```ts
        const ropts = {
          minGap: 2 * r - 0.05,
          arcLimit: CHAIN_ARC_LIMIT,
          extCap: 6 * spacing,
          blocked: (p: Pixel) => {
            for (const q of placedDots) {
              if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 2 * r - 0.05) return true;
            }
            return false;
          },
        };
        let sol = solveRows(curves, groups, ropts);
        if (!sol) {
          // window escalation: rebuild curves at twice the arc window
          const wide = s.marks.map((mk) =>
            buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT * 2),
          );
          sol = solveRows(wide, groups, { ...ropts, arcLimit: CHAIN_ARC_LIMIT * 2 });
        }
        if (sol) {
          for (let k = 0; k < sol.order.length; k++) {
            const i = sol.order[k];
            s.marks[i].pos = sol.pos[i];
            s.marks[i].chain = k;
            const corner = sol.cornerAfter.get(k);
            if (corner) s.marks[i].cornerAfter = corner;
          }
        } else {
          // spec v2 §3: total fallback — the mega box covers all bundles
          megaFallbacks++;
          for (const mk of s.marks) mk.mega = true;
        }
```

with `let megaFallbacks = 0;` declared next to `placedDots` and logged once after the stations loop: `if (megaFallbacks > 0) console.error('[stops] mega-box fallbacks: ' + megaFallbacks);`. Single-mark stations keep the existing `chain = 0` shortcut. `placedDots` accumulation unchanged.

- [ ] **Step 2:** DELETE: the §4 repair loop (collisionSites/repairVeto/solve-closure/rounds), `solveChain` import; from `chainPlace.ts` delete `solveChain`, `ChainOpts`, `ChainSolution`, the ladder, hardBlocked — keep the geometry layer + `octOff`/`OCT_TOL`/`ELBOW_MIN_F`? Delete `OCT_TOL`/`ELBOW_MIN_F` if nothing references them after the sweep (octOff stays — rowPlace and the octi gate use it). From `chainPlace.test.ts` delete the solver tests (P1/P2/P5/links/floor/determinism/masking); keep geometry + octOff tests. Compiler-chase orphans.
- [ ] **Step 3:** `npm test` all pass; tsc clean for touched files; render both saves; `_chk-seating` 0 >2px both; `_chk-markerfit` 0 STACKED (report overlaps); note the mega-fallback count printed (expect 0; report if not).
- [ ] **Step 4:** commit the four files: `git commit -m "feat(stops): rigid-row placement wired; per-dot solver deleted"`

---

### Task 3: renderer — corner vertices + per-station mega

**Files:**
- Modify: `src/render/stops.ts`

- [ ] **Step 1:** Spine construction: after sorting by `chain`, build the vertex list as dots interleaved with corners: `for each ordered mark: push mk.pos; if (mk.cornerAfter) push mk.cornerAfter;` then `rdpSimplify(vertices, 0.75)` and the existing path emission. (RDP keeps corners: they are genuine bends.)
- [ ] **Step 2:** Mega branch: change the gate `if (MEGA_BOXES && megaEligible && (degByNode?.get(nodeId) ?? 0) >= 12)` to ALSO fire when `marks.some((m) => m.mega)` — i.e. `if ((marks.some((m) => m.mega)) || (MEGA_BOXES && megaEligible && (degByNode?.get(nodeId) ?? 0) >= 12))`. The rect rendering inside is unchanged.
- [ ] **Step 3:** `npm test`; render NYC; visually crop one multi-bundle station (`dev/_crop-any.ts`) and READ it: rows straight, corners crisp.
- [ ] **Step 4:** commit stops.ts: `git commit -m "feat(stops): corner vertices in spine; per-station mega fallback"`

---

### Task 4: octilinearity gate + sweep + ship v0.2.43

**Files:**
- Create: `dev/_chk-octi.ts`
- Modify: `manifest.json`, `src/ui/SchematicPanel.tsx` (0.2.42 → 0.2.43)

- [ ] **Step 1:** `dev/_chk-octi.ts`: parse every imp-stop fill `<path d="M ... L ...">` (reuse the markerfit pathSegs pattern), for each segment longer than 1px compute the angle's distance to the nearest 45° multiple (port `octOff` inline or import from chainPlace via tsx); report any segment > 1° off with station id + angle; exempt `<rect>` markers (mega). Summary line `N spine segments, M non-octilinear` and `FAIL` when M > 0.
- [ ] **Step 2:** Full battery both saves: seating (0 >2px), markerfit (0 bad; overlaps ≤ 3 NYC / ≤ 1 SEA), overdraw OK, octi gate 0 violations, mega count 0. Crops (READ each): NYC 22 St `dev/_crop-nycdark.ts 960 1420 90 80` (dark+labels render first), St Lukes `830 1495 110 100`, Broadway `_crop-any 1360 840 110 100`, terminus `2380 1430 110 100`; SEA central `1090 985 110 100`, J/D `1058 1034 60 60`, X/Z pill `772 1990 60 60`. Verdict per crop: rows ruler-straight, corners octilinear, bullets all visible.
- [ ] **Step 3:** `npm test`; `npm run build`; version bump both files; commit: `git add dev/_chk-octi.ts manifest.json src/ui/SchematicPanel.tsx` + `git commit -m "feat(stops): rigid-row octilinear markers (v0.2.43) + octi gate"`
- [ ] **Step 4:** Hand to the user for the in-game check. Do not merge.
