# Hub Split + Capsule Reunite — Design

**Date:** 2026-06-14
**Status:** Draft for review.
**Relates to:**
- **Sibling — `interchange-decomposition` (2026-06-13).** That pass splits a junction node into a chain of sub-nodes *along the corridor* to give line **ordering** a place to change (destination-grouping / anti-braid). This pass splits a high-degree hub **perpendicular** to its line bundle to reduce **degree / congestion**. They share the same primitives (sub-node decomposition joined by internal edges, a capsule spanning the chain, internal edges that must survive octi/merge) and could eventually unify, but their *axis* and *motivation* differ. See §7.
- **Rigid-row markers (2026-06-12)** — C3 reuses its multi-segment capsule-join machinery.
- **Density warp (`densityWarp.ts`)** — C1 extends its sample weighting.
- **`ghostNodes.splitHighRouteNodes` (`ghostNodes.ts`)** — the existing (cardinal-bucket, routing-only, invisible) node split; this is a station-aware, binary, capsule-reunited generalization. The new pass does **not** modify it.

## 1. Problem

High-degree hubs are the pipeline's worst-rendering nodes, and for several reasons at once:

- **octi grid saturation.** `OctiGridGraph` has 8 ports per cell; `getCands` caps required free directions at `min(8, deg)`. A node with degree > 8 cannot place all edges octilinearly → SOFT_INF violations, then `imageMerge` bundles the overflow → lines lose independence (kinks, hidden lines).
- **Mega-box fallback.** A station with `members > 1 && ldeg >= 12`, or where `solveRows` finds no feasible rigid-row, falls back to a featureless mega box (no bullets). These are the dense interchanges (NYC midtown, Flatbush; Seattle downtown).
- **Congestion.** Dense hub areas are geographically cramped; the lines have no room.
- **Marker legibility.** Even below the box threshold, a hub with many bullets reads as a tangle rather than a clean interchange.

The user wants one mechanism that addresses all four: **split a high-degree vertex into smaller sub-nodes, let the density expansion give them room, and — if the vertex is a station — reunite the sub-nodes under one capsule** so the interchange still reads as a single place.

## 2. The model

Three cooperating pieces, none of which touch topo's internals (the most fragile stage):

1. **C1 — Global breathe (warp weighting).** Weight the density-warp samples by how much each hub is about to expand, so the global monotone warp dilates around it. (The warp is a position→position map; it cannot pull *coincident* points apart, but it *can* dilate a region whose sample density rises — which is exactly what splitting will do there.)
2. **C2 — `splitHubs` pass.** On the merged support graph, recursively split each high-degree vertex **into two**, **perpendicular to its dominant line direction**, dividing the bundle by lateral line order (the "4 and 5"). Joins the halves with an internal **spine** edge; tags the sub-nodes with a shared `splitGroup`.
3. **C3 — Capsule reunite.** At render, a station's marker is one capsule spanning its `splitGroup`'s sub-nodes, drawn across the bundle (⟂ to the lines), reusing the rigid-row joint machinery.

### 2.1 Binary, recursive, perpendicular

- **Binary:** each split produces exactly two sub-nodes. A still-too-dense sub-node splits again (perpendicular to *its* dominant axis), so a 4-way cross splits once per axis. Recursion is bounded by the original degree and terminates when both sub-nodes are under the caps (§3.2) or no progress-making cut exists.
- **Perpendicular to the dominant axis:** the split offset is ⟂ to the hub's heaviest line bundle (the trunk). Sub-nodes stack *across* the tracks, and the spine/capsule runs across the bundle — matching how real interchange capsules are drawn. (This is the user's correction to an earlier angular-gap-cut idea, which would have grouped edges by sector instead of dividing the bundle.)

### 2.2 Line-level partition (worked: a 9-line trunk → 4/5)

A hub where 9 lines arrive bundled "from the right" and fan out to many directions:

1. **Dominant axis `A`** = the bearing carrying the most line-weight (the east trunk).
2. **Hub-local lateral order** (§3.3): sort the 9 through-lines by their *exit bearing* relative to `A` — lines leaving "up" sort to the top of the bundle, "down" to the bottom. This is a local, single-hub analogue of `orderLines`, computed at split time because the global `orderLines` runs *after* octi.
3. **Partition at the count midpoint:** top 4 → sub-node `+` (offset `+perp(A)`), bottom 5 → sub-node `−` (offset `−perp(A)`).
4. **Fan, don't fork-into-coincidence:** keep the trunk edge intact to a retained fork point `H`; add short internal fan edges `H→+` (top 4 lines) and `H→−` (bottom 5). Outgoing edges attach to `+` or `−` by which lines they carry; a *straddling* outgoing edge divides the same way. No two coincident parallel trunk edges are ever created (which is what would otherwise be re-consolidated by `imageMerge`).
5. **Spine** edge `+`—`−` carries any line that enters on one sub-node and exits the other; it is the capsule axis (⟂ `A`).

Because the lateral order is by exit direction, an outgoing edge's lines are contiguous in the order and rarely straddle — the fan stays planar.

### 2.3 C1 — global breathe (detail)

Today each graph node contributes `min(4, linesThrough)` warp samples (`renderGeographic.ts` ~444–454, computed just before `buildDensityWarp`). Change: a node that meets the split predicate contributes `min(WARP_CAP, expectedLeaves(n))` samples instead, where `expectedLeaves(n) ≈ ceil(ldeg(n) / TARGET_LINES_PER_LEAF)` (how many sub-nodes the hub is expected to split into) and `WARP_CAP ≈ 10`. Busier hubs ⇒ more samples ⇒ the monotone per-axis CDF warp dilates that region in proportion to how much it is about to expand. This is the only change C1 needs; C2 then positions sub-nodes into the opened room.

`expectedLeaves` is estimated from the transit-graph line-degree (the warp runs *pre-topo*); the exact split count is recomputed on the support graph in C2 — the estimate only needs to be directionally right to breathe. It cannot pull coincident points apart (the warp is injective per axis) — it only redistributes empty space, which is why the structural offset (`OFFSET`, §3.2) is what actually seeds distinct cells.

## 3. C2 — the `splitHubs` pass (detail)

New module `src/render/layout/splitHubs.ts`, exporting `splitHubs(h: SupportGraph, opts): SupportGraph`. Called in `precomputeSmoothed` (`renderGeographic.ts`) **after** `buildSupportGraph` (~line 497) and **before** `octi(support, …)` (~line 579). Deterministic: fixed node iteration, no randomness.

### 3.1 Per-hub procedure

```
for n in nodes where splitDeg(n) over a cap (largest-degree first):
    splitNode(n, originId = stationIdAt(n) ?? n.id)

splitNode(n, originId):
    if splitDeg(n) <= caps OR no progress-making cut: return
    A   = dominantAxis(n)                 # bearing of max line-weight (§3.2)
    ord = hubLocalOrder(n, A)             # through-lines sorted by exit bearing (§3.3)
    (top, bot) = splitAtCountMidpoint(ord)
    p  = n.pos
    nPlus  = newNode(p + OFFSET*perp(A), splitGroup=originId)
    nMinus = newNode(p - OFFSET*perp(A), splitGroup=originId)
    H = n  (retained fork point at p; degree drops to trunk + 2 fan edges)
    addFanEdge(H, nPlus,  lineIds=top, splitInternal=true)
    addFanEdge(H, nMinus, lineIds=bot, splitInternal=true)
    reattach each non-trunk incident edge to nPlus/nMinus by its lines’ side;
        split a straddling edge into a +part and a −part (lines partitioned)
    addEdge(nPlus, nMinus, lineIds = lines that enter one side and exit the other,
            splitInternal=true)           # the spine
    if originId is a station: repoint SupportStation to the splitGroup (§4, §5)
    splitNode(nPlus, originId); splitNode(nMinus, originId)
```

### 3.2 Caps and dominant axis

- **Split while EITHER cap is exceeded:** topological degree `splitDeg(n) > DEG_CAP` (default **5** — keeps octi's 8 ports unsaturated with slack) **or** line-degree `ldeg(n) > LDEG_CAP` (default **6** — keeps each capsule segment a clean rigid-row). Both env-overridable (`OCTI_SPLIT_DEGCAP`, `OCTI_SPLIT_LDEGCAP`), matching the pipeline's knob convention.
- **`dominantAxis(n)`** = the incident-edge bearing direction carrying the most line-weight (sum of `|lineIds|` over edges within an angular tolerance). Ties (a balanced cross) → pick deterministically (e.g. smallest bearing); recursion handles the other axis.
- **`OFFSET`** = a small fraction of grid spacing (default ~0.5 cell). It only needs to seed distinct grid cells; C1's breathe supplies the real room, and octi snaps the seeds to cells.

### 3.3 Hub-local lateral order

`hubLocalOrder(n, A)` returns the through-lines sorted by the signed projection of each line's **exit bearing** onto `perp(A)`. The exit bearing of a line at `n` is the direction of the incident edge it leaves on, excluding the trunk side. This is a one-node barycentric sort (the same principle as `orderLines`/untangle, scoped to `n`), chosen so that the perpendicular partition is planar and minimizes straddling edges. Lines sharing an exit edge keep that edge's internal order if known, else tie-break by bearing.

### 3.4 Guards (the critical correctness work)

A binary leaf can be topological degree 2 (one external + the spine, or fan + spine), which downstream passes would collapse — silently reverting the split. Required guards:

- **`octi.combineDeg2`** (`octi.ts` ~409) and **`octi.contractShortEdges`** (~107–145): skip any node with `splitGroup` set and any edge with `splitInternal` (extend the existing station-node guard pattern at ~142–145).
- **`imageMerge.mergeCoincidentPaths`** (`imageMerge.ts` ~73): preserve `splitGroup` sub-nodes via the existing `nodeVerts` mechanism (~115), as it already does for stations.
- **`imageMerge.separateFusedStations`** (~319): must not re-fuse `splitGroup` siblings.

These guards are the #1 risk and get dedicated tests (§8).

## 4. C3 — capsule reunite (render)

Today `StMarks` (`renderOctilinear.ts` ~562) references a single `nodeId`; `gathered` (~575–587) builds one per `SupportStation`. Generalize:

- `StMarks.nodeId: string` → `nodeIds: string[]` = the `splitGroup`'s leaf nodes (plus carry `splitGroup`).
- Gather marks from **all** leaf nodes (each leaf's per-line bullets at its `flagNode`, as now).
- Run the existing `solveRows` over the **union** of marks → one elongated octilinear capsule whose spine follows the split's spine/fan edges (already drawn as short bundles via `segPath`). Reuses the multi-segment capsule-join (rigid-row spec; 22 St elbow, Atlantic Av multi-arm).
- `boxOf`/collision/mega-fallback (`renderOctilinear.ts` ~602, `stops.ts` ~89) computed across the union; if `solveRows` still fails, the whole `splitGroup` falls back to one mega box (honest residual).
- **Non-station** high-degree junctions also split (helps octi routing) but get **no** capsule — their spine/fan edges render as ordinary short bundles.

No new marker math — the chain is just more sub-nodes for the existing capsule-join to span (same conclusion as the sibling spec §4).

## 5. Data-model changes

In `src/render/layout/types.ts`:
- `SupportNode` (~113): add `splitGroup?: string`.
- `SupportEdge` (~120): add `splitInternal?: boolean`.
- `SupportStation` (~129): add `splitNodeIds?: string[]` (the leaves); keep `nodeId` as the primary anchor for back-compat.
- `LayoutNode` (~59): add `splitGroup?: string` (carried through octi so the renderer can group).
- `StMarks` (`renderOctilinear.ts` ~562): `nodeId: string` → `nodeIds: string[]` (+ `splitGroup`).

## 6. Edge cases & fallbacks

- **Degenerate hub** (≤1 through-line, or every line on one edge that cannot fan because the lines all exit the same single edge): no progress-making cut → return unchanged; residual mega box. Line-level fanning shrinks this to the genuinely-1-line case (much rarer than edge-level would leave).
- **Deg-2 leaves vs `combineDeg2`:** the §3.4 guard must be airtight or the split silently reverts.
- **Hub-local vs global order disagreement:** the local order (§3.3) is a heuristic; if the post-octi global `orderLines` disagrees, a residual crossing can appear at the fan. Mitigation: seed `orderLines` from the split's local order at split-group boundaries, or accept a rare minor crossing (quantify in Phase 0).
- **Off by default behind `OCTI_SPLIT_HUBS`** until validated, like every prior pipeline lever.
- **Cost:** node/edge count grows at hubs; bound and log the render-time delta (same concern as sibling §6).

## 7. Relationship to `interchange-decomposition`

Both decompose an interchange node into sub-nodes joined by internal edges and span them with one capsule. They differ on **axis** and **why**:

| | interchange-decomposition (2026-06-13) | hub-split (this) |
|---|---|---|
| Axis | **Along** the corridor (reorder-node on approach + split-nodes in sequence) | **Perpendicular** to the bundle (stack ⟂ the trunk) |
| Motivation | Line **ordering** (destination-grouping, anti-braid) | **Degree / congestion** (mega-box, octi saturation, room) |
| Trigger | Conflicted order at a junction | High degree / ldeg |

They are compatible and complementary: a real interchange may want both (peel contiguous bands *and* divide a fat parallel bundle across platforms). For now they are **separate passes** with shared primitives; unifying them into one "interchange decomposition" with two split kinds is a future consolidation, not in scope here. If both ship, run order and guard interaction must be specified (open question, §9).

## 8. Verification & phasing

- **Phase 0 — feasibility probe (no ship, go/no-go).** In a dev probe, hand-split one dense hub (e.g. an NYC midtown interchange or Flatbush) post-`buildSupportGraph`: perpendicular binary split with the §3.3 local order, fan representation, `splitGroup` tags + guards; run octi + render. Confirm: (a) the guards hold (split survives `combineDeg2`/`imageMerge` — degree-2 leaf not collapsed); (b) octi places the sub-nodes without new violations; (c) the capsule spans the group and reads as one interchange. If the guards can't hold the split, stop before investing.
- **Phase 1 — C1 breathe.** Warp-sample weighting only; extend `densityWarp.test.ts` (busier hub ⇒ strictly more local dilation); render to confirm hubs get room with no fold (warp stays monotone).
- **Phase 2 — `splitHubs` pass + guards.** Implement C2 with unit tests (§ below); gates on both maps; **success metric = mega-box count drops** with no new octi/seating/overdraw/markerfit violations.
- **Phase 3 — capsule reunite + residual box + ship.** C3 spanning; un-splittable hubs box; full sweep; ship behind the flag, then default-on after sign-off.
- **Unit tests** (`splitHubs.test.ts`): dominant-axis selection; hub-local order (exit-bearing sort); perpendicular partition at count midpoint (the 4/5); fan/spine line assignment (through-lines only on the spine; straddle split correct); recursion termination; degenerate-hub no-op; `splitGroup`/`splitInternal` tagging. Plus a guard test: a degree-2 split leaf survives `octi.combineDeg2`.
- **Gates (both maps, unchanged thresholds):** octi 0 non-octilinear, seating 0 off-lane, overdraw OK, markerfit 0 bad. Named crops: NYC midtown + Flatbush + Park Av, Seattle downtown (targets: box→capsule); 22 St, St Lukes, 307/320 Pl (no regression).
- **Risk:** topology surgery + octi/merge guards are the highest-leverage, highest-risk layer (the `separateFusedStations` history shows the clamp subtleties). Phase 0 must pass convincingly before Phase 2.

## 9. Open questions

- **Dominant-axis tie-break** at balanced crosses — confirm the deterministic rule reads well after recursion.
- **`OFFSET` magnitude** vs the breathe — too small and octi can't separate the cells; too large and the capsule looks stretched. Tune in Phase 2.
- **Local↔global order reconciliation** (§6) — measure disagreement frequency in Phase 0; decide seed-vs-accept.
- **Coexistence with `interchange-decomposition`** if both ship — run order, shared `splitGroup`/`splitInternal` semantics, guard interaction.
- **Cost bound** — node/edge growth at the densest interchanges.

## 10. Out of scope

- No change to topo's internal stages (Approach B keeps the split entirely post-topo).
- No change to `orderLines`/untangle's objective (the local order is a private, split-time computation; reconciliation is the only touchpoint).
- No modification of `ghostNodes.splitHighRouteNodes` (left as-is; this is a parallel, station-aware mechanism).
- No unification with `interchange-decomposition` (future).
