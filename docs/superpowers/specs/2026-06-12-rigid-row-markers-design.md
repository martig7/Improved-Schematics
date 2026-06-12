# Rigid-Row Station Markers — Design (v2, supersedes the per-dot chain DP)

**Date:** 2026-06-12 (round 3)
**Status:** User-approved direction; supersedes §2.2–§2.3 and §4 of `2026-06-12-dots-on-lanes-chain-dp-design.md`. Retained from v1: §2.1 lane curves, §5 spine rendering substrate, §6 sequential inter-station masking, §8 verification machinery. The per-dot solver (`solveChain` and its energy) is REMOVED — superseded below, preserved in git history and in the v1 document as the paper's intermediate result.

## 1. Motivation

The per-dot model guaranteed on-lane dots and exact solvability but made *shape* an emergent property: straightness and octilinearity held only where the energy favored them, and field renders showed organic, wobbly marker polygons. Patching shape into the per-dot energy (P5 pairwise angle clauses, repair vetoes, degradation ladders) fought the parameterization. The user's reformulation moves the enforcement into the configuration space itself.

## 2. Model

### 2.1 Rows

The unit of optimization is the **bundle row**, not the dot. For a station with bundles (corridor groups, derived exactly as today by shared-incident-edge union-find) $b = 1 \dots g$:

- A row is a **straight line**; every dot of the bundle lies at the intersection of the row line with its own lane curve. Collinearity and on-lane-ness are properties of the parameterization — unrepresentable to violate.
- State per bundle: $(s_b, \theta_b)$.
  - $s_b$ = slide along the corridor (0.5 px grid over ±`CHAIN_ARC_LIMIT` = 24 px; one ×2 window escalation rung). The row anchor is `curvePoint(carrier, anchorT + s)` on the bundle's carrier curve (the first mark's lane curve).
  - $\theta_b$ ∈ the four octilinear axes (mod 180°) — **absolute octilinear snap** (user decision). Rest pose = the octilinear direction nearest the bundle perpendicular; `rot(θ)` = number of 45° steps from rest.
- State feasibility: the row line crosses **every** lane of the bundle within the window; dots ordered along the row consistently with lane order; consecutive dot gaps ≥ `2r − 0.05`; no dot within `2r − 0.05` of an already-placed station's dot (§6 mask — never dropped in this model).

### 2.2 Pairings and corners

- The station's combinatorial knob: a **pairing chain** over rows (sequence + per-row orientation), enumerated exhaustively as today ($g! \cdot 2^g$, $g \le 4$ observed).
- For adjacent rows in the chain, the **corner** $P$ = intersection of the two row lines (derived, not searched). Pair feasibility:
  - **V-not-T:** $P$ lies at or beyond the facing end of BOTH rows (extension only, never poking into a row's side).
  - Extension per row ≤ `EXT_CAP` = 6 lane-spacings (markers stay local).
  - Parallel rows (same snapped axis): feasible only if collinear within sub-pixel lateral offset — they join end-to-end; otherwise the pairing is infeasible.
  - $P$ clear of every dot of both rows by ≥ `2r − 0.05`.
- Station-level (post-solve) checks: all-pairs dot floors across non-adjacent rows; corner-vs-corner and corner-vs-dot separation ≥ `2r − 0.05` (user constraint 3 plus the corner-vs-dot extension). Any violation ⇒ fallback (§3).

### 2.3 Objective

$$\min\; \sum_{\text{pairs}} \big(\text{ext}_a + \text{ext}_b\big) \;+\; W_S \sum_b |s_b| \;+\; W_{ROT} \sum_b \text{rot}(\theta_b)$$

with `W_S = 0.05` (px per px — weak anchoring, as v1) and `W_ROT = 20` (px per 45° step — rotation is a last resort before infeasibility). Linear px units throughout. All constants named tunables.

### 2.4 Solver

Outer loop over pairings; inner **exact chain DP over bundles** with $(s, \theta)$ states (≤ 97×4 = 388 per bundle; feasibility prunes most). Unary = slide + rotation costs + per-state row feasibility; transition = pair feasibility + extension cost. Deterministic; per-station global optimum for the discretization, per pairing; the best pairing wins. Bundle-level DP replaces the per-dot DP — same algorithmic skeleton, one level up, strictly smaller state space.

## 3. Fallback: the mega box (user decision)

If **no pairing** yields a feasible configuration — after the ×2 window escalation — or a station-level post-check fails, the station renders as a **mega box**: the existing rounded-rect marker (dormant `MEGA_BOXES` branch in `stops.ts`) covering all the station's marks with its standard padding, dots at their gathered anchor positions. No soft-degradation rungs, no unmasked re-solves, no per-dot fallback: a station either satisfies the full shape grammar or is boxed. The trigger is per-station (solver infeasibility), independent of the dormant global `MEGA_BOXES` flag, carried as a `mega` flag on the station's marks. Fallback count is logged per render and expected ≈ 0 on both test saves.

## 4. Properties (paper-facing, v2)

- **R1 (Shape by construction).** Every rendered marker is an octilinear polygon: rows are straight octilinear segments (state space), corners are intersections of octilinear lines (derived), elbows extend rows along their own axes. No tolerance arguments; the only non-octilinear marker is the axis-aligned mega box.
- **R2 (Dots on lines, exactly).** Dots are intersections of the row line with lane curves — on-lane by construction, as v1.
- **R3 (Exact solvability).** Pairing-conditioned chain DP over rigid-row states is exact on the discretized state space; pairings are enumerated exhaustively. Strictly cheaper than the v1 per-dot DP.
- **R4 (No silent degradation).** The feasible set is enforced fully (floors, §6 mask, V-not-T, corner separation). The only fallback is total and explicit (mega box), never partial.

## 5. Rendering

Unchanged substrate: the marker is the stroked spine path through chain-ordered dots (border `2r+6`, fill `2r+3`, round caps/joins, RDP 0.75). Rows contribute their dots (exactly collinear); each pair contributes its corner as a synthetic vertex between the facing end-dots — carried as `cornerAfter?: Pixel` on the boundary `StopMark`. Mega-flagged stations render the existing rounded-rect branch. The octilinearity gate (`dev/_chk-octi.ts`, new): every spine segment within 1° of a 45° multiple (mega rects exempt); expected 0 violations on both saves.

## 6. What is deleted

`solveChain` and its per-dot energy, the degradation ladder, `hardBlocked`, the §4 repair loop in `renderOctilinear.ts`, and their tests (P1/P2/P5 per-dot property tests) — superseded by R1–R4 and the rigid-row tests. Retained: lane-curve geometry (`buildLaneCurve`, `curvePoint`, `curveTangent`, `octOff`, `rdpSimplify`), grouping, gates, spine renderer, §6 mask concept (now a state-feasibility clause).

## 7. Verification

Unit tests (rigid-row): perpendicular rest on parallel lanes (zero slide/rotation, dots at lane crossings); rotation engages only when rest is infeasible; V-not-T rejects T configurations; parallel-collinear join; corner separation; mega signal when nothing fits; determinism. Render gates on both saves: seating (0 >2px), markerfit (0 bad, overlaps ≤ baseline), overdraw, NEW octilinearity gate (0 violations), mega-fallback count (report; expect 0). Crops at the named stations incl. the four from the user's field report (59 St / 22 St / Thames St / 3 St equivalents on the repo dumps). Ship as v0.2.43 after user in-game check.
