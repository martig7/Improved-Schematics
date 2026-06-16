# Heuristic-Improvement Exploration — Ideas Dump

**Date:** 2026-06-16. Companion to [optimizers.md](optimizers.md) (the 46-routine optimizer survey).

This is the consolidated output of a structured exploration into improving the renderer's
greedy heuristics, cutting wasted computation, and removing redundancy. **Every idea found is
recorded here**, including the ones deliberately rejected — so future work doesn't re-propose a
known dead end.

## How this was produced

Two parallel agent workflows, each: diagnose (per lens) → propose concrete fixes → **adversarially
scrutinize each proposal against the code AND the project's tried-and-reverted history**
([loom-octi-pipeline memory]) so dead ends are screened, not re-shipped.

| Batch | Lenses | Findings | Proposals | promising / risky-worthwhile / dead-end / reject |
|---|---|---|---|---|
| 1 | cascade-harm, high-risk | 9 | 27 | 2 / 10 / 13 / 2 |
| 2 | compute-waste, redundancy | 11 | 32 | 11 / 14 / 4 / 3 |

The high dead-end rate in batch 1 is the point: cascade/marker-geometry changes are where this
codebase has repeatedly shipped-then-reverted (per-segment ordering, group-seed, turn-bias,
"more sliding"), and the scrutiny correctly killed proposals re-treading them. Batch 2
(perf/dedup) is mostly unexplored territory, hence the higher promising rate.

## Two cross-cutting themes

1. **Measure before you change.** The scrutiny repeatedly flagged *unmeasured baselines* — the
   single highest-value first move is instrumentation, not code. This is the direct antidote to
   the "optimized the wrong quantity, then reverted" pattern in the history.
2. **Exact-local solvers nested in greedy-global drivers** (see [optimizers.md](optimizers.md)).
   The leverage for *quality* lives in the **source** heuristics (topo merge, octi node
   placement), not the downstream repair passes — boxes/overlaps are usually symptoms of an
   upstream greedy choice that no amount of downstream sliding can fix.

---

# Recommended slate

## Tier 0 — Pure cleanup & perf, byte-identical output (no experiment; verify by SVG byte-diff + gates)

These need no A/B judgement — the render must come out identical, so a byte-diff + the four gates
(`_chk-octi/_chk-seating/_chk-overdraw/_chk-markerfit`) is the whole test.

- **Delete the dead Hanan router cluster** — `hananRouter.ts` + `hananGrid.ts` + their tests
  (~600 lines). Grep-verified zero production importers; superseded by the topo+octi port. *(B2,
  P5 promising)* Then **delete `dijkstra.ts`** — it was the Hanan router's sole consumer; the live
  routers (octi `drawOrder`, `gridGraph.route`, topo `shortestAnyPath`/`bfsLinePath`) each carry
  their own search. *(B2, P3)*
- **Delete `smoothGeographic`** ([simplify.ts:167](../src/render/layout/simplify.ts)) — dead since
  the LOOM octi port replaced relaxation-based smoothing; also dissolves the
  simplifyLayout↔smoothGeographic spring-loop duplication. *(B2, P4 promising)*
- **Small-vs-small collision O(n²) → prefiltered** ([renderOctilinear.ts:986](../src/render/renderOctilinear.ts)):
  precompute each marker's box centre, skip pairs with `|Δcx|>80 || |Δcy|>80` (THRESH=80 is the
  cull the markerfit gate *already* uses and proves safe), and hoist `hullsOf(A)` out of the inner
  loop. Same pairs penetrate → identical output. *(B2, P4 promising)*
- **`node→incidentEdges` index in renderOctilinear** ([:534/:594/:627](../src/render/renderOctilinear.ts) +8 sites):
  replace the O(E) `layout.edges` scans (run per-marker × per-step × per-pair) with one index built
  next to the existing `edgeById` at :127. *(B2, P4 promising)*
- **`edgeById` in topo** ([topo.ts:941](../src/render/layout/topo.ts) `isMergeAnchor` O(N·E),
  [:1379](../src/render/layout/topo.ts) traversal reconstruction O(steps·E)) — the leftover
  un-indexed `edge.find` scans (same pattern already fixed in warp sampling). *(B2, P4 promising)*
- **Within-ordering early-abort in octi `drawOrder`** ([octi.ts:1647](../src/render/layout/octi.ts)):
  return a `CUTOFF` sentinel as soon as an ordering's partial score reaches the incumbent, instead
  of finishing the full draw then erasing it. Provably exact (per-edge costs are non-negative);
  up to ~6× initial-draw savings. *(B2, P4 promising — preferred over the rejected menu-narrowing)*
- **Refactors that also fix latent bugs** *(all B2, P4 promising, byte-identical)*:
  `markBBox`/`boxesClear` extraction — **collapses the `+1`/`+2` clearance-pad drift** between the
  collision copies into one constant; `trimTerminatingLane` helper (kills the verbatim
  mega-slide vs applySlide copy); `excisePolylineFolds(pts,opts)` shared arc-scanner (folds
  `cutPolylineFolds` + `cutSubCellFolds` into one tested routine — but **leave the inline
  chord-replace at octi.ts:1354 alone**, it's a different algorithm); shared `geom.ts` for the four
  byte-identical `ptSeg` helpers; memoize the spine hull / `boxOf` per station.
- **Fix [optimizers.md](optimizers.md)** — its Group-1 items 4 (hananRouter) and 9
  (smoothGeographic) are listed as *live* optimizers but are dead; annotate/remove when the
  deletions land.

## Tier 1 — Cascade-harm quality fixes (measure-gated, env-flagged)

Run in this order; ① gates whether ②/③ even have a target.

- **① Marker-box root-cause classifier** ([rowPlace.ts:186](../src/render/layout/rowPlace.ts),
  `OCTI_PLACE_DEBUG`) — *the load-bearing first step.* Log *why* each rigid-row solve nulls to a
  mega box: **PINCHED** (octi seated lanes < `minGap` — fixable upstream) vs **COINCIDENT**
  (interlined on one drawn edge — unfixable by spacing) vs **no-crossing**. Pure instrumentation,
  zero risk. The critique predicts it may **invalidate the "add placeability term to octi" idea**
  and bound ③. *(B1, P5 promising)*
- **② `OCTI_SNAP` — sub-0.5 weld fraction** ([topo.ts:208](../src/render/layout/topo.ts) `snap`):
  the merge welds samples to the 50/50 *average* of node positions; across rounds this creeps two
  genuinely-separate corridors into one **phantom fused trunk** — the documented root of the
  fuse→box cascade. Make the fraction tunable & sub-0.5 (env-gated, default 0.5 = byte-identical).
  *Real risk:* `snap` is also the convergence engine of `runMergeRounds`, so too-low a fraction can
  silently under-merge real trunks (Lex) — the test must log rounds-to-stop + support-edge count,
  not just the gates. *(B1, P4 risky-but-worthwhile)*
- **③ Non-adjacent dot floor *inside* the chain DP** ([rowPlace.ts:378](../src/render/layout/rowPlace.ts),
  `OCTI_NONADJ_DP`): today a k vs k+2 dot collision is invisible to the Markov DP and only caught
  by a post-hoc check that **nulls the whole station to a box**. Let `runDP` reject just the
  offending (seq,mask). This is the project's *own* documented future fix (commit b0a7dab: "7 St
  needs the non-adjacent floor enforced IN the chain-DP"). *Caveat:* NYC has 0 mega fallbacks today
  — the win is Seattle-only (7 St) and needs the in-game dump; Republican St is a different
  (coincident) class. *(B1, P4 promising)*
- **④ `LBL_REPAIR` — label conflict-repair pass** ([labels.ts:120](../src/render/labels.ts)):
  bounded post-pass that swaps a 100-cost-overlapped label against its neighbour, accept only if the
  joint total strictly drops. labels.ts has **never** been touched in the project history;
  *terminal* stage so zero geometry-gate risk. *Caveat:* yield unmeasured (could be ~0–3 overlaps) —
  build a `_chk-labels` gate and count the baseline first. *(B1, P4 risky-but-worthwhile)*

## Tier 2 — Worth a look (risky-but-worthwhile)

*Cascade/high-risk (B1):* untangle bounded random-restart / 2-edge-swap kick (escapes the
single-edge-move local min); orderLines "best-seen" seed tracker (strictly-better untangle seed);
bow-aware chord term (reuse `geoPenFor`'s bow factor); **coordinated 2-node hub-unwind move** (the
one idea targeting octi's *documented* multi-node-move limitation); post-local-search isotropy nudge
at interlined nodes; label lookahead; warp local-isotropy *diagnostic*.

*Perf/dedup (B2):* RDP consolidation onto one stack-based `rdp` in `geom.ts` (3 copies, disagreeing
epsilons); uniform spatial-hash grid for the collision pairs (O(n²)→~O(n)); `slideCandidates`
iterator shared by the three slide loops (*highest blast radius — most field-bug-prone subsystem*);
`ldegOf` incident-index; arc-returning projection consolidation (high-risk — per-call extras).

## Explicitly DO NOT do (adversarial screen — with reasons)

**Batch 1 dead-ends** (re-tread documented reverts): octi turn-bias (*proven geometrically inert*);
"more sliding" / larger arc window (*arcLimit→96px cleared zero boxes*); `densePen`>0.5
(*switchbacks*); global grouped-seed (*score 7983*); `ndMovePen`=3 geographic tether
(*staircased Flatbush*); anisotropic/aspect grid (*same wall as turn-bias — set by node placement,
not cell shape*); revive `computeCanonicalOffsets` (*abandoned subsystem*); per-weld dHat-shrink
(*re-opens the fragmentation the dHat pinning closed*).

**Batch 2 rejects / dead-ends:**
- **Do NOT delete `ghostNodes.ts`** — though it has zero *current* callers, the **active
  2026-06-14 hub-split-capsule spec** explicitly reserves it ("§10 Out of scope: no modification of
  `ghostNodes.splitHighRouteNodes`; parallel station-aware mechanism"). It's a retained reference
  baseline for in-flight work, not abandoned code. Same reason: keep the `ghostNodeIds` plumbing in
  renderOctilinear (the spec plans to extend that exact invisible-sub-node pattern).
- **`simplifyLayout` convergence early-exit — rejected**: it has no monotone convergence (spring vs
  repulsion forces compete), so a "stop when settled" break assumes a property the routine lacks.
- **buildSupportGraph triple-cleanup dedup — rejected**: the *second* `sanitizeEdgeGeometry` is
  documented load-bearing (degree-2 welds bake new folds through 180° turnarounds — the candy-cane
  fix); not redundant.
- **`OCTI_ORDER_MENU` small-graph narrowing — rejected**: re-treads the deliberate >400-edge
  2-ordering wall-clock cap and leans on cross-cellSize winner tabulation the memory flags as NOISY.
  (The *within-ordering early-abort* in Tier 0 is the safe version.)
- **Hoist `megas.map(boxOf)` — dead**: optimizes the `MEGA_BOXES=true` path, which is an
  intentionally-dormant disabled experiment.

---

# Appendix — all findings (with code locations)

## Batch 1 — cascade-harm + high-risk (9 findings)
1. **Phantom fused trunk from 50/50 weld + greedy longest-first merge** — [topo.ts:204/632/661/751](../src/render/layout/topo.ts). Decides the topology octi/markers inherit; root of fuse→box cascades (candy-cane, Tacoma tip, NYC midtown). → ② OCTI_SNAP.
2. **Greedy irrevocable octi insertion order bakes early hub violations** the single-node local search can't repair; worst on NYC where only 2 of 6 orderings run — [octi.ts:1139/1644](../src/render/layout/octi.ts). → Tier-2 hub-unwind move; more orderings.
3. **octi node placement is blind to marker placeability** → seats interlined bundles < minGap → rowPlace null → mega box → collision cascade — [octi.ts:769](../src/render/layout/octi.ts) → [rowPlace.ts:184](../src/render/layout/rowPlace.ts) → [renderOctilinear.ts:757](../src/render/renderOctilinear.ts). → ① classifier (then maybe placeability term — but classifier may invalidate).
4. **Rigid-row degrades to greedy for g>5; non-adjacent floors only post-hoc** → whole-station box — [rowPlace.ts:95/264/378](../src/render/layout/rowPlace.ts). → ③ non-adjacent DP floor.
5. **placeLabels greedy longest-first, no backtracking** → early long labels wedge later ones into 100-cost overlaps — [labels.ts:118](../src/render/labels.ts). → ④ LBL_REPAIR.
6. **untangle hill-climb single-edge moves can't reach grouped/2-swap states** — [untangle.ts](../src/render/layout/untangle.ts). → Tier-2 random-restart kick.
7. **orderLines barycenter stops at ≤6 passes / can oscillate, not min-crossing** — [lineOrder.ts](../src/render/layout/lineOrder.ts). → Tier-2 best-seen seed.
8. **Collision slides commit per-pair greedily, order-dependent, can push toward a third** — [renderOctilinear.ts](../src/render/renderOctilinear.ts). (Mostly dead-end territory — slides can't clear crossing/coincident residuals.)
9. **High-risk clusters:** topo-merge+octi-guards (cascade radius = whole map; separateFusedStations clamp subtleties) and the marker/collision subsystem (finickiest, most reverts). Leverage concentrates upstream.

## Batch 2 — compute-waste + redundancy (11 findings)
1. Small-vs-small collision O(n²), no prefilter, rebuilds hulls — [renderOctilinear.ts:986](../src/render/renderOctilinear.ts). *(Tier 0)*
2. Incident-edge O(E) scans (lanePolysAt/ldegOf/lanePointAt) — [renderOctilinear.ts:534](../src/render/renderOctilinear.ts). *(Tier 0)*
3. Octi runs all 6 (or 2) insertion orderings as full re-draws; B&B never skips an ordering — [octi.ts:1647](../src/render/layout/octi.ts). *(Tier 0 early-abort)*
4. Dead Hanan router + hananGrid + smoothGeographic (~600 lines, zero callers) — *(Tier 0 delete)*.
5. Three balloon-fold excisers, 5 invocations, 3 impls — [topo.ts:477/384](../src/render/layout/topo.ts), [octi.ts:371](../src/render/layout/octi.ts). *(Tier 0 consolidate)*
6. Collision-slide machinery duplicated 4–6×, pad fudge drifting (+1/+2) — [renderOctilinear.ts](../src/render/renderOctilinear.ts). *(Tier 0 extract)*
7. `boxOf`/mega-set recomputed per pair/step + latent O(E) `ldegOf` — [renderOctilinear.ts:603](../src/render/renderOctilinear.ts). *(Tier 0 memoize; megas-hoist itself is dead — dormant path)*
8. `simplifyLayout` fixed 80 O(N²) iters, no early-exit — [simplify.ts:67](../src/render/layout/simplify.ts). **(early-exit rejected — no monotone convergence; spatial-hash repulsion is Tier-2-risky)**
9. `ptSeg`/RDP reimplemented ~8×/~4×, disagreeing epsilons — capsuleSlide/renderGeographic/octi/topo/chainPlace. *(Tier 0 named helpers; arc-returning copies Tier 2)*
10. Un-indexed `edge.find` in topo merge/traversal — [topo.ts:941/1379](../src/render/layout/topo.ts). *(Tier 0)*
11. Dead `ghostNodes.ts` (334 lines) — **DO NOT delete (reserved by active hub-split spec).**

[loom-octi-pipeline memory]: ../../  "project memory: tried-and-reverted history (loom-octi-pipeline.md)"
