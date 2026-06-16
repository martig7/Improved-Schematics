# Optimizers in the renderer — what "optimal" means for each

**Date:** 2026-06-15. A survey of every routine in the render pipeline that *searches a
solution space for an optimum*, grouped by the **kind** of optimality it actually delivers.

Method: each of 25 algorithm files was read by one agent and independently re-checked by an
adversarial verifier; completeness critics then swept for inline optimizers the per-file
readers missed. 46 optimizing routines were found across 6 optimality classes. The verify
pass reclassified 7 (e.g. the Hanan router downgraded exact→local, `grid.routeEdge`
exact→discretization-bounded, and one "fixpoint" that was actually a non-iterative
projection); the critics added 3 inline optimizers (positioning-leg suppression,
spur-retrace removal, the rigid-row escalation wrapper).

The literal "locally optimal" routines are **Group 1** (greedy/hill-climb that can get
stuck). The other groups are "optimal" in narrower senses; they're included because the
useful answer to *what optimality means* is precisely this taxonomy.

**Throughline:** almost every globally-exact solver (Group 3) is wrapped in a greedy outer
loop (Group 1) — each edge routes optimally, but the *order* it routes them is a hill-climb;
each marker solves optimally, but the *order* stations are placed is greedy first-feasible.
The system stacks exact-local-solvers inside heuristic-global-drivers, which is why so much
of the code (octi local search, untangle restarts, the collision relaxation sweeps) exists
to nudge those greedy outer layers out of their local optima.

---

## 1. Genuinely locally optimal — greedy descent / hill-climb (can get stuck)

1. **Octi best insertion-ordering** — [octi.ts](../src/render/layout/octi.ts) `tryDraw`.
   Minimizes `Drawing.score()` = routed-edge cost + bend/geo/density/length penalties +
   `SOFT_INF·violations`. *Optimal =* lowest score among the ≤6 enumerated insertion
   orderings (a correct branch-and-bound cutoff prunes only within that menu). Local because
   the menu is heuristic and each edge is committed irrevocably; on >400-edge graphs only 2
   of 6 orderings run.
2. **Octi local search (node move + edge re-route)** — [octi.ts](../src/render/layout/octi.ts).
   Same `score()`. *Optimal =* a local minimum under the move set {move one station to one of
   8 grid neighbours, or re-route one edge}; at convergence no single such move helps by
   >0.05. Monotone greedy immediate-accept — can't make the coordinated multi-node move
   needed to escape, and a station migrates one cell per accepted move.
3. **Line-order hill-climb** — [untangle.ts](../src/render/layout/untangle.ts)
   `HillClimbOptimizer`. Minimizes `compScore` (crossings + separation + colorFrag, fixed
   penalty weights). *Optimal =* coordinate-descent local min: no single pairwise
   swap/insertion on any one edge improves the per-edge score. Multi-basin restarts raise the
   floor but give no global guarantee (grouping a colour family needs simultaneous multi-edge
   rotations one step can't reach).
4. **Hanan-grid per-edge A\* router** — [hananRouter.ts](../src/render/layout/hananRouter.ts)
   ⚠️ **DEAD CODE** — grep-verified zero production callers (superseded by the topo+octi router);
   slated for deletion, see [heuristic-improvements.md](heuristic-improvements.md) Tier 0.
   *(reclassified exact→local)*. Minimizes summed edge weight (length + bend +
   direction-disagreement + station + **negative** bundle bonus + conflict + diag-cross +
   continuity). *Optimal =* not provably so even per-edge — the negative bundle bonus + `0.01`
   weight floor makes the length heuristic **inadmissible** on bundled routes; also greedy
   across edges. Falls back to a straight segment when the 80k-expansion budget trips.
5. **Greedy corridor merge** — [topo.ts](../src/render/layout/topo.ts)
   `collapseSharedSegments`. No scalar cost. *Optimal =* each sample greedily welds to the
   nearest existing node passing creep/laterality guards, long trunks seeded first.
   Order/path-dependent; the 50/50 running average can creep two real corridors into one
   phantom trunk.
6. **Label placement** — [labels.ts](../src/render/labels.ts) `placeLabels`. Per node, argmin
   over 8 boxes of `100·labelOverlaps + 30·markerOverlaps + 12·lineCrossings + priority`.
   *Optimal =* exact argmin *for one node given already-placed labels*; globally greedy
   (longest-first, no backtracking), so an early label can wedge later ones into 100-cost
   overlaps.
7. **Barycenter line-order sweep** — [lineOrder.ts](../src/render/layout/lineOrder.ts)
   `orderLines`. Relaxes each edge's order toward the average normalized position of neighbour
   edges. *Optimal =* a fixed point of barycenter relaxation (≤6 passes), **not** min-crossing;
   can halt early or oscillate.
8. **Octilinear force relaxation** — [simplify.ts](../src/render/layout/simplify.ts)
   `simplifyLayout`. Descends edge-spring (0.18) + overlap-repulsion (0.6) + bend-straightening
   (0.12) over 80 clamped steps. *Optimal =* a local force equilibrium near the warped start;
   competing forces leave residual non-octilinear edges; integer snap adds uncosted
   displacement.
9. **Geography-anchored relaxation** — [simplify.ts](../src/render/layout/simplify.ts)
   `smoothGeographic`. ⚠️ **DEAD CODE** — grep-verified zero production callers (the LOOM octi
   port replaced relaxation-based smoothing); slated for deletion, see
   [heuristic-improvements.md](heuristic-improvements.md) Tier 0.
   Energy = octilinear edge-misfit (0.18) + squared displacement from true
   geography (0.25). *Optimal =* a Pareto force balance at the fixed 0.18/0.25 ratio — not a
   true optimum of either; anchor-dominant, so edges may never fully octilinearize.

## 2. Optimal only within a discretization — exact DP / exhaustive / argmin over a finite set

*(globally exact for the discretized space, no local trap within it — but blind to the
continuous problem)*

- **Rigid-row marker solver** — [rowPlace.ts](../src/render/layout/rowPlace.ts): per-bundle
  argmin over discretized (slide, axis) states → chain DP exact over the product of bundle
  states for a fixed sequence+mask → enumerate all `g!` orderings × `2^g` orientations, keep
  the DP-min. Exact for g≤5; **degrades to one greedy sequence (best-effort) for g>5**.
- **Exhaustive line-order optimizer** — [untangle.ts](../src/render/layout/untangle.ts)
  `ExhaustiveOptimizer`: exact global min of `compScore` over all per-edge permutations of a
  (small) component.
- **`chooseMutualSlide`** — [capsuleSlide.ts](../src/render/layout/capsuleSlide.ts): exhaustive
  over the offset grid → least-total-slide cell that clears, else least-residual (best-effort).
- **Nearest-point-on-polyline** ([chainPlace.ts](../src/render/layout/chainPlace.ts)
  `projectArc`), **farthest-pair marker axis** ([stops.ts](../src/render/stops.ts)),
  **nearest-cardinal/octilinear classifiers** ([ghostNodes.ts](../src/render/layout/ghostNodes.ts),
  [simplify.ts](../src/render/layout/simplify.ts)), **nearest-kept-vertex remap**
  ([imageMerge.ts](../src/render/layout/imageMerge.ts)), **smallest-enclosing water ring**
  ([bodies.ts](../src/water/bodies.ts)) — each an exact argmin/argmax over a finite set.
- **`routeEdge`** — [grid.ts](../src/render/layout/grid.ts) *(reclassified exact→discretization)*:
  A\* is exact min-g over the 8-dir grid *when it completes*, but a 50k-expansion cap + greedy
  fallback can return a non-optimal/non-goal path.

## 3. Provably globally optimal paths — exact shortest path *(the genuinely non-local ones)*

- **`drawOrder` per-edge route** — [octi.ts](../src/render/layout/octi.ts): A\* exact min-cost
  octilinear path for **one** edge vs the current grid. The *sequence* of per-edge-optimal
  routes is greedy, so the overall drawing is only locally optimal — which is what Group 1's
  items 1–2 exist to repair.
- **Dijkstra / multi-source-target Dijkstra** ([dijkstra.ts](../src/render/layout/dijkstra.ts)),
  **`gridGraph.route`** ([gridGraph.ts](../src/render/layout/gridGraph.ts), minimizes cost
  *including* finite `SOFT_INF` violation surcharges — not a hard constraint),
  **`shortestAnyPath` / `bfsLinePath`** ([topo.ts](../src/render/layout/topo.ts)). Each exact
  under its edge costs, over the *heuristically-built* graph it's given.

## 4. Greedy first-feasible — commits the first solution meeting constraints, not the best

`getRtPair` (octi), `pathForLineSegment` cascade & positioning-leg suppression
([topo.ts](../src/render/layout/topo.ts), [graph.ts](../src/render/layout/graph.ts)),
split-station edge projection ([imageMerge.ts](../src/render/layout/imageMerge.ts)),
mega-box escape + small-vs-small stage-1 slide + terminus-stub rotation + rigid-row escalation
wrapper ([renderOctilinear.ts](../src/render/renderOctilinear.ts)), `findFreeCell`
([octilinear.ts](../src/render/layout/octilinear.ts)), lane-offset de-collision
([offsets.ts](../src/render/layout/offsets.ts)). *Optimal =* first feasible in a fixed order /
smallest first-feasible step — order-dependent, never compares alternatives.

## 5. Best-effort — minimize residual when nothing fully satisfies

`anchorGraphStops`, group→support-node assignment, `mapToSupportForLine`, stop re-home (all
[topo.ts](../src/render/layout/topo.ts)). *Optimal =* exact nearest line-serving node within a
radius, but force-places / falls back when none qualifies.

## 6. Iterative fixpoint — converge to a constraint-satisfying point (no cost minimum)

maxScale clip-renormalize ([densityWarp.ts](../src/render/layout/densityWarp.ts) — the
distortion clamp), `runMergeRounds` ([topo.ts](../src/render/layout/topo.ts)), lane-continuity
bias relaxation ([renderOctilinear.ts](../src/render/renderOctilinear.ts)), `despike`
([clean.ts](../src/geography/clean.ts)), spur-retrace removal
([renderGeographic.ts](../src/render/renderGeographic.ts)). *Optimal =* a fixed point where the
constraint holds (scale ≤ cap / no further merges / no sharp reversals) — explicitly minimizes
**no** deviation norm.
