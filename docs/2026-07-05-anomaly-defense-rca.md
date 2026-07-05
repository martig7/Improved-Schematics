# The Pipeline Fights Itself: Root-Cause Synthesis

**Branch:** `simplification-investigation` · **Schema:** 25 · **Scope of inventory:** 6 areas, ~110 mechanisms

---

## 1. The problem, stated plainly

Every defense in the inventory patches one of **two upstream information-destruction events**, plus a third that is **already solved**. They are not one problem — averaging them would mislead you — so here they are separated, in blame order.

### Cause A — `buildSupportGraph` reconstructs line routes it should have *transformed* (the "representation gap")

The topo merge (`collapseSharedSegments`, `addOrUnionEdge`, topo.ts ~700–743) consumes each input edge as **sampled geometry** and unions a line-id *set* onto whatever support edge the samples snap nearest to. It carries `e.lineIds` (a `Set`) but **throws away the ordered, connected path** of each line. So after the merge, "line L's route through the support graph" no longer exists as data — it is **re-derived by nearest-neighbor position-snapping** (`mapToSupportForLine` → `pathForLineSegment`, topo.ts 1550–1638), and every way that guess fails has its own heal:

- `bfsLinePath` → `directStep` → `shortestAnyPath` (which **mutates `edge.lineIds`**, painting the line on post-hoc, line 1525) → `__heal` straight bridge (1532)
- The comments are self-indictments: *"the walk can miss unioning a line onto corridors its geometry rides,"* *"the merge under-painted the line's corridors,"* *"the merge fragmented this part of the network into disconnected pieces (its stitching is heuristic)."*

The **identical pattern recurs one stage later**: octi routes each edge independently against an occupancy grid, discarding which lines coincide; `mergeCoincidentPaths` (imageMerge.ts 73) then **re-discovers coincidence from pixels** (`splitAtLattice` + owner-set runs). imageMerge is a full graph rebuild (`mn*`/`me*` renumber) *precisely because* octi threw away a fact topo already knew.

### Cause B — the ordering inversion: contract, then re-split, recreating the exact degeneracy contraction removed

`buildSupportGraph` runs `contractShortEdges` (topo.ts 1436, enforcing "no support edge shorter than dHat") + `contractDegree2` + `intersectionSmoothing`, **then** calls `anchorGraphStops` (1453), which **re-splits corridors at stop positions AFTER contraction and smoothing**. Because it runs post-freeze, a fresh node can land 11px from an existing one — **inside one octi cell**. The router then pays a 170px C-detour for an 11px edge, drawn as a closed loop (the SEA Stevens Way case). `weldSubCellNodes` (topo.ts 1270, *new 2026-07-05*) re-establishes the invariant `contractShortEdges` had just guaranteed. **The pipeline enforces "≥ dHat," breaks it a few lines later, and re-enforces it across three call sites.**

Both lenses independently converge here. The pipeline lens calls A "a textbook representation gap" and B "the clearest single example of the pipeline fighting itself." The cost-model lens confirms B is **geometrically infeasible, not a weights problem**: at `cellSize ≈ 23px`, an 11px edge (0.48 cell) whose endpoints must occupy distinct cells *cannot be routed cleanly by any penalty table*.

### Cause C — the line-ordering scorer over-fought crossings (already fixed structurally)

The old `untangle.ts` (now in `old/`) was a free-permutation crossing-minimization hill-climber. It over-fought crossings so hard it manufactured its own artifacts (straight-lock cliffed the search landscape; `tryY` braided seams, forcing `stack-seam scoring` to exist *solely* to re-fight that self-inflicted braid — a defense patching a defense). **`bundle-blocks` (shipped `d31b907`) already fixes this** by making in-bundle open-track reorders *unrepresentable*. This is the owner's hunch confirmed — and retired.

> **Where the lenses disagree — stated, not averaged:** The **cost-model lens adds a fourth live pressure the pipeline lens misses**: it claims the inventory's "`geoW`/`lenPresW` default OFF" is *wrong for production* — `renderGeographic.ts:1007–1010` sets `geographicAffinity = 0.05` and `:1052` sets `lenPresW = 1.5`, so `geoPenFor` (quadratic bow*bow, capped 8×) and length-preservation are **both live**, adding a second "stay near true course" tension on top of crossing/bend pressure. **This is worth verifying before any rewrite** (see Experiment 0) because it changes which detours are the router avoiding SOFT_INF vs. the router being pulled by geo-affinity — two different fixes.

---

## 2. The earliest fixes — ranked shortlist where the lenses agree

Ranked by **leverage ÷ risk**. Both architects independently rank the same #1.

### Fix 1 — Protect stop nodes THROUGH contraction instead of re-splitting AFTER it

**What changes.** Add stop positions to the `isMergeAnchor` protected set (topo.ts ~770) so `contractDegree2WithMatchingLines` and `contractShortEdges` skip them, and **delete `anchorGraphStops`' post-freeze re-splitting** (topo.ts 1453). Stops survive the merge as first-class nodes instead of being contracted away and cut back in.

**Invariant that then holds.** *Every support edge is ≥ dHat AND every stop already has its own node before octi* — because the only source of sub-cell nodes was the after-the-fact re-split.

**Dead code this obsoletes (named from the inventory):**
- `weldSubCellNodes` + its call site (topo.ts 1270, renderGeographic.ts 1053) → no-op
- `weldSubCellNodes` degenerate-weld-edge drop + station-pair guard (topo.ts 1310, 1380)
- octi drawn-level **detour-chord excision** (octi.ts 1388, Republican St) and **detour-loop excision** (octi.ts 1423) lose their input
- `weldRedundantStubs` (topo.ts 1126) and `absorbJunctionStubs` (topo.ts 1202) lose the anchor-created terminus-retrace stubs
- draw-side: **dogleg B2 corridor-overshoot clamp** (renderOctilinear.ts 834, SEA route X) and `drawnEndAt` sub-cell cases

**Scope in this codebase.** *Medium, ~1–2 focused days.* `isMergeAnchor`/`markProtected` already exist and are already honored by `snap`/`contractDegree2`/`contractShortEdges` for junctions — the mechanical change is small. The real work is auditing that `intersectionSmoothing` doesn't drift a protected stop, and (risk mitigation) protecting **only** stops whose nearest survivor is *not themselves*, so the skeleton stays lean where stops already coincide with junctions.

**Falsifying experiment BEFORE committing:**
```
# Expose raw geometry by disabling the weld, then measure sub-cell edges at the octi boundary.
OCTI_WELD=0 OCTI_LOOPS=1 npx tsx dev/render-full.ts <SEA-split dump>
```
Baseline the count of drawn closed loops (`OCTI_LOOPS`) and the fire-count of octi.ts:1388/1423 excisions. **Prototype the anchor protection behind a flag; re-run.** Win = sub-cell edge count at the octi boundary → 0 *without the weld*, drawn-loop count drops, and `auditTraversals` (OCTI_AUDIT=1) shows **no station-drop regression**. If detour-excision fire-count doesn't fall, the hypothesis is wrong — abort before the rewrite.

---

### Fix 2 — Carry each line's path through the merge as a transformed edge-sequence

**What changes.** Give `collapseSharedSegments`/`addOrUnionEdge` a per-line map (`old edge id + direction → ordered list of support edges its samples unioned onto`), accumulated *as the walk runs*. `buildSupportGraph` then builds `lineTraversals` by **remapping `g.lineTraversals` through that table** — never by snapping original node ids to nearest support nodes and re-pathing. Contraction passes compose map entries when they weld edges.

**Invariant that then holds.** *Line traversals are never reconstructed, only transformed* — a line is connected in the support graph **iff** it was connected in the input graph, by construction, zero position-snapping.

**Dead code this obsoletes:** the entire traversal-reconstruction escalation ladder — `bfsLinePath` (847), `directStep` (886), `shortestAnyPath` self-heal **incl. its `edge.lineIds` mutation** (905/1525), `__heal` bridge (1532), `mapToSupportForLine` (1550), stall-recovery bridge-over-one/jump-with-discontinuity (1626), and `mapToSupport`'s line-path fallback ladder.

**Scope.** *High, ~1–2 weeks.* This is the deepest change — it touches the merge inner loop, and every edge-rewriting pass (`contractDegree2`, `contractShortEdges`, the sub-cell weld) must carry the mapping forward. **Do this AFTER Fix 1** — fewer post-hoc node insertions means far fewer map-composition edge cases. Ship with `shortestAnyPath` retained as a **diagnostic-only assertion under `OCTI_AUDIT`** that fires if the transform ever yields a disconnected path (the exact failure the heal ladder currently absorbs).

**Falsifying experiment:**
```
OCTI_AUDIT=1 npx tsx dev/render-full.ts <all city dumps>
```
Instrument `shortestAnyPath`/`__heal` to log every time they fire on current `master`. That fire-count is your budget: if the merge already keeps lines connected in ~all cases, the heal ladder is cheap insurance and Fix 2's payoff is small; if it fires often (CPW / Franklin-class), the transform has high leverage. **Measure the fire-count first** — it directly sizes the prize.

---

### Fix 3 — Octi emits its line-coincidence; imageMerge consumes it instead of re-inferring from pixels

**What changes.** octi already knows, per grid edge, which support edges routed onto it (that's how it counts overlap "violations"). Emit that occupancy map (`grid-segment → owner support-edge set`) as structured output, and have `mergeCoincidentPaths` read it directly — instead of `splitAtLattice` lattice-splitting drawn polylines and grouping by inferred owner-set.

**Invariant that then holds.** *Coincident runs are known, not detected* — no two lines can be drawn on identical pixels with zero offset because the owner set is authoritative.

**Dead code this obsoletes:** `splitAtLattice` (imageMerge.ts 41) and the vertex-phase realignment it exists for; pass-1 duplicate-vertex collapse (96), pass-4 collinear-run dedup (219), pass-5 step dedup (257) — *all cleaning up `splitAtLattice`'s own subdivision byproducts*. Does **not** obsolete `separateFusedStations` (different cause: octi contraction fusing distinct stations).

**Scope.** *Medium-High, ~1 week.* Requires threading gridGraph occupancy through octi `finish()`/`expandImage` so the owner set survives `contractSplits`. **Lower leverage than #1/#2** — imageMerge is downstream of the drawn image, so a fold that survived octi is faithfully reproduced here regardless. This cleans the coincidence-rediscovery machinery, **not the fold family**.

**Falsifying experiment:**
```
OCTI_AUDIT=1 npx tsx dev/render-full.ts <all city dumps>   # bracket pixel-inferred vs occupancy-declared runs
```
Behind a flag, log imageMerge's coincident-run count (pixel-inferred) vs. octi's occupancy-declared run count. Win = they agree on every test city **and** imageMerge becomes provably near-idempotent (run-count → ~0 when octi hands over the truth).

> **Rejected as #1 by both lenses — the SOFT_INF / crossing-price knobs.** The cost-model lens proposes *widening the legal-crossing regime* (price settled/diagonal crossings currently forced to SOFT_INF) and *hard-merging shared corridors before routing*. These are real, but **secondary**: they attack the router's avoidance of SOFT_INF, which only turns pathological when handed degenerate input (Fix 1's territory). Do them **after** Fix 1, and only if the SEA/NYC-midtown sweep (Experiment 3 below) shows excision fire-count still high once sub-cell inputs are gone.

---

## 3. Verdict on the hunch: *are crossings over-fought?*

**Partially yes — but the mechanism is mislocated, and the ordering half you suspected is already fixed. Separate the two halves.**

### The cost arithmetic (from `DEFAULT_PENALTIES`, gridGraph.ts:45; `bendCosts = [1, 3, 2.5, 2]`, A=1)

| Move | Cost | Notes |
|---|---:|---|
| Straight axis hop | `0` | `verticalPen`/`horizontalPen` |
| Diagonal hop | `0.5` | `diagonalPen` |
| **Legal overlap crossing** | **`~4`** | `crossingPen (4)` + raw, gridGraph.ts:311 |
| Minimal side-step notch (2 bends) | `~4–5+` | 2×45° = 4, or 2×90° = 5, + extra hops |
| Multi-cell C-detour (~7 cells, Stevens Way) | `~5–8` | 7×0.5 + 2 turns |
| **Topology violation (SOFT_INF)** | **`~200,000`** | 100 000 + raw, **doubled** in `score()` octi.ts:806 |

The ordering the router sees: **crossing (4) < notch (~4–5) < C-detour (~7) ≪ SOFT_INF (1e5)**. **A legal crossing is already the single cheapest option — 25 000× below SOFT_INF.** So the over-fighting is **narrowness, not magnitude**: `crossClose` (gridGraph.ts:319/351) grants the finite `F_CROSS` price *only* for a **straight pass-through of an unsettled, non-station node**. The instant the crossing wants to happen at a **settled node, a station/junction, a turn, or the conjugate diagonal** (`F_BLOCKED`, gridGraph.ts:436, a *hard* block), the finite escape hatch vanishes and the router faces SOFT_INF → it rationally takes the multi-cell C-detour. **The detours the excisions fight are the argmin under a regime where legal crossings are unavailable exactly where congestion forces the choice.**

The codebase has **already conceded this twice**: `crossingPen` is a non-LOOM addition (gridGraph.ts:35–41) precisely because pure soft-closing forced staircase detours; `densityPen` was lowered **10 → 0.5** (gridGraph.ts:54–60) because the high value *"makes the router add switchback zigzags (or worse, giant detours) purely to lengthen the path."*

**Lowering `crossingPen` alone would do almost nothing — it is already the winner where it applies. The lever is WHERE it applies, not its magnitude.** And the C-detour class you see most (Stevens Way, 170px) is **not a weights problem at all** — it is 11px geometry infeasible at 23px resolution, fixable only by Fix 1, never by any penalty.

**Bottom line:** the *ordering* half of "over-fighting crossings" is exactly true and **already shipped as `bundle-blocks`**. The *geometry* half (the larger, still-active defense pile) is an **information-flow problem** (Causes A + B), not a crossing-price problem. Your instinct pointed at the right stage; the fix is upstream of the router, not in its weights.

---

## 4. Appendix — Complete mechanism inventory

### topo (`src/render/layout/topo.ts`)

| Mechanism | Line | Stage | Artifact | Cause |
|---|---|---|---|---|
| creepBlocked | 85 | merge-round collapse gate | interlace/fold/detour | merge snaps obtuse-angle samples → corridors interlace |
| lateralToTravel | 612 | merge-round collapse gate | fold/spur/detour | nearest-node search returns collinear node → retrace |
| ndCollapseCand snap/create | 631 | merge-round collapse | coincident/sliver/short-edge | reuse-vs-create decision on near-coincident nodes |
| addOrUnionEdge parallel-fold | 227 | merge edge construction | coincident/short-edge | duplicate/self-loop edges from re-visited node pairs |
| contractDegree2WithMatchingLines | 269 | merge contraction | short-edge/stub/sliver | welds chains through 180° turns, baking folds into one polyline |
| contractShortEdges | 331 | post-merge cleanup | short-edge/sliver/loop/stub | micro-mesh at junctions octi inflates to full cells |
| contractShortEdges terminal-stub guard | 340 | post-merge cleanup | stub/break/gap | protects real terminus from deletion |
| cutPolylineFolds | 486 | sanitizeEdgeGeometry | fold/loop/retrace/overshoot | balloon fold baked inside edge by degree-2 contraction |
| sanitizeEdgeGeometry | 393 | buildSupportGraph (×2) | fold/loop/overshoot | fold inflates polyline length, shields from short-edge cleanup |
| intersectionSmoothing | 403 | buildSupportGraph | spike/spur/short-edge | inconsistent junction endpoint angles from merge |
| inputFromBuilder RDP re-feed | 591 | merge-round re-feed (≥2) | coincident/fold/detour | bowed corridors become identical chords, false weld |
| runMergeRounds anchor protection | 770 | merge-round setup | fold/detour/coincident | 50/50 averaging drift compounds per round |
| runMergeRounds convergence stop | 779 | merge outer loop | fold/fragment/detour | extra rounds re-fragment (edge count rises) |
| snap protected-node anchor | 215 | merge-round averaging | detour/fold/coincident | 50/50 average drifts junction/terminus off true pos |
| **anchorGraphStops** | **996** | **buildSupportGraph post-freeze** | **gap/break/stub** | **re-splits AFTER contraction → sub-cell nodes (Cause B)** |
| anchorGraphStops force-place far anchor | 1040 | post-freeze | gap/break | no corridor within snapRadius carries the line |
| weldRedundantStubs | 1126 | post-anchor | stub/retrace/spur | terminus-retrace overlap read as crossing by planarize |
| absorbJunctionStubs | 1202 | post-weld | stub/spur/loop/short-edge | bundle wider than stub, lines hook 90° in/out |
| absorbJunctionStubs terminus guard | 1228 | post-weld | stub/break/gap | line ending in stub = real terminus, keep it |
| **weldSubCellNodes** | **1270** | **buildSupportGraph→octi seam** | **short-edge/detour/loop** | **patches anchorGraphStops sub-cell edges (Cause B repair)** |
| weldSubCellNodes station-pair guard | 1310 | seam | coincident | two real stations never weld |
| weldSubCellNodes degenerate-drop | 1380 | seam | short-edge/coincident/break | zero-span weld edges deleted, traversal repaired |
| bfsLinePath | 847 | traversal reconstruction | gap/break/detour | merge remap: line traversal no longer maps to one edge |
| directStep fallback | 886 | traversal reconstruction | gap/detour | single-hop fast path when BFS unnecessary |
| **shortestAnyPath self-heal** | **905** | **traversal reconstruction** | **gap/break/detour** | **merge under-painted corridors; MUTATES lineIds (Cause A)** |
| __heal bridge edge | 1532 | traversal last-resort | gap/break | merge fragmented network into disconnected pieces |
| mapToSupportForLine | 1550 | traversal node mapping | gap/break/detour | nearest snap lands on parallel corridor line never touches |
| traversal service-break sentinels | 1572 | traversal reconstruction | retrace/detour/loop | pathing across a break resurrects suppressed deadhead |
| traversal stall-recovery | 1626 | traversal step assembly | gap/break/detour | single mis-mapped node breaks a segment |
| appendTraversalSteps dedup | 1495 | traversal reconstruction | retrace/coincident | BFS segments repeat boundary edge at joins |
| stop re-home to line-serving node | 1765 | stop-flag placement | gap/break | group node on a segment this line never reaches |
| station-group node selection | 1695 | station marker placement | coincident/gap/break | most-served-wins stole group from terminus stub |
| station-group stale-adj skip | 1701 | station marker placement | break | adj holds edge id no longer in edges |
| mapToSupport fallback ladder | 1481 | node mapping | gap/break | no exact-coincident support node after merge |
| nearestSupportNode brute-force | 949 | node mapping support | gap/break | NodeIndex 3×3 hood misses far nearest |
| onePass deprecated alias | 762 | test compat shim | stub | (no geometric role) |

### octi (`src/render/layout/octi.ts` + `gridGraph.ts`)

| Mechanism | Line | Stage | Artifact | Cause |
|---|---|---|---|---|
| contractShortEdges | 108 | octi pre-processing | short-edge/gap/sliver/stub | topo/warp leave interchanges a few px apart |
| contractShortEdges terminal-stub guard | 139 | pre-processing | stub/break/gap | protects a downstream imageMerge flaw (drops empty chains) |
| contractShortEdges self-loop drop | 133 | pre-processing | loop/coincident | repointing makes from===to |
| planarize | 212 | pre-processing | detour/spike/loop | upstream topo didn't insert crossing nodes; else SOFT_INF detour |
| planarize duplicate-cut suppression | 291 | pre-processing | coincident/sliver | multi-pair hits at same spot → zero-length sub-edges |
| cutSubCellFolds | 372 | pre-processing (on combineDeg2 out) | fold/retrace/hairpin | combineDeg2 welds chain through sub-cell backtrack |
| subdivideForFolds | 406 | post-routing helper | fold/retrace | vertex-only cutter blind to interior returns |
| **cutDrawnFolds** | **428** | **finish() on routed paths** | **fold/retrace/overshoot** | **ROUTER stitched a folded path (SEA 44 St east-4/back-2/south)** |
| combineDeg2 | 439 | pre-processing | detour/spike/short-edge | design collapse; ALSO manufactures sub-cell folds + phantom length |
| combineDeg2 line-set boundary guard | 483 | pre-processing | detour/fold/gap | collapsing hides a service junction in one comb edge |
| combineDeg2 multigraph guard | 491 | pre-processing | coincident/loop | merge would duplicate an edge |
| EdgeOrdering cell-scale tangent | 649 | context build | detour/spike | noise-scale tangent mirrors circular order |
| atan2 quantization | 666 | context build | detour/break | 1-ULP flip reroutes whole layout (primary divergence) |
| geoPenFor bow-scaled | 743 | routing penalty | detour/overshoot/spur | router shortcuts a bowed corridor (**live at 0.05 in prod**) |
| Drawing spring/density cost | 870 | routing score | short-edge/fold/retrace | collapsed chain squeezed onto fewer hops |
| Drawing length-preservation (lenPresW) | 886 | routing score | overshoot/gap | drawn chord undershoots warped geo chord (**live at 1.5 in prod**) |
| eraseEdge bend recompute | 912 | local search | spike/fold | stale bend costs after rip-up |
| topoBlockPen | 1026 | writeNdCosts | detour/fold/spike | preserve circular edge order (core crossing-avoidance) |
| spacingPen | 1042 | writeNdCosts | coincident/detour | reserve free ports between settled edges |
| nodeBendPen | 1066 | writeNdCosts | spike/hairpin/fold | line continuing straight through a station |
| getCands degree-8 clamp | 1113 | candidate selection | break/gap/detour | comb node deg 9+ can never place |
| getRtPair radius escalation | 1137 | candidate selection | break/gap/no-path | zero free candidates at initial maxGrDist |
| drawOrder self-loop skip | 1175 | edge-insertion | loop/coincident | degenerate self-loop |
| ndMovePen displacement | 1203 | edge routing | overshoot/detour | unsettled endpoint pays for straying |
| drawOrder NO_PATH cleanup | 1235 | edge-insertion | gap/break | A* fails under cutoff |
| stall-retry shrink loop | 1419 | main driver | break/gap/detour | cell too coarse for congested region |
| raw-geographic snap fallback | 1432 | retry exhaustion | break/gap | still can't route after retries |
| **drawn-level detour-chord excision** | **1388** | **finish()** | **detour/loop/balloon** | **sub-cell node pairs detour multi-hop (Republican St; Cause B)** |
| **drawn-level detour-loop excision** | **1423** | **main return** | **loop/detour/balloon** | **router prefers multi-cell loop over SOFT_INF violation** |
| pinStationTermini | 1452 | finish() final | gap/overshoot/stub | grid-quantized terminus lands in water |
| expandContraction | 1476 | finish() | gap/break | undo contractShortEdges |
| contractSplits rejoin | 1495 | finish() | coincident/gap/break | undo planarize; makes detour VISIBLE |
| projectChainArcs | 1562 | expandImage | coincident/sliver/gap | blind redistribution parks stations in water |
| expandImage safety net | 1650 | expandImage | gap/break | anything unplaced falls to straight segments |
| tryDraw multi-ordering best-keep | 1684 | initial drawing | detour/spike/fold | insertion order walls off a corridor early |
| local-search node re-placement | 1737 | local search | detour/spike/fold | early paths forced through now-gone violations |
| local-search longest-chain-first | 1750 | per-node re-route | detour/spike | short stubs wall off port wedge (W-line bug) |
| edge re-route sweep | 1845 | local search | detour/fold/overshoot | edge rides violations that vanished |
| deterministic tie-breaks | 73 | throughout | break/detour | ICU/hypot divergence offline vs in-game |
| crossClose / F_CROSS | gridGraph 319 | settle mechanics | detour/spike | pure soft-close forces staircase detours (non-LOOM) |
| diagonal crossing block (F_BLOCKED) | gridGraph 436 | settleEdg | coincident/spike/loop | two diagonals through one cell visually cross |
| SOFT_INF soft-close | gridGraph 66 | edgeCost | detour/loop/fold | violation must be feasible-but-counted (central lever) |
| closeTurns soft-close on settle | gridGraph 341 | settleEdg | spike/fold/coincident | path turning inside occupied node tangles |
| densityPen lowered 10→0.5 | gridGraph 53 | penalty defaults | spike/detour/switchback | LOOM's 10 forces switchback zigzags |
| getGrNdDeg free-degree filter | gridGraph 520 | candidate generation | detour/break | base without free ports forces violations |
| off-grid closure | gridGraph 270 | writeInitialCosts | break/overshoot | ports off boundary must be unusable |
| A* stale-entry/cutoff pruning | gridGraph 677 | route | detour/overshoot | lazy-heap staleness + over-cutoff detours |
| admissible heuristic | gridGraph 576 | route | detour | non-admissible → non-shortest paths |
| unSettleEdg conditional reopen | gridGraph 448 | unsettling | coincident/spike | reopening while another path resides corrupts state |

### imageMerge (`src/render/layout/imageMerge.ts`)

| Mechanism | Line | Stage | Artifact | Cause |
|---|---|---|---|---|
| **mergeCoincidentPaths (raison d'être)** | **73** | **post-octi consolidation** | **coincident/invisible-overlap** | **octi relaxation lets 2 edges share grid segments (Cause A, one stage later)** |
| splitAtLattice | 41 | pass-1 pre-processing | coincident/phantom-misalignment | octi expandImage interpolates slice points at differing phases |
| pass-1 duplicate-vertex collapse | 96 | pass-1 inventory | coincident/zero-length | splitAtLattice + quantization emit identical consecutive verts |
| pass-2 node-vertex boundary split | 148 | pass-2 runs | missing-station-node/gap | coalescing would swallow node-hosting vertices |
| pass-2 already-owned closure | 144 | pass-2 runs | duplicate-geometry/coincident | later edge re-encounters an owned segment |
| pass-2 owner-change break | 151 | pass-2 runs | coincident/break/detour | run left open across owner-set discontinuity |
| pass-4 collinear-run dedup | 219 | pass-4 chains | retrace/duplicate | old edge crosses multiple same-run segments |
| pass-5 traversal-step dedup | 257 | pass-5 remap | retrace/duplicate/stub | back-to-back identical (edge,reversed) steps |
| pass-5 empty-chain skip | 250 | pass-5 remap | stub/gap/phantom-length | degenerate old edge produced no chain |
| pass-5 mapOldNode nearest fallback | 264 | pass-5 remap | missing-station/orphan | node's vertex kept by no run |
| **separateFusedStations (whole pass)** | **338** | **post-merge** | **fused-station/missing-marker** | **octi short-edge contraction folds distinct stations into one node** |
| separateFusedStations hop-over BFS | 399 | candidate search | short-edge/missing-marker | tiny junction stubs win "best" then bail |
| separateFusedStations line-serving filter | 393 | candidate search | missing-marker/vanished | splitting onto foreign corridor makes station vanish |
| separateFusedStations same-side ordering | 452 | candidate ordering | wrong-side/detour | projection picks opposite-side corridor |
| separateFusedStations mid-arc rejection | 459 | split-point selection | overshoot/coincident/sliver | edge passes next to node mid-arc |
| separateFusedStations minSep void | 372 | policy | fused-station | user rule: one marker per station |
| separateFusedStations split-point dedup | 497 | edge cut | short-edge/zero-length | split point coincides with existing vertex |
| separateFusedStations stop-flag retention | 545 | stop remap | phantom-stop/missing-marker | flag left on old node for a line that no longer stops |
| separateFusedStations keeper-half spur removal | 563 | traversal repair | spur/overshoot/retrace | reconstruction ran before split → terminating line retraces |
| separateFusedStations boundary single-step trim | 592 | traversal repair | spur/stub/dangling | routes starting/ending at old node leave lone step |

### layoutPost (`renderGeographic.ts` + `hookSuppress.ts` + `loopMetrics.ts`)

| Mechanism | Line | Stage | Artifact | Cause |
|---|---|---|---|---|
| spur-step out-and-back cleanup | rg 1175 | post-merge, pre-hooks | spur/stub/retrace | coincident-run merge pins course onto crossed corridor |
| suppressHooks (splicer) | rg 1204 | post-spur, pre-orderLines | fold/hairpin/loop/candy-cane | topo merge routes bundle to synthetic junction and fans back |
| hookSuppress maximal-run detection | hs 138 | suppressHooks | fold/hairpin/loop/detour | bundles routed through all-synthetic interior chains |
| hookSuppress detour+fold gate | hs 209 | suppressHooks | fold/detour/phantom-length | distinguish genuine fold from winding corridor |
| hookSuppress interior-stop guard | hs 225 | suppressHooks | gap/break | splice must not skip a real stop |
| hookSuppress A===E loop guard | hs 223 | suppressHooks | loop | synthetic run returning to start has no chord |
| hookSuppress octilinear shortcut builder | hs 54 | applyPlan geometry | detour/fold/phantom-length | replacement must itself be octilinear |
| hookSuppress shortcut reuse across mirror | hs 296 | applyPlan | coincident/duplicate | fold appears twice (mirrored) in one round-trip |
| hookSuppress reverse-order batch apply | hs 149 | suppressHooks | break/detour | splicing one run corrupts its mirror's indices |
| hookSuppress usage-based membership strip | hs 156 | suppressHooks | stub/phantom-length | leftover membership draws phantom lane |
| hookSuppress pruneEmptyEdges | hs 374 | cleanup | stub/phantom-length | edges emptied of all lines remain |
| hookSuppress resolveSteps missing-edge tolerance | hs 176 | suppressHooks | break | defensive: step referencing non-existent edge |
| **weldSubCellNodes (call site)** | **rg 1053** | **pre-octi** | **sub-cell/detour/loop** | **anchorGraphStops re-splits after contraction (Cause B)** |
| weldSubCellNodes station-station prohibition | topo 1308 | pre-octi weld | sub-cell | welding two stations changes map meaning |
| auditTraversals | rg 1197 | diagnostic checkpoints | break/gap/stub | detector: a stage that breaks a traversal self-identifies |
| loopMetrics detectPaintedLoops | lm 118 | post-draw diagnostic | loop/hairpin/candy-cane | octi+imageMerge fused-station hooks in painted track |
| loopMetrics properCross | lm 47 | detector internals | loop/retrace | out-and-back retraces are coincident, not crossing |
| loopMetrics crossing merge | lm 82 | detector internals | loop | one visual loop clips several segment pairs |

### draw (`renderOctilinear.ts` + `stops.ts` + `capsuleSlide.ts` + `splitConnect.ts`)

| Mechanism | Line | Stage | Artifact | Cause |
|---|---|---|---|---|
| jog-sliver suppression (sibling-aware) | ro 462 | ribbon geometry | sliver/stub/spur | imageMerge leaves one-cell edge jogging off both neighbours |
| curveLaneJoin miter | ro 546 | join pass | spike/sharp-miter | grid A* + offset make lanes meet at sharp miter |
| segment-cross uncross clip | ro 730 | join pass | loop/self-loop/hook | fused-station slot jog sweeps lanes over each other |
| octilinear turn-miter | ro 751 | join pass | fold/spike/teardrop | out-and-back with lanes ~18px apart on opposite sides |
| forward-turn dogleg | ro 808 | join pass | fold/stub/spike | lane ends at forward 45° bend at different slots |
| **dogleg B2 corridor-overshoot clamp** | **ro 834** | **join pass** | **loop/antiparallel-chord** | **B2 overshoots outbound micro-edge's far node (SEA route X, 9px; Cause B)** |
| band-cross taper vs short-edge decline | ro 900 | join pass | S-wiggle/detour | whole lineOrder swaps sides, lon≈0 |
| big-gap connector cap | ro 709 | join pass entry | gap/break/non-contiguity | line sweeps bundle width, fell past spacing*8 cap |
| painted-loop diagnostic | ro 940 | ribbon geometry | loop/balloon/self-crossing | out-and-back skeleton is perfect overlap, invisible there |
| drawnEndAt nearest-lane fallback | ro 1124 | marker gather | gap/retrace/sliver | flag node's lane was a suppressed terminus-retrace |
| vanished-station diagnostic | ro 1156 | marker gather | gap/break/vanished | station's marks all fail to resolve |
| escalation ladder (PRIMARY→FAR→BEST→split→mega) | ro 1469 | rigid-row placement | megabox/port-congestion | beta station-split puts platforms on far corridors |
| placed-hull mask + proximity ramp | ro 1496 | rigid-row solve | capsule-cross/overlap | earlier capsules occupy later row's space |
| seat-time hull-overlap verify | ro 1625 | post-solve verify | self-crossing/Z-fold | row spine crosses placed capsule / self-crosses |
| shared-anchor guard (Burke Court) | ro 1763 | all trim sites | gap/break/orphaned | terminus sliver shared by two split stations |
| move-commit hull guard | ro 1791 | slide passes | capsule-cross/self-crossing | slide passes create spine crossings (hull-blind) |
| mega-escape slide + box-back | ro 1194 | marker collision | swallowed-marker/bent-spine | mega box swallows nearby small markers |
| rigid-row translation slide | ro 1989 | collision slide | bent-spine/box | old per-dot slide bent straight rows off octilinear |
| applySlide dry-run guards | ro 2127 | slide commit | bent-spine/stacked/cross | re-seating on translated line bends/stacks/crosses |
| mutual capsule-slide escalation | ro 1959 | small-vs-small collision | overlap/ripple | neighbouring capsule markers overlap |
| post-slide no-overlap floor | ro 2313 | final de-overlap | ring-overlap/dot-merge | mutual-slide thresholds on spine-hull, not casing rings |
| along-corridor spread | ro 2446 | pre last-resort box | coincident/dot-merge | octi grid contracts consecutive stops below marker res |
| terminus trim | ro 2812 | post-placement | nub/through-poke/spur | slides move dot off node, ink pokes through capsule |
| station-vs-capsule eviction | ro 2875 | post-terminus-trim | dot-in-capsule/trapped | terminus dot lands inside neighbour's capsule |
| draw-only sharp-corner fillet | ro 3020 | post-marker | hard-elbow/chevron | fused-station bends left raw to keep solver input pristine |
| node-connector bundle-span cap | ro 3064 | node connectors | gap/break/non-contiguity | fixed 44px cap dropped legit jogs (NYC Q/R/N/W/1/4/5/6) |
| connector regressive chord degrade | ro 3148 | node connectors | balloon/hairpin/270-loop | pure lateral jog, lon≈0, balloons a hairpin |
| mega box compact-cap | stops 143 | mega branch | balloon/slab | boxed marks fling apart into a slab |
| coincident-marks degenerate ring | stops 252 | capsule branch | degenerate/stacked-dots | all marks coincide (best<1e-3) |
| RDP spine simplify | stops 283 | spine capsule | jitter/fold | collinear jitter from solve/quantization |
| chooseMutualSlide best-effort | capsuleSlide 58 | collision resolver | overlap/collision | no reachable offsets fully clear the pair |
| taxicab split-connector avoidance | splitConnect 71 | paint tail | overlap/grazing/stray | platform-split needs connectors, elbow grazes markers |

### ordering (`bundleOrder.ts` + `blockAlgebra.ts` + `lineOrder.ts`; `old/untangle.ts`)

| Mechanism | Line | Stage | Artifact | Cause |
|---|---|---|---|---|
| barycenter lineOrder pre-pass | lineOrder 6 | pre-ordering | crossing | position-blind seed; bundle-blocks now ignores it |
| buildCorridors identical-set contraction | bo 49 | corridor construction | short-edge/coincident/stub | topo/octi leave deg-2 chains of separate edges |
| **classifyFlows first-write-wins** | **bo 121** | **flow derivation** | **retrace/loop/coincident** | **game routes are ROUND TRIPS; return leg re-enters (Cause: round-trip repr.)** |
| angleAt corridor-scale tangent | bo 181 | angular ranking | spur/sliver/detour | seam micro-jogs make first-segment direction noise |
| relAngleAt wrap-safe bearing | bo 197 | angular ranking | detour/overshoot | absolute atan2 mis-ranks across ±π wrap |
| exitKeyOf frame-invariant seed | bo 219 | seeding | crossing | absolute angles bake in arbitrary endA/endB labeling |
| seedBlock majority-entry frame | bo 287 | seeding | crossing | keying "toward endB" bakes in arbitrary labeling |
| joinSideLookahead pair-ownership | bo 314 | bundle join | crossing/detour | join side must keep downstream splits contiguous |
| processJunction SPLIT-FIRST guard | bo 394 | split planning | crossing/phantom-length | look-back at settled neighbours counts phantom crossings |
| **overlap guard (CPW weave)** | **bo 436** | **join/derive** | **coincident/phantom-length** | **round-trip return leg makes line re-join a corridor** |
| cycle back-edge residual | bo 469 | cycle closure | crossing | visited corridor reached again; forcing reorder fights committed order |
| hasPendingFeeder root guard + self-feeder skip | bo 502 | BFS root selection | crossing/loop | round-trip turnaround makes corridor its own feeder |
| write-back seedBlock fallback | bo 538 | write-back | gap | corridor never reached by BFS propagation |
| reportStraightFlips A/B stick | bo 561 | diagnostics | crossing/retrace | measures residual braids (no repair) |
| mirrorBlock orientation flip | ba 24 | data structure | crossing | corridor against canonical frame needs reversed order |
| joinBlocks intact-nesting | ba 35 | data structure | crossing/retrace | makes in-bundle open-track reorders unrepresentable |
| reorderToGroups splitPlan | ba 70 | split planning | crossing/detour | exit groups need contiguity with least motion |
| [OLD] cornerTurnFactor + straight-lock | untangle 98 | crossing pricing | crossing/retrace | octi forces in-bundle swaps on straight track |
| [OLD] xCornerTurnFactor U-shape | untangle 144 | crossing pricing | crossing/hairpin | both collinear ends are shallow braids |
| [OLD] tryY trunk-split rewrite | untangle 268 | opt-graph rewrite | crossing/spur | deg-3 junction couples trunk order to both branches |
| [OLD] partner-block collapse (disabled) | untangle 418 | opt-graph reduction | crossing/sliver | write-back leaked member-vs-foreign flips |
| [OLD] stack-seam scoring | untangle 670 | scorer | crossing/retrace | **exists SOLELY to re-fight the braid tryY manufactured** |
| [OLD] cornerFactor station surcharge | untangle 362 | crossing pricing | crossing | bend at a station made marker cheapest swap site |
| [OLD] selfSeam probe (gated off) | untangle 510 | scorer probe | retrace/loop | ordering probe aimed at a geometry artifact ("real fix is render-side") |
| [OLD] hill-climb + multi-basin restart | untangle 993 | optimizer | crossing/sliver | straight-lock cliffed landscape froze hill-climbing |

---

**One-line summary for the owner:** The defenses fall into three families patching three causes — **(A)** the merge re-derives line routes by nearest-neighbor snapping instead of transforming them, **(B)** stops are re-split into corridors *after* contraction, birthing unroutable sub-cell edges, and **(C)** the old ordering scorer over-fought crossings (already fixed by `bundle-blocks`). Your crossing hunch is right about (C) and misplaced for the rest: the router already prices a legal crossing at 4 vs. SOFT_INF at ~200 000 — it detours only where legal crossings are *unavailable* (settled/diagonal/station nodes) or where the input geometry is infeasible at grid resolution. **Start with Fix 1** (protect stops through contraction): it is ~1–2 days, retires `weldSubCellNodes` + two octi excisions + several stub welds, and has a cheap `OCTI_WELD=0` falsifying test before you write a line of rewrite.
---

## Post-report addendum: Fix 1 experiment result (2026-07-05, same day)

**Fix 1 was run and FALSIFIED by its own abort criterion.** An anchor-creation
spacing floor in `anchorGraphStops` (refuse nodes within dHat of an existing
node) was implemented and measured on the SEA-split dump:

| metric (weld off) | baseline | with anchor floor |
|---|---:|---:|
| support edges < cell/2 at octi seam | 49 | 39 |
| octi drawn-level detour cuts | 12 | 11 |
| hooks spliced | 36 | 28 |

The anchor-created sub-cell class WAS fully eliminated (zero `ha*` entries in
the census) — but it was only ~10 of 49. The dominant class is **protected
station anchors with a merge junction created 2–13px beside them** (STN↔h
pairs: the merge's creepBlocked/lateralToTravel snap guards refuse to weld a
corridor onto the pinned station and mint a neighbour node instead). Worse,
~40 fewer stop nodes raised medLen → coarser grid (cell 21.2→25.2) → a net-
WORSE re-roll (detour cuts 17, new meander artifacts). **Reverted.**

What survived the experiment:
- `weldSubCellNodes` is NOT dead code — it is the correctly-placed repair for
  the STN↔h class (it knows the real cellSize; the anchor pass does not).
  With it, detour cuts drop 12 → 6 on this dump.
- Its self-loop keep-rule was wrong (polyline length, not extent) — fixed:
  curly sub-extent self-loops are deleted, true balloons kept.
- Fix 2 prize, measured (`[audit:heal-ladder]`, SEA-split): bfs=1077
  direct=0 anyPath(paint)=8 bridge(__heal)=1 stallJump=0 — the heal ladder
  fires 9 times per build. Small but each firing is a potential
  CPW/Franklin-class artifact; re-measure on NYC/LON dumps before deciding.

Revised recommendation: the census instrumentation (`OCTI_AUDIT=1`:
octi-seam short-edge census + heal-ladder counters) is now permanent
equipment. The next structural lever is Fix 2 (carry line paths through the
merge), gated on heal-ladder fire-counts from more cities; the STN↔h minting
in `ndCollapseCand`'s guard path is a better-scoped alternative target than
anchorGraphStops was.

---

## Bundle A result (2026-07-05, later the same day): PASSED

Fix 1 solo failed; Bundle A v1 (anchor floor + ndCollapseCand anchor-reuse)
also failed its falsifier (census 49 -> 55) — the reused anchor lands in
`myNds` and the next sample mints a twin anyway. The census attribution then
exposed the REAL factories, which the RCA had missed:

1. **`contractShortEdges` measured POLYLINE length, not node distance** — a
   wiggly 8px-span connector carrying >= dHat of sampled geometry shielded
   itself from contraction (same length-vs-extent bug class as the weld
   self-loop rule).
2. **`intersectionSmoothing` runs after the last contraction and MOVES
   nodes** — pairs pulled sub-cell with no contraction left to repair them.

Bundle A v2 = anchor floor (`minSep=dHat` in anchorGraphStops) + contraction
metric fix (node distance with a balloon-extent shield) + re-contract after
smoothing + OCTI_CELL grid pin for measurement. SEA-split, cell pinned 21.2:

| metric | old shipping | Bundle A v2 |
|---|---:|---:|
| pre-weld edges < cell/2 | 49 | **4** |
| pre-weld edges < cell | 210 | **80** |
| weld count | 31 | **3** |
| hooks spliced | 20 (36 weld-off) | **8** |
| heal ladder anyPath/__heal | 8 / 1 | **5 / 0** |
| gray max drawn gap | 7.7px | 4.6px |
| green line chronic gap | 22–25px | **5.6px** (unpinned) |
| magenta 17.8px "gap" | 17.8px | gone (pinned); colour-proxy H-vs-I artifact otherwise |
| octi detour cuts | 6 | 18 (watch item) |
| tests | 445 | 451, all pass |

No-split control also improved (gray 11.6 -> 6.9, green 11.6 -> 5.8, hooks
-> 2). The invariant now holds at freeze: the merge's contraction is the
single owner of node spacing, and no later pass (smoothing, anchoring) may
violate it. `weldSubCellNodes` drops from load-bearing (31) to residual
backstop (3-5: both-protected pairs its station rule correctly refuses);
`suppressHooks` drops 36 -> 8. Neither is deletable yet, but both are now
minor. Remaining watch items: detour-cut count rose 6 -> 18 (repairs firing
on the 80 one-to-two-cell edges — investigate before deleting the excisions);
the residual ~8 hooks; Fix 2 (traversal transform) still pending with a
measured prize of ~5 paint-heals/build.

Lesson recorded: the two failures + one success were all separated by the
SAME instrument (the seam census with per-edge attribution). Single fixes
lose to the homeostat; bundles built around ONE invariant, measured on a
pinned ruler, win.
