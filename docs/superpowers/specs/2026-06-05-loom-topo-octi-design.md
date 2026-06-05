# LOOM-style Topo Merge + Octi Schematicization — Design

**Date:** 2026-06-05
**Status:** Approved, ready for planning
**Mod:** Improved Schematics (Subway Builder)
**Primary reference:** Brosi & Bast, *Large-scale Generation of Transit Maps from OpenStreetMap Data*, The Cartographic Journal 60(4), 2024 ([preprint PDF](https://ad-publications.cs.uni-freiburg.de/Large-Scale_Generation_of_Transit_Maps_from_OpenStreetMap_Data.pdf)).
**Reference implementation:** [ad-freiburg/loom](https://github.com/ad-freiburg/loom) (C++, GPL-3.0), in particular the `topo` and `octi` binaries.
**Supersedes:** the "smoothed" mode introduced by `docs/superpowers/specs/2026-06-05-hanan-grid-routing-design.md`.

## Problem

The current `smoothed` mode renders each transit edge as an octilinear Dijkstra path through a shared Hanan grid (`hananRouter.ts`). After several iterations of cost-function tuning (`BEND_TURN_K`, `EXIT_DIRECTION_K`, `LINE_CONTINUITY_K`, …) the result is unsatisfying: stations are pinned to grid nodes one-by-one with no global view of placement, parallel corridors emerge only at render time via offset bundling rather than in the graph itself, and the cost terms fight each other in cases that need true co-optimization of station placement and edge routing.

LOOM's pipeline addresses both problems directly. `topo` rewrites the input line graph so that geographically parallel runs become *single graph edges* carrying multiple line ids — corridors exist in the topology, not just in the rendering. `octi` then schematicizes that merged graph by jointly choosing each station's grid position and each edge's routed path, optimizing a single global cost function (displacement + edge length + bend penalty + adjacent-edge bend penalty).

## Approach

A three-stage pipeline mirroring LOOM's binaries. Each stage is a separate module; downstream stages consume the previous stage's output as a plain TypeScript value.

### 1. Topo merge (paper §"Network Topology Extraction")

**Input:** the projected transit graph `G` — stations as nodes, route segments as edges, each edge carrying a `Set<lineId>`.
**Output:** the *support graph* `H` with parallel-close edges merged into single edges carrying the union of their line ids, plus stations re-inserted at the best-scoring nodes of `H`.

Algorithm in pixel space (we never have geographic lengths after projection):

```
sortEdgesByLength(G)                      # short edges first (most stable merges)
H = empty
for round r = 1..maxRounds:
    H_prev_total_length = sum(len(P(e)) for e in H.edges)
    H_input = (r == 1) ? G : H
    H = empty
    for each edge e_i in H_input (sorted by length):
        samples = densify(e_i, step = l)                # equispaced points
        blocking = ring buffer, size = ceil(d̂ / l)
        v_prev = null
        for k = 1..len(samples):
            p_k = samples[k]
            v = H.nearestNode(p_k) within d̂            # via R-tree or grid hash
            if v != null and v not in blocking and not creepBlocked(v, p_k, samples):
                v.pos = avg(v.pos, p_k)                  # snap toward this sample
            else:
                v = H.addNode(p_k)
            if k > 1:
                H.addOrUnionEdge(v_prev, v, L(e_i))      # union line-id sets if edge exists
            blocking.push(v)
            v_prev = v
    contractDegree2WithMatchingLines(H)                  # collapse straight runs
    H_total_length = sum(len(P(e)) for e in H.edges)
    if abs(1 - H_total_length / H_prev_total_length) < 0.002:
        break
intersectionSmoothing(H, d̂)                              # crop + reaverage at each node
insertStations(G.stationGroups, H)                       # rank by shared origin-edge count
```

`creepBlocked(v, p_k, samples)` implements the paper's line-creep mitigation: with `p_1` and `p_l` the first/last samples and `α = sin(π/4) ≈ 0.707`, candidate `v` is rejected when `α · dist(p_k, p_1) ≤ dist(p_k, v.pos)` or `α · dist(p_k, p_l) ≤ dist(p_k, v.pos)`. This prevents two edges meeting at obtuse angles from interlacing.

`intersectionSmoothing(H, d̂)` per paper §"Artefacts, Line Creep, and Intersection Smoothing": for each node `v`, crop the polyline of each adjacent edge at distance `d̂` from `v`, move `v` to the average of the resulting endpoints, then reconnect.

`insertStations(stationGroups, H)`: for each station group, gather the input edges adjacent to its stops. Within a radius of the cluster centroid, rank candidate nodes/edges in `H` by the *count of merged-original-edges shared with the cluster*. Place the station at the highest-scoring candidate. If it does not serve every adjacent input edge, place another station for the unserved edges (multi-candidate fallback from the paper).

#### Parameters

| symbol | meaning | default |
|---|---|---|
| `d̂` | merge distance threshold (px) | `2.5 × theme.lineWidth × maxLinesPerCorridor` |
| `l` | densification step (px) | `max(2, d̂ / 4)` |
| `α` | line-creep angle factor | `sin(π/4) ≈ 0.7071` (paper value) |
| `convergenceEpsilon` | edge-length-gap stop | `0.002` (0.2 %, paper value) |
| `maxRounds` | hard cap on outer loop | `8` |
| `stationCandidateRadius` | station-insertion search radius (px) | `2 × d̂` |

`d̂` scales with line width and corridor capacity, so a network with many overlapping lines (NYC midtown) tolerates a wider merge tube than a sparse one. `maxLinesPerCorridor` is computed once per render from the projected graph as `max(|L(e)|)` over all edges, with a floor of 2.

#### What we omit from the paper's topo

The paper's **line-turn-restriction inference** (§"Inferring Line Turn Restrictions") infers, from geometry, which line continues through which junction. Subway Builder route data is structured — each line's station sequence is given by `gameState`. We already know the right answer; no inference needed. We feed the explicit line traversals from `graph.lineTraversals` to topo so the support graph respects them by construction (an edge belongs to line `l` iff it lies on `l`'s known polyline).

### 2. Octi schematicization (paper §"Map Schematization")

**Input:** the support graph `H` from topo.
**Output:** an *image* `(V, P)` — each `H` node mapped to a grid node `V(v) ∈ Ψ`, each `H` edge mapped to a path `P(e) = (ψ_0, …, ψ_{n−1})` in the extended grid `Γ'`. Stations have moved (within a small budget) to grid positions; every edge is octilinear by construction.

#### 2.1 Extended octilinear grid `Γ'`

Built over the bounding box of `H` plus padding:

- Base grid: regular square grid, cell size `d_g = median edge length in H` (paper's "average distance between stations" heuristic).
- For each base grid node `ψ` at position `(x, y)`:
  - Add 8 **port nodes** `ψ_0..ψ_7`, one per octilinear direction (E, NE, N, NW, W, SW, S, SE), each at a tiny offset from `ψ`.
  - Connect each port to `ψ` via a **sink edge**. Sink-edge cost is set per Dijkstra query (= the displacement cost for the station being placed at `ψ`).
  - Connect every pair of ports within `ψ` via a **bend edge** weighted by the turn angle between their directions.
- Inter-node grid edges connect port-to-port: port `ψ_d` connects to the opposite port on `ψ`'s neighbour in direction `d`. Edge weight:
  - `1.0` for axis-aligned (N/E/S/W),
  - `1.5` for diagonal (NE/NW/SE/SW) — slight bias toward horizontal/vertical, per paper.

**Bend weights** (chosen monotone per paper's §"Modelling Edge Weights"):
```
w_180 = 0   # straight-through
w_135 = 1   # 22.5° between adjacent ports = 135° heading change
w_90  = 3
w_45  = 9   # sharpest octilinear turn — heavily penalised
```
**No-shortcut correction** (paper, same section): a single 45° bend must not be cheaper than a 135° + 180° combo on a denser grid. Let `a = w_45 − w_135 = 8`; redefine `w'_α = w_α + a` for all bend weights *and* subtract `a` from every grid-edge weight. This preserves the relative comparison while preventing the optimizer from substituting acute bends for traversals.

#### 2.2 Iterative shortest-path placement (heuristic)

Per paper §"Iterative Shortest Path Calculation" — no ILP.

```
sortInputEdgesByImportance(H)            # line count desc, length desc
settled: Map<H.node, ψ> = empty
for each input edge e = (u, v):
    U = candidateSet(u, settled, displacementRadius)
    V = candidateSet(v, settled, displacementRadius)
    for ψ in U: setSinkCost(ψ, d(u, ψ) · w_m)
    for ψ in V: setSinkCost(ψ, d(v, ψ) · w_m)
    blockSinksViolatingCircularOrder(u, settled)
    blockSinksViolatingCircularOrder(v, settled)
    P(e) = dijkstra(Γ', U, V, addAdjacentBendPenalty=true)
    if P(e) is null:
        d_g *= 0.9; rebuild Γ'; restart       # paper's stalling rule
        continue
    settle u -> first(P(e)), v -> last(P(e))
    markUsedGridEdges(P(e), penalty = LARGE_FINITE)   # constraint relaxation
```

`candidateSet(u, settled, r)`:
- If `u` is settled: return `{settled[u]}`.
- Otherwise: Voronoi-partition the grid nodes within radius `r` of `u`'s projected position — keep those *strictly* closer to `u` than to `v`. (Paper's Voronoi rule guarantees `U ∩ V = ∅`.)

`blockSinksViolatingCircularOrder(u, settled)`: when `u` already has settled adjacent edges, the new edge's exit direction at `u` is constrained to the rotational slot consistent with `H`'s edge ordering around `u`. Sinks at violating port positions get cost `LARGE_FINITE`.

**Adjacent-edge bend penalty.** For each routed edge `P(e)` and each previously-routed adjacent edge `P(f)` sharing input node `v`, add `Σ w_φ · |L(e) ∩ L(f)|` to the placement cost — bigger bends between corridors sharing more lines cost more. Implemented by adjusting the sink-edge costs at `V(v)` before each Dijkstra query (paper Fig. 17). The sink-edge cost at port `ψ_d` of grid node `ψ ∈ U` thus composes three additive terms before the Dijkstra query:
1. **Displacement:** `d(u, ψ) · w_m` (always).
2. **Adjacent-edge bend:** `Σ_{f settled around u} w_φ_{ψ_d, P(f)} · |L(e) ∩ L(f)|` (only when `u` has previously-routed adjacent edges).
3. **Ordering block:** `+ LARGE_FINITE` when entering through port `ψ_d` would place `P(e)` at a rotational slot inconsistent with `u`'s circular edge ordering.

**Cost terms — global target (paper eq. 1):**
```
t(V, P) = Σ_e c(P(e))                           # grid + bend weights along path
        + Σ_v d(v, V(v)) · w_m                  # node displacement
        + Σ_v Σ_{e,f ∈ adj(v)²} w_φ |L(e)∩L(f)| # adjacent-edge bend, line-weighted
```

**Constraint relaxation** (paper §"Local Search and Constraint Relaxation"): used grid edges and ordering-violating sinks get a very large finite cost rather than `Infinity`. Dijkstra always returns a path; visually objectionable cases pay their cost and would be polished by the (out-of-scope-for-v1) local search.

**Stalling prevention:** if no path is found for some edge, shrink `d_g` by 10 % and rebuild `Γ'` — at most 3 retries before falling back to a direct snapped segment for that edge.

#### 2.3 Geography-preserving option

For overlay-on-map use we want the schematic to stay close to real geography. Per paper §"Approximating Geographical Line Courses", offset each grid edge's cost by the weighted *squared distance* from that grid edge's midpoint to the geographical course of the currently-routed input edge:

```
c'(grid_edge, input_edge) = c(grid_edge) + w_geo · dist²(midpoint(grid_edge), course(input_edge))
```

Exposed as `octiOptions.geographicAffinity: number` in `[0, 1]`, default `0.5`. `0` ignores geography (pure schematic), `1` pulls hard toward geographic course (overlay-friendly).

#### Parameters

| symbol | meaning | default |
|---|---|---|
| `d_g` | base grid cell size (px) | `median edge length in H` |
| `w_m` | displacement weight per px | `0.5 / d_g` (so 1-cell displacement costs `0.5`) |
| `displacementRadius` | max displacement (px) | `1.5 × d_g` |
| `w_180, w_135, w_90, w_45` | bend weights | `0, 1, 3, 9` |
| `w_φ` per shared line | adjacent-edge bend weight | reuse `w_90`-scale of node bend |
| `w_geo` | geography affinity weight | tuned so `geographicAffinity=1` yields displacement-bounded paths |
| `LARGE_FINITE` | relaxed block cost | `10_000 × d_g` |
| `maxStallRetries` | grid-shrink fallback cap | `3` |

#### What we omit from the paper's octi

- **ILP optimization** (paper §"Iterative Shortest Path Calculation" references ILPs from Bast et al. 2020/2021): would require shipping a JS LP solver (`glpk.js` ≈ 1 MB). Heuristic produces "good results in our experiments" per the paper; defer until insufficient.
- **Local search polish** (paper §"Local Search and Constraint Relaxation"): try moving each image node to neighbouring grid nodes and re-routing adjacent paths; keep the best. Additive — clean hook `polishImage(state)` exported from `octi.ts` but not implemented in v1.
- **Hexagonal / orthoradial base grids** (paper Fig. 15(2)–(3)): we only need octilinear for an overlay mod.

### 3. Line ordering — reuse existing

`src/render/layout/lineOrder.ts` already implements the line-ordering step (paper §"Line-Ordering Optimization"). The octi output produces a `Layout` with edges, each carrying its merged `lineIds`; we call `orderLines(layout)` exactly as the schematic and current smoothed modes do.

### 4. Module layout

```
src/render/layout/
  topo.ts            NEW   # support-graph construction
  topo.test.ts       NEW
  octi.ts            NEW   # iterative shortest-path schematicization
  octi.test.ts       NEW
  octiGrid.ts        NEW   # Γ' construction: ports, sinks, bend edges
  octiGrid.test.ts   NEW
  hananGrid.ts       KEEP  # still used by current schematic-mode and by octiGrid's
                           # base-node layout (cell snap helpers)
  dijkstra.ts        KEEP
  lineOrder.ts       KEEP
  graph.ts           KEEP
  hananRouter.ts     DELETE
  hananRouter.test.ts DELETE
  ghostNodes.ts      DELETE  # station-splitting handled by topo's insertStations
  ghostNodes.test.ts DELETE

src/render/
  renderGeographic.ts MODIFY  # consumes topo'd graph for geographic; thin pipeline for smoothed
  schematic.ts        MODIFY  # mode dispatch unchanged; 'smoothed' now routes through topo+octi
```

### 5. Integration into render modes

- **`geographic` mode:** build the projected transit graph (as today via `buildTransitGraph`), run `topo` on it, render the support graph's edges through `renderRibbons`. Result: parallel corridors bundle into ribbons at the graph level — no more 3 squiggly parallel curves along Lex Ave. The water layer and labels work unchanged. Stations render at their `insertStations` positions (small displacement from raw geographic, ≤ `d̂`).
- **`smoothed` mode (repurposed):** topo → octi → `orderLines` → `renderRibbons`. The `showGrid` diagnostic toggle now overlays `Γ'` (grid base nodes + axis lines) instead of the Hanan grid. Stations render at `V(u)` grid positions.
- **`schematic` mode (game port):** unchanged — `octilinearLayout` + `simplifyLayout` + `orderLines`.

`renderRibbons` and `placeLabels` and `findTransferPairs` and `renderTransferConnectors` are reused verbatim.

### 6. Deletion list

| file | reason |
|---|---|
| `src/render/layout/hananRouter.ts` | replaced by `octi.ts` |
| `src/render/layout/hananRouter.test.ts` | ditto |
| `src/render/layout/ghostNodes.ts` | station-splitting absorbed by `topo.insertStations` (multi-candidate fallback) |
| `src/render/layout/ghostNodes.test.ts` | ditto |
| `renderSmoothed()` body in `src/render/renderGeographic.ts` | replaced by a thin call into the new pipeline; the seven cost-tuning constants (`BEND_TURN_K`, `STATION_ADJACENT_BEND_K`, `BUNDLE_BONUS_K`, `CONFLICT_PENALTY_K`, `DIRECTION_DISAGREEMENT_K`, `EXIT_DIRECTION_K`, `LINE_CONTINUITY_K`) go away with it |
| `HANAN_SNAP_DIVISOR` constant in `renderGeographic.ts` | superseded by `d_g` derivation inside `octi.ts` |

The `showGrid` panel toggle is kept, repurposed to overlay `Γ'`.

## Testing

### Unit

- `topo.test.ts`:
  - Two near-parallel edges within `d̂` merge to one edge carrying both line ids; the merged polyline's points are averaged.
  - Two parallel edges *farther* than `d̂` stay separate.
  - An edge crossing another at ~90° does *not* merge (creep blocker prevents the interlace).
  - Convergence: a 3-line corridor converges within 3 rounds for a synthetic 20-edge fixture.
  - `insertStations`: a 3-stop cluster with 4 incident input lines, all reachable from one support-graph node, places exactly one station there; a cluster whose support nodes split into two non-overlapping serving sets places two stations.

- `octiGrid.test.ts`:
  - A single base node yields exactly 8 ports, 8 sinks, and `C(8,2) = 28` bend edges.
  - Bend weights satisfy `w_180 ≤ w_135 ≤ w_90 ≤ w_45` after the no-shortcut correction.
  - A 3×3 base grid yields the expected port-to-port inter-node edges with correct axis-vs-diagonal weights.

- `octi.test.ts`:
  - A 2-station graph with the two stations on an axis grid line schematizes to a single straight axis run with zero bends.
  - A 2-station graph with the two stations *off* an axis (e.g. dx:dy = 3:1) schematizes to either an L-shape or a 45° + axis run, whichever the cost function picks; in both cases the total path is octilinear.
  - A 4-station ring schematizes to a square; each station's displacement is ≤ `displacementRadius`.
  - With `geographicAffinity = 1`, a curved 5-station input graph produces an octilinear path whose midpoint stays within `2 × d_g` of the original curve.

### Visual

- `dev/render-test.ts` produces `out-geographic.svg`, `out-smoothed.svg`, `out-schematic.svg` from the NYC and Seattle saves. PNG checkpoint at:
  1. After topo lands (geographic mode shows bundled corridors).
  2. After octi lands (smoothed mode shows true octilinear schematic with station displacement).
- Each checkpoint surfaces the rasterized PNGs via the dev harness for the user to eyeball before merging.

## Out of scope

- **Local search post-processing** for octi (paper §"Local Search and Constraint Relaxation"). Additive future work; the v1 image is complete without it.
- **ILP optimization** for octi. Defer until heuristic insufficient.
- **Hexagonal / orthoradial base grids.** Octilinear only.
- **Line-turn-restriction inference** from geometry (paper §"Inferring Line Turn Restrictions"). Subway Builder provides explicit line traversals — no inference needed.
- **Replacing the game-port `schematic` mode.** Stays untouched; different intent, looks good already.
- **Smooth Bézier ribbon connections at nodes** (paper Fig. 18–19). Nice-to-have polish; current ribbon-at-node rendering is acceptable.
- **Multiple support-graph passes per render** beyond the paper's `convergenceEpsilon` loop. We cap at `maxRounds = 8`.

## Migration & rollout

One PR per stage on a `feat/loom-pipeline` branch, merged to `master` at the end after the visual checkpoints pass:

1. **Topo** lands first: `topo.ts` + tests + wire into geographic mode (replaces raw polyline render). Visual checkpoint: bundled ribbons in geographic mode. At this point `smoothed` mode is still the old Hanan router.
2. **Octi** lands second: `octiGrid.ts` + `octi.ts` + tests + wire into smoothed mode. Visual checkpoint: octilinear schematic with displaced stations.
3. **Cleanup**: delete `hananRouter.ts`, `ghostNodes.ts`, their tests, the `HANAN_SNAP_DIVISOR` and old cost constants.

If the topo merge causes regressions in geographic mode that we can't quickly fix, an interim feature flag (`useTopoMerge: boolean` in `SchematicOptions`, default off) lets us land topo behind a switch and flip it on once tuned. Default flip happens in step 3 of the rollout.
