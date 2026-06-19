# Smoothed-mode pipeline — performance breakdown

A full performance analysis of the **Smoothed** render mode: the TypeScript LOOM
octilinearization pipeline that turns a live transit network into a printed-metro-map
layout. This document maps where the time actually goes, with deep-dive subsections
for the genuinely complex stages.

> Scope note: this covers the `smoothed` mode only. The `schematic` mode
> (`octilinearLayout` + `simplifyLayout`, which is what uses
> `constants.ITERATIONS = 80`) is a *separate* path and is **not** analyzed here.
> The smoothed octilinearizer has its own iteration budget (`locSearchIters = 100`).

---

## 1. Two-phase structure

Smoothed mode is deliberately split into a **heavy precompute** and a **light redraw**
so that toggling labels/stations in the panel doesn't re-run the layout:

| Phase | Entry point | Re-runs when… | Cost |
|---|---|---|---|
| **Heavy** | `precomputeSmoothed()` — `renderGeographic.ts:433` | the *network* changes (Generate) | dominates — seconds to tens of seconds |
| **Light** | `drawSmoothed()` → `renderRibbons()` — `renderGeographic.ts:896` | only label/station toggles | cheap — linear pass |

The cached boundary between them is `SmoothedPrecomputed` (`renderGeographic.ts:411`):
the layout, node pixels, transfers, station metadata, and the static water/grid overlay.

### Pipeline stages (heavy phase, in execution order)

```
input (routes/tracks/stations/groups)
  │  sort-by-id canonicalization              renderGeographic.ts:442-447
  ▼
buildTransitGraph + getOrBuildStationGroups    graph.ts          ── §3
  ▼
density warp construction (buildSepBoxWarp)     densityWarp*.ts   ── §4
  │  + re-fit to warped extent                  renderGeographic.ts:632-660
  ▼
LOOM topo merge (buildSupportGraph)             topo.ts           ── §5
  ▼
OCTILINEARIZER  octi(support, opts)             octi.ts/gridGraph ── §6  ◄ bottleneck
  ▼
mergeCoincidentPaths + separateFusedStations    imageMerge.ts     ── §7
  ▼
supportToLayout + spur-step cleanup             renderGeographic.ts:808-847
  ▼
orderLines (barycenter)  → untangleLineOrder     lineOrder/untangle ── §8
  ▼
SmoothedPrecomputed  ──────────────────────────────────────────────┐
                                                                    ▼
                            drawSmoothed → renderRibbons (+offsets)  ── §9
```

---

## 2. Where the time goes (cost ranking)

Ordered by share of wall-clock on a real metro-scale network (NYC/Seattle dumps):

1. **Octilinearizer (`octi`) — dominant, by a wide margin.** A code comment in the
   warp-capture path literally calls it "the ~70s octi pass"
   (`renderGeographic.ts:673`). Everything else combined is a rounding error next to it.
2. **LOOM topo merge** — second, mostly the iterative relaxation rounds plus the
   brute-force station re-insertion scans.
3. **`untangleLineOrder`** — third; an unbounded local search, but tamed by component
   decomposition so it rarely bites.
4. **Density warp construction** — milliseconds; cheap.
5. **`renderRibbons` (light half)** — linear; cheap by design.

The rest of this document drills into each, with the deep dives reserved for §5, §6,
and §8 where the real complexity lives.

### 2.1 Measured breakdown (NYC dump, metro-scale)

Stage timing on `improvedschematics-input-nyc.json` (552 stations, 491 groups, 621
support edges), via `OCTI_PERF=1 tsx dev/_bench-octi.ts` (median of 3 runs):

| Stage | Time | Share |
|---|---|---|
| graphBuild | ~64ms | 1% |
| warpBuild | ~49ms | 1% |
| topoMerge | ~1074ms | 12% |
| **octi** | **~2342ms** (post-opt; ~3321ms before) | ~30% |
| mergeCoincident | ~27ms | <1% |
| **untangle** | **~4382ms** | ~50% |

**Important nuance:** the "~70s octi pass" comment (`renderGeographic.ts:673`) reflects
**bus-scale** networks (Seattle, `support.edges > 800`) where the grid `G ∝ 1/cellSize²`
explodes and the local search runs many sweeps. At **metro scale** (NYC) the local search
converges in **3 sweeps**, so octi is ~30% and **`untangleLineOrder` is actually the
single largest stage (~50%)**. Optimization priority is therefore input-dependent: octi
for bus-scale, untangle for metro-scale. See §6.7 for the shipped octi win.

**Notation used throughout:** `N` = graph/support nodes (station groups), `E` = edges
(corridors), `L` = lines, `b` = bundle width (lines per edge), `G` = grid cells
(`G ∝ canvas_area / cellSize²`), `S` = sample points (per-edge resample count, or warp
sample count depending on context), `P`/`V` = path vertices per edge.

---

## 3. Graph build (`graph.ts`)

`getOrBuildStationGroups` + `buildTransitGraph` (`graph.ts:413-516`). Linear and cheap:

- One equirectangular `project()` per node (`graph.ts:429-432`).
- Per route, `walkRouteVisits` (`graph.ts:284-378`) produces a de-duplicated ordered
  group-visit list; consecutive visits become undirected edges, unioning line ids and
  stop flags. Cost ≈ `O(routes·visits + E·L)`.
- With `tracks`, a second pass rebuilds per-direction corridor geometry and attaches
  `e.geo` polylines.

**Watch item (not currently hot, but quadratic-shaped):** several call sites resolve an
edge by id with `g.edges.find(e => e.id === …)` — a linear scan of all edges — e.g.
`isMergeAnchor` does it once per node (`topo.ts:948`), making that call `O(N·E)`, and
traversal reconstruction does it per step (`O(steps·E)`). The graph already carries
`g.adj`; an `id→edge` Map would collapse these.

---

## 4. Density warp (`densityWarp.ts`, `densityBoxWarp.ts`, `densityWarp2d.ts`)

The warp enlarges crowded parts of the map (print-NYC-style Manhattan blow-up) so the
octi grid is effectively finer where the network is dense. It's built from
`warpSamples` — one point per station, repeated by an integer weight
(`renderGeographic.ts:588-608`) — and then **wraps the projection**:
`proj.toSVG = c => warp(baseProj.toSVG(c))` (`renderGeographic.ts:620-623`).

The crucial perf fact: `warp()` is **called once per node, per edge `geo` vertex, and per
water/green polygon vertex** (`renderGeographic.ts:634-641`, again at `:661`) — tens of
thousands of calls. So the **per-call evaluation cost matters far more than construction
cost.**

Symbols: `S` = warp samples (≈ N × small int, low thousands), `B` = histogram bins/axis
(default **96**, `densityWarp.ts:82`), `r` = Gaussian half-width (≈8).

| Mode (`OCTI_WARP_MODE`) | Construction | **Per-`warp()` eval** | Eval loops? |
|---|---|---|---|
| `separable` | `O(S + B·r)` | **`O(1)`** — direct CDF index + lerp (`densityWarp.ts:152-165`) | no |
| `box` | `O(S + B²·r)` | `O(#boxes)`, 1–5 | boxes only |
| **`both` (default, `buildSepBoxWarp`)** | `O(S + B²·r)` | **`O(1)` + `O(#boxes)`** (`densityBoxWarp.ts:202-205`) | boxes only |
| `2d` (rejected) | `O(iters·(S + B²·rad²))` | **`O(iters)`** ≈ 20 bilinear samples/pt | **yes — 10 steps** |

**Default path (`buildSepBoxWarp`, `densityBoxWarp.ts:214`):** a separable CDF warp for
global magnification composed with a box-expansion warp for local room. Construction is
dominated by one 2D Gaussian smoothing (`O(B²·r)` ≈ 157k ops) — still milliseconds.
Evaluation is effectively `O(1)` per point, with its only real tax being **~3–4
short-lived array allocations per warped point** (`densityBoxWarp.ts:160, 203, 204` plus
`sep`'s tuple). Across tens of thousands of vertices that's the stage's main GC pressure.

**Why `2d` was rejected (the perf reason).** `buildDensityWarp2D` (Gastner–Newman,
`densityWarp2d.ts:211`) loops `iterations` (default 10) times, each building a `O(B²·rad²)`
≈ 1.5M-op displacement field (`densityWarp2d.ts:156-175`) and **retaining two `B²`
`Float64Array`s per iteration** (≈ 1.5 MB live in the closure). Worse, its returned
`warp()` **loops over all 10 steps doing 2 bilinear samples each** — `O(iters)` per point,
~10–20× slower than separable. Construction is ~10⁴× the separable cost. It is left in as
a tunable but is off by default.

**Scaling lever:** `OCTI_WARP_SIGMA`, `OCTI_BOX_*`, `OCTI_WARP` (alpha). None change the
asymptotics — the warp is not where the pipeline's time lives.

---

## 5. LOOM topo merge — `buildSupportGraph` (`topo.ts`)  ⟨deep dive⟩

Collapses geographically parallel transit edges into single support corridors carrying the
union of their line ids (Brosi & Bast 2024). Called with `dHat = max(16, lineWidth·4)`,
`step = max(2, dHat/4) ≈ 4px`, `maxRounds = 8`, `convergenceEpsilon = 0.002`
(`renderGeographic.ts:698-707`).

### 5.1 The iterative relaxation — `runMergeRounds` (`topo.ts:758-787`)

Up to **8 rounds**. Each round runs `collapseSharedSegments` (`topo.ts:647-751`):

- Sort edges longest-first — `O(E log E)`.
- Per edge: RDP-simplify then `densify` to `S ≈ edgeLen / 4px` samples.
- Walk the `S` samples; per sample, snap to the nearest existing node and 50/50-average
  the node toward the sample (`HBuilder.snap`, `topo.ts:207-213`) — this is the creep that
  pulls parallel corridors together across rounds.

**Proximity is spatially indexed, NOT brute-forced.** `NodeIndex` (`topo.ts:95-154`) is a
uniform grid hash with cell size = `dHat`; each nearest-node query scans only the 3×3 cell
neighbourhood (`topo.ts:137-151`) → expected `O(1)` per query. **There is no `O(E²)`
parallel-edge search.**

- **Per-round cost:** `O(E·S·occ)` (`occ` = avg nodes in a 3×3 hood, bounded by how many
  corridors bundle locally) + `O(E log E)` sort.
- **Total relaxation:** `O(R · E · S)`, `R ≤ 8`, with early convergence when edge count
  stops dropping or total length moves < 0.2% (`topo.ts:776-784`). Near-linear in total
  sampled geometry. Halving `step` (or `dHat`) doubles `S` and thus doubles this stage.

### 5.2 The cleanup contractions — quadratic shape

`contractShortEdges` (`topo.ts:323-382`) and degree-2 contraction (`topo.ts:261-305`) are
`while (changed) { for-edge … break }` loops that **restart the whole scan after every
single mutation** (`topo.ts:302, 379`). That's `O(M²)` in the number of contractions `M` —
the realistic worst case of the cleanup phase on dense junction meshes.

### 5.3 The brute-force station re-insertion — the scalability concern

After freezing the support graph, the station/stop re-insertion phase **abandons the
spatial index and reverts to linear scans over all support nodes/edges**:

- `anchorGraphStops` (`topo.ts:974-1068`): per stop, `hasNodeNear` scans **all** nodes
  (`:983-986`) and the best-edge search scans **all** edges (`:1008-1017`) →
  `O(stops · (nodes + edges·points))`.
- Station placement (`topo.ts:1472-1528`): per group, `consider` runs over **every**
  support node (`:1503`, again at `:1505`) → `O(N · nodes · deg)`.
- Stop homing (`:1530-1569`) and `mapToSupport*` (`:1288-1298, 1357-1376`): more full
  node scans, per stop / per line.

These `O(N·nodes)` scans are the **asymptotic dominator of topo at high N**, even though
the merge core is near-linear. The kicker: `freezeBuilder` **already builds a populated
`NodeIndex(50)`** (`topo.ts:807`) that this code never queries. Wiring the re-insertion
scans through the existing index is the single clearest optimization in this stage.

### 5.4 Allocation hot spots

`densify` rebuilds the `S`-point array (with a fresh 2-tuple per sample) **every edge,
every round** → `R·E·S` allocations, the dominant GC pressure here. `simplifyRdp`
allocates via recursive `slice`/spread. `snapshot` (`topo.ts:427-433`) deep-clones the
whole node Map + edge list. `NodeIndex` keys are `"x,y"` strings — a string alloc per
insert/move/query.

---

## 6. The octilinearizer — `octi()` (`octi.ts` + `gridGraph.ts`)  ⟨the bottleneck⟩

This is where the ~70 seconds live (`renderGeographic.ts:673`). It is a LOOM-style
heuristic octilinearizer: lay the support graph on an octilinear grid by routing each
corridor as a shortest path through a per-cell "octi grid graph," then locally search node
positions to minimize a cost model (bends, crossings, spacing, geographic affinity,
length preservation).

> The hot path is `OctiGridGraph.route` (`gridGraph.ts:588`) — a hand-inlined,
> typed-array A\* with its own binary heap. `dijkstra.ts` / `octiGrid.ts` are **not** on
> this path (they serve the separate `hananRouter`).

### 6.1 Control flow — `octi()` (`octi.ts:1324`)

1. Cell sizing: `medianEdgeLength` (`octi.ts:75`, `O(E)` + sort).
2. `contractShortEdges` (`:108`) — merge sub-half-cell edges, `O(E·α)`.
3. `planarize` (`:212`) — **`O(E²)` pairwise** edge-box test (`:1156-1158`), with a
   segment×segment inner product on overlap → `O(E²·s²)` worst case. Real, but secondary.
4. `combineDeg2` (`:410`) — collapse degree-2 chains, `O(N)` worklist.
5. **`tryDraw` (`:1641`)** — the expensive stage (below).
6. Retry on failure: shrink `dg *= 0.9` and **rebuild the entire grid**, up to
   `MAX_STALL_RETRIES = 3` (`octi.ts:60, 1404`), then a snap fallback.
7. Near-linear post-processing (`expandImage` / `contractSplits` / `finish`).

### 6.2 The grid graph (`gridGraph.ts`) — size is everything

Per base cell the grid graph materializes **9 nodes** (1 centre + 8 ports) and **80
directed edges** (16 sink + 56 bend + 8 grid). For `G = cols·rows` cells:

- **≈ 9·G nodes, ≈ 80·G directed edges**, all in flat typed arrays (`cost0`, `flags` of
  length `80·G`; A\* scratch `dist/stamp/parentEdge/parentNode` of length `9·G`).
- `G ∝ canvas_area / cellSize²`. **Halving `cellSize` quadruples the entire grid** — and
  with it every A\* frontier and all the scratch arrays.
- Construction (`writeInitialCosts`, `:255`) is `O(G)` (~64·G writes) — cheap relative to
  search, and built only `≤ 1 + retries` times.
- Diagonal-crossing conflicts are hard-blocked by blocking the conjugate diagonal
  (`settleEdg`, `:433-440`) — `O(1)` per settled diagonal hop. This is the X-crossing
  preventer.

### 6.3 The search — A\*, run millions of times

`route` (`gridGraph.ts:588-723`) is **multi-source / multi-target A\*** with an admissible
octilinear heuristic (`heurCost`, `:572`) and a `cutoff` prune (`relax`, `:668`:
`if (g > cutoff) return`). The priority queue is a **binary heap over two parallel plain
`number[]` arrays** (`heapF`, `heapN`, `:616-651`) with lazy deletion via generation
stamps (no decrease-key; stale entries skipped at pop, `:681-682`). One query is
`O(G log G)` worst case but stays near the routed corridor in practice thanks to the
heuristic + cutoff.

**Search count is the dominant term** (`tryDraw`, `octi.ts:1641`):

- **Initial drawing (`:1656`):** up to **6 orderings** (`ALL_METHODS`, `:1244`), or **2**
  when `h.edges.size > 400` (`:1653`). Each routes all `E` edges → **6·E** queries.
- **Local search (`:1696`):** up to `iters = 100` sweeps (`octi.ts:57, 1679`). Each sweep:
  - **Node sweep (`:1699`):** for each of `N` nodes, try **9 candidate positions**
    (`:1727`), each re-routing the node's incident edges → ≈ `9·(2E)` = **18·E** queries.
  - **Edge sweep (`:1761`):** re-route each of `E` edges once → **E** queries.
  - So ≈ **19·E A\* queries per sweep.**

> **Dominant cost ≈ `O(iters · E · A*)`, with `A* ≈ O(G log G)` and `G ∝ 1/cellSize²`.**
> Up to `100 sweeps × ~19·E` shortest-path searches over a `9G`-node / `80G`-edge grid.

This port applies **every improving move immediately** (greedy, `:1744-1750`) rather than
LOOM's score-all-then-best, to converge faster single-threaded. Convergence usually halts
the sweeps early once `sweepImp < CONVERGENCE_THRESHOLD = 0.05` (`octi.ts:61, 1786`).

### 6.4 The top allocation hot spot — `Drawing.clone()`

`Drawing.clone()` (`octi.ts:780`) deep-copies **9 Maps** (nodes, edges, reach costs,
boundary costs, edge costs, spring costs, length costs, violations). It is called **once
per candidate position inside the 9-position trial loop** (`:1716, 1731`) **and** per edge
in the edge sweep (`:1764`). At ≈ `19·E·iters` trials, that is **millions of multi-Map
clones** — the single largest GC/allocation pressure point in the whole pipeline. Secondary
per-query allocations: new `Set`/array for targets (`:597-598`), two heap arrays
(`:616-617`), closures re-created per call, and **array-destructuring swaps inside the heap**
(`[a,b]=[b,a]`, `:624-627`) allocating a temp array per swap in the innermost loop.

### 6.5 What's already optimized

`cutoff` pruning tied to the best-drawing score (`:668, 1148`); generation-stamped scratch
so the `G`-sized arrays aren't re-zeroed between queries (`:595, 656`); per-edge geo-penalty
cache + half-cell course decimation + chord cache (`:651-741`); ordering cap (6→2) above 400
edges (`:1653`); stop-early ordering comparison; A\* stale-entry skip + target early-exit.
No memoization of A\* *paths* across local-search trials, though — every trial re-routes
from scratch.

### 6.6 Scaling levers (in order of impact)

| Lever | Where | Effect |
|---|---|---|
| `cellSize` / `divisor` (`OCTI_DIVISOR`) | `renderGeographic.ts:727-730` | **master lever** — cost ~`1/cellSize²` via `G`. Code already coarsens for big graphs: divisor `1.2` when `support.edges.size > 800`, else `1.6`. |
| `locSearchIters` | `octi.ts:57` | linear multiplier on the dominant term (default 100; convergence usually cuts it short). |
| ordering cap | `octi.ts:1653` | drops initial passes 6→2 above 400 edges. |
| `maxGrDist` | `gridGraph.ts:532` | candidate box `(2·d+1)²` cells/node; also dilates routable corridor. |
| retry shrink | `octi.ts:1416` | each of ≤3 retries rebuilds a *larger* grid and re-runs everything — a hidden multiplier on pathological inputs. |

---

### 6.7 Shipped optimization — A\* heap (output-identical, ~29% octi)

The A\* binary heap in `route` (`gridGraph.ts`) sifted with array-destructuring swaps
(`[heapF[p], heapF[i]] = [heapF[i], heapF[p]]`), which allocate a throwaway array **per
swap** in the innermost loop of the most-called function in the pipeline, and reallocated
the two heap backing arrays on **every** `route()` call. Replacing the swaps with
temporary-variable swaps and reusing two instance-level heap arrays (truncated per call;
`route` is non-reentrant) cut octi from a **median 3321ms → 2342ms (~29%)** on the NYC
dump, with a **bit-identical layout checksum** — a binary heap with temp-var swaps pops in
exactly the same order, so the routed paths and node placements are unchanged. This is the
ideal kind of octi optimization: pure constant-factor, zero output change, so the
determinism guarantee (offline == in-game) is preserved.

Rejected as too risky for the determinism guarantee: eliding the `Drawing.clone()` calls in
the local-search trial loop via draw-and-undo (`drawOrder` has many partial-failure paths
whose exact undo is error-prone), and capping the initial-draw ordering count (changes
which ordering wins, hence the layout). Clones were also not the dominant cost — GC was
only ~7% of the profile.

## 7. Coincident-path merge (`imageMerge.ts`)

`mergeCoincidentPaths` (`imageMerge.ts`) rebuilds the support graph from drawn pixel
geometry so two corridors octi placed on the same grid lane become one bundled edge.

**Detection is hash-based, `O(E·P)` — not pairwise `O(E²·P)`.** Each drawn segment is
canonicalized to a `segKey` over lattice-quantized endpoints, and a
`segOwners: Map<segKey, Set<edgeId>>` (`:84`) records which edges drew each physical
segment. A lattice pre-split (`splitAtLattice`, `:48-71`) forces vertices onto absolute
lattice multiples so coincident geometry with different vertex phase still hashes
identically. Five linear passes (split → owner map → run-build → materialize → remap
traversals), all `O(E·P)` or `O(T)`.

- **Worst-case term:** `mapOldNode` (`:245-259`) — when a node's vertex was dropped by
  every run it falls into a nearest-node scan over **all** new nodes, called per station
  and per stop → `O((stations + stops)·N)` degenerate. Common case is an `O(1)` map hit.
- `separateFusedStations` re-splits station groups that octi fused onto one node; per split
  it does a bounded BFS + an `O(T)` traversal rewrite, so `O(splits·(candEdges·P + T))`.
- **Allocations:** `ownersKeyOf` (`:109`) does a spread+`sort`+`join` **every call** in the
  run-builder; heavy `.slice()` / `.map(p => p.slice())` path copies at `:180, 196, 285`.

---

## 8. Line ordering & untangle  ⟨deep dive on untangle⟩

### 8.1 `orderLines` — barycenter seeding (`lineOrder.ts`)

A position-blind barycenter sweep: up to **6 fixed passes** (`:21`), each averaging every
line's index across the other edges at each node and re-sorting. Early-out when a pass
changes nothing (`:54`). **Heuristic, not combinatorial.** The hot kernel is an
`other.lineOrder.indexOf(line.id)` (`:33`) — an `O(b)` scan — nested inside
node × edge × line × other-edge, giving **`O(6 · deg_max · E · b²)`**. Allocations: a
`new Map` per edge per pass (`:26`), plus `[...lineOrder].sort()` and two `join(',')`
strings per edge per pass for change detection.

### 8.2 `untangleLineOrder` — local-search crossing/separation minimizer (`untangle.ts`)

The real optimizer; overrides the barycenter seed. Pipeline: build adjacency → **contract**
deg-2 same-line runs into `OptEdge`s (`:134-166`) → up to **4 rounds** of Y/dogbone trunk
splits (`:250-254`) → corner-weight + `connOccurs` caches → **connected components over
multi-line edges only** (`:647-671`) → optimize each component → write back.

Per component, the optimizer **branches on solution-space size**:

- **Exhaustive (factorial)** when `solSpace = Π factorial(bᵢ) < 500`
  (`EXHAUSTIVE_SOL_SPACE`, `:77`, `:706-736`): a Cartesian odometer over the product of
  per-edge permutations. `permutations` materializes all `b!` orderings per edge. Hard-capped
  at 500, so **not** the asymptotic worst case.
- **Hill climbing** otherwise (`:744-783`): an **unbounded `for(;;)` loop** applying the
  single best improving move until none exists, run up to 4 times per component (barycenter
  basin `:820`, family-sorted basin `:824`, and one grouped-seed restart **per station** in
  the component `:861`).

**Worst-case term — the hill-climb move evaluation.** Each candidate move calls `edgeScore`
→ two `nodeScore` (`:494-516`, `O(deg²)`), and the innermost `inversions` (`:89-95`) is
`O(b²)`. One pass enumerates `O(b²)` swaps + `O(b²)` insertions per edge. Net:

> **≈ `O(stations_comp · I · m · b⁴ · deg²)`** per hill component (`I` = unbounded improving
> iterations, `m` = multi-edges in the component) — quartic in bundle width.

In practice this almost never bites, because component decomposition (`:647`), partner-block
collapse (`:345-374`), and the 500-cap exhaustive fallback keep `m`, `b`, and `solSpace`
tiny. `crossSepsPair` (`:448-452`) allocates a `rank` Map + two arrays on every call, called
`O(deg²)` times per move per iteration. (`OCTI_NO_UNTANGLE=1` keeps the barycenter order, a
useful A/B for isolating its cost.)

**✅ Shipped win — hoist the `rank` map out of the pair loop (output-identical, ~8%).**
`crossSepsPair` rebuilt its `rank` `Map` for every **(ea, eb) pair** — `deg²` Map
allocations per `nodeScore`, on the metro-scale hot path — but the rank depends only on
`ea`'s order; the pair-specific `rev` flag merely flips the index sign (`rev ? L-1-i : i`).
Inlining `crossSepsPair` into `nodeScore` and building `rank` **once per `ea`** (`deg`
builds, not `deg²`), with the sign flip applied per pair, keeps the per-pair values, the
accumulation order, and thus the score **bit-identical** while cutting Map allocations by a
factor of `deg`. Measured **~8% off untangle** (median ~4450ms → ~4149ms, OPT < BASE in all
3 interleaved rounds; checksum `fnv=23531b58` unchanged).

**What did NOT work — scratch *reuse*.** Reusing the `crossSepsPair`/`diffSweep` buffers via
`Map.clear()` + hoisted arrays (the literal "same idea" as the octi heap fix) **regressed
untangle ~10–15%** under the same A/B. The distinction matters: *fewer fresh allocations*
helps; *reusing* a shared buffer hurts, because (1) V8 already allocates these tiny
short-lived `Map`s very cheaply in the young generation and a cleared-and-refilled `Map` is
*more* work (risking dictionary-mode), and (2) hoisting a mutable buffer to closure scope
defeats V8's optimization of the hot inner functions. GC was only ~7% of the profile, so
the residual time is genuinely the `O(deg²·b²)` loops + `inversions` over the unbounded hill
climb — a further win needs incremental scoring (see §11 #1), which is float-order-sensitive
and must stay bit-identical.

### 8.3 `offsets.ts` — per-edge lane offsets

`computeCanonicalOffsets` assigns each line a stable signed lane. The dominant term is the
**`O(E·b²)` co-runner neighbour-set construction** (`:200-208`, a double loop over each
edge's lines), followed by a bounded 32-step de-collision shift per line (`:216-236`). The
geometry helpers (`offsetPolyline`, `simplifyPolyline`, `taperLaneEnd`) are `O(P)` per
polyline, `O(E·P)` aggregate. Allocations: one `Set` per line plus an entry per co-running
pair (`O(E·b²)` inserts), and a fresh `Pixel[]` per offset polyline.

---

## 9. The light half — `drawSmoothed` → `renderRibbons` (`renderOctilinear.ts`)

This is the cacheable redraw (re-runs on label/station toggles only). **It is genuinely
cheap relative to octi** — strictly linear geometry plus bounded per-station work, no graph
search, no 100-sweep relaxation.

### 9.1 Linear geometry

The ribbon geometry is **`O(E·b·V)`**: one `offsetPolyline` per (edge, line)
(`renderOctilinear.ts:345-359`) and one path-token push per vertex (`emitLanes`/`pushSeg`).
The lane-continuity bias relaxation is a **fixed 12-pass** Gauss-Seidel with early-out
(`:318-342`). There is **no `O(E²)` or `O(L²)` global pass.** String building uses
`string[]` + `join` (`dByLine` push `:217/234/612/1850`, joined once at `:1885`; parts
joined at `:1970-1973`) — **no quadratic `+=` accumulation** on the hot path (the only `+=`
is in `waterBackdrop`, run once). Every coordinate is `toFixed(1)`-formatted —
`O(E·b·V)` string allocations, the bulk format cost.

### 9.2 Station placement — bounded superlinear work

The only superlinear work is per-station and bounded:

- **Rigid-row solve** (`solveRows`, `rowPlace.ts:115`): `buildStates` enumerates
  `(2·arcLimit/step+1) × 4` ≈ **388 states per bundle**; the pairing solve is exhaustive
  `g!·2^g` (`:432-450`) but `g` (distinct run-axes at one node) is almost always 1–3.
  Bounded per station, not global.
- **Cross-station collision** is **pairwise, not spatial.** The `blocked` mask
  (`:1011`) tests each candidate dot against all placed dots → the placement loop is
  `O(N · totalDots)`. The mutual capsule slide (`:1440-1490`) is **`MAX_SWEEPS = 3`** sweeps
  of an all-pairs `O(S²)` loop with tiny hull constants.

### 9.3 The one real implementation artifact — repeated full-edge scans

The pattern `for (const e of layout.edges) if (e.from === nid || e.to === nid)` — a linear
scan of **all** edges to find a node's incident edges — recurs ~8 times
(`renderOctilinear.ts:806, 857, 940, 1141, 1232, 1387, 1574, 1655`), several **inside
per-station loops**, making the station sub-stage effectively `O(N·b·E)` instead of
`O(N·b·deg)`. A precomputed `incidentEdgesByNode: Map<string, Edge[]>` collapses every one
of these to `O(degree)`. This is the part of the light half most likely to show in a
profile on large dense maps — a pure artifact, not algorithmic necessity.

> Note: `MEGA_BOXES = false` (`constants.ts:65`) makes the mega-box detection and
> mega-escape slide loop (`renderOctilinear.ts:839, 1114-1157`) **dead at runtime** (empty
> `megas`), removing a whole `O(N·megas)` layer from the live path.

---

## 10. Complexity summary

| Stage | Dominant term | Iteration model | Cost rank |
|---|---|---|---|
| Graph build (§3) | `O(routes·visits + E·L)` | single pass | negligible |
| Density warp (§4) | build `O(S + B²·r)`; **eval `O(1)`/pt** (default) | one pass (`2d`: 10 iters) | low (ms) |
| Topo merge (§5) | merge `O(R·E·S)`; **re-insert `O(N·nodes)`** | ≤8 rounds + brute scans | medium |
| **Octilinearizer (§6)** | **`O(iters·E·G)`, `G ∝ 1/cellSize²`** | **≤100 sweeps × ~19·E A\*** | **dominant** |
| Coincident merge (§7) | `O(E·P)` hashing | single pass | low |
| `orderLines` (§8.1) | `O(6·deg·E·b²)` | ≤6 sweeps | low |
| `untangleLineOrder` (§8.2) | `O(stations·I·m·b⁴·deg²)` | unbounded hill-climb, decomposed | medium (rare) |
| `offsets` (§8.3) | `O(E·b²)` | single pass | low |
| `renderRibbons` (§9) | `O(E·b·V)` + `O(N²)` placement | 12 + 3 fixed sweeps | low (cacheable) |

---

## 11. Optimization opportunities (ranked by expected payoff)

0. **✅ DONE — A\* heap micro-opt (§6.7).** Output-identical, ~29% octi speedup on NYC.
1. **Untangle hill-climb (§8.2) — the metro-scale bottleneck (~50%).** Per §2.1,
   `untangleLineOrder` is the largest single stage on the NYC dump. **Partially addressed:**
   the `rank`-hoist (§8.2) took ~8% off, bit-identical. The remaining lever is **incremental
   scoring**: the hill climb (`untangle.ts:744-783`) recomputes `nodeScore` for every
   candidate move, but only the `crossSepsPair` terms *involving the changed edge* differ
   between trials — the rest is invariant. Reusing those invariant pair-scores would cut the
   `O(deg²·b²)` per-trial cost to `O(deg·b²)` (a factor of `deg`). The catch: it is
   **float-order-sensitive** — `nodeScore` sums non-representable terms (`r.cross ×
   {0.15,0.5,6}`), so a split/partial re-sum can differ by an ULP and flip a hill-climb
   tie-break, changing the layout. A bit-identical version must cache `crossSepsPair`
   *results* (not partial sums) keyed by the two edges' orders, with invalidation that
   accounts for the **in-place** order mutation in the swap loop (`untangle.ts:754`).
   Higher effort and risk; deliberate change, not a micro-opt. *Highest remaining payoff.*
2. **Octi `Drawing.clone()` (§6.4).** Millions of 9-Map deep clones inside the trial loops
   are the top *allocation* cost. A copy-on-write / delta-undo scheme would remove most of
   it — but `drawOrder`'s partial-failure paths make a correct, bit-identical undo
   delicate, so it needs care to preserve determinism.
2. **Octi grid size (§6.2/6.6).** `cellSize` is quadratic. The adaptive divisor already
   coarsens big graphs; revisiting the thresholds (and capping `G` for huge bus networks)
   directly attacks the `~1/cellSize²` term.
3. **Topo re-insertion via the existing index (§5.3).** `freezeBuilder` already builds a
   populated `NodeIndex(50)` that the `O(N·nodes)` station/stop scans never use. Routing
   them through it turns the topo dominator from quadratic to near-linear.
4. **`incidentEdgesByNode` map (§9.3).** One precomputed map removes ~8 full-edge scans in
   `renderRibbons` (several inside per-station loops), cheapening the cacheable redraw.
5. **`id→edge` map in graph/topo (§3).** Kills the `O(N·E)` `g.edges.find(...)` scans
   (`isMergeAnchor`, traversal reconstruction).
6. **A\* heap micro-allocations (§6.4).** Replace the array-destructuring swap inside the
   heap with index swaps to drop a per-swap temp-array allocation in the innermost loop.

The first two dwarf the rest — octi is the pipeline. Everything below #2 is worth doing for
robustness on large networks but won't move the headline number.
