# Per-Segment Line Ordering (Crossings Off Stations) — Design

**Date:** 2026-06-13
**Status:** Approved direction (user chose the general per-segment / LOOM line-bend model); spec pending review, implementation is its own dedicated multi-phase effort.
**Relates to:** the rigid-row marker model (`2026-06-12-rigid-row-markers-design.md`). This spec does NOT change the marker — it changes the lane routing the marker reads.

## 1. Problem

Station markers at junction interchanges show foreign lines threaded into color families and bundle lanes crossing under the marker (NYC 3 St: purple **9** between reds 4/3; Flatbush Av: gray **Y** / purple **9** / gray **Z** interleaved into the green 6/5/8/7 family; Park Av; Wythe Av). Because the rigid-row marker places every dot exactly on its drawn lane (the on-lane invariant, R2 of the rigid-row spec), the marker faithfully reproduces whatever the lanes do — so these crossings are a **lane-routing** artifact, not a marker artifact.

**Root cause (diagnosed v0.2.45):** every edge in the layout carries a single `lineOrder` for its entire length — lines never change relative position within an edge. A crossing can therefore only occur where two edges meet, i.e. **at a node**, and nodes are exactly where stations sit. The current model *forces every crossing onto a station*. At 3 St the edge order is already optimal (`[9,1,4,3,2]`, reds contiguous, colorFrag 0) and raising `colorFragPen`→100 or the in-station crossing penalty→120 has zero effect — there is no order that avoids the crossing because the bundle *splits* (1,2 exit horizontal; 9,4,3 exit 45°) and line 1 sits between 9 and 4, so the lanes cross as they fan out, on the station. "Save swaps for corners" is impossible today because a swap cannot occur mid-edge.

## 2. The model

Let each edge `E` (a corridor between two layout nodes, with polyline geometry and a line set `E.lines`) carry **two** orderings instead of one:

- `orderFrom: string[]` — the lateral order of `E.lines` at the `E.from` endpoint.
- `orderTo: string[]` — the lateral order of `E.lines` at the `E.to` endpoint.

Both are permutations of `E.lines`. The **crossings along E** are exactly the inversions of the permutation mapping `orderFrom → orderTo`: each adjacent transposition needed to turn one into the other is one line-crossing, drawn at a bend on open track. An edge with `orderFrom === orderTo` has zero internal crossings (today's behavior).

### 2.1 Node planarity (the core constraint)

At a node `N` with incident edges `e₁…eₖ` arranged by their octilinear exit angle around `N`, each line through `N` enters on one edge and leaves on another (or terminates). Reading each edge's order **at N** gives a circular sequence of line-slots around `N`. A line that transitions from edge `A` to edge `B` is a chord between its slot on `A` and its slot on `B`. **Two lines cross at `N` iff their chords cross on the circle.**

A node routing is **planar** (no crossing at `N`) iff:
- lines sharing the same `A→B` transition form a **contiguous block** in both `A`'s order-at-N and `B`'s order-at-N, and
- the transition-blocks are arranged in a radial order around `N` consistent with the edges' angular positions (the standard non-crossing circular-matching condition; this is LOOM's "inner node geometry").

Planarity is the formal statement of "keep bundles together when we join them": co-traveling lines stay an adjacent block through the station.

### 2.2 Objective

Choose endpoint orders for all edges to **minimize total edge-internal crossings** (Σ inversions over edges), weighted to prefer placing each crossing on a segment with a bend / longer open track, **subject to node planarity** enforced as hard where achievable. Where a node's local structure is genuinely non-planar (a line must cross *at* the node), that residual node-crossing is allowed, counted, and penalized — and is exactly the case the mega box honestly represents (§5).

This is the LOOM transit-map line-ordering problem (the piece we did not port). It is NP-hard in general; we solve it heuristically at our scale (§3).

## 3. Optimizer (untangle.ts rewrite)

The current `untangleLineOrder` minimizes node crossings over a single per-edge order via OptGraph rewrites (Y/dogbone), colorFragPen, cornerTurnFactor, two-basin hill climb. The rewrite changes the variable from "one order per edge" to "an order per edge endpoint," and the objective from "minimize node crossings" to "minimize edge crossings subject to node planarity."

Heuristic (tractable at hundreds of edges):

1. **Seed:** run the existing untangle to get a good single order per edge; set `orderFrom = orderTo =` that order. Zero edge crossings, node crossings present (today's state).
2. **Node-planar pass:** for each node `N`, group its through-lines by `A→B` transition, order the transition-blocks radially by destination angle, and order lines within a block to match the neighbor's block. This yields a **desired order-at-N** for each incident edge — planar by construction.
3. **Reconcile:** an edge `E`'s desired-order-at-`from` (from node F's pass) and desired-order-at-`to` (from node T's pass) may differ; that difference becomes `E`'s internal crossings. Set `orderFrom`/`orderTo` to the two desired orders.
4. **Iterate / hill-climb:** nodes are coupled through shared edges; iterate the node-planar pass and adjust radial block orders to minimize total edge crossings (and to keep colorFrag families contiguous within blocks as a tiebreak, reusing the existing colorFrag scorer). Keep the two-basin / best-keep structure of the current optimizer.
5. **Residual:** nodes that cannot be made planar (non-planar local matching) keep a node crossing; flag the node `nonPlanar` for the box fallback (§5).

Determinism preserved (fixed node/edge iteration order, no randomness). The existing untangle tests (Y rotation canary, mirrored-Y, cornerTurnFactor) are re-homed or replaced; new tests assert node planarity and edge-crossing minimality on synthetic junctions.

## 4. Rendering (renderRibbons)

For edge `E`, each line's lane is a polyline that starts at the lateral offset implied by `orderFrom` at `E.from` and ends at the offset implied by `orderTo` at `E.to`. Within a segment the offset is constant; it **steps laterally at swap points**. Swap placement:

- Decompose the `orderFrom→orderTo` permutation into adjacent transpositions; assign each transposition a position along the edge, **preferring interior bend vertices** of the edge polyline (a swap at a bend reads as the turn absorbing the crossing). Straight edges with no bend place swaps at evenly spaced points along the run (a clean X).
- Two lines swapping cross at exactly one point (a real, allowed crossing); they must never co-run at the same offset on a segment (that would be overdraw — the existing `_chk-overdraw` gate guards this; the swap must be an instantaneous crossing, not a shared lane).
- `segPath` (the per-line drawn polyline the marker reads) is produced from this stepping geometry. At the node endpoints the offsets are exactly `orderFrom`/`orderTo`, so the lanes arrive at the station in canonical planar order.

The corner-fillet / join machinery (SMOOTH_R, curveLaneJoin) is unchanged; swaps are new interior vertices it already handles.

## 5. Marker interaction (no marker change)

The rigid-row marker reads `segPath` at the node. Because lanes now arrive in canonical planar order, the dots are in clean split order and the interleaving disappears — no marker code changes. Mega boxes fire only for `nonPlanar` nodes (genuine unavoidable node crossings) plus the existing degenerate cases (coincident/pinching lanes). Boxes become rare and *meaningful*. The grouping, solver, corner recompute, and slide-box logic are untouched.

## 6. Verification

- **New gate** `dev/_chk-crossings.ts`: count crossings AT nodes (target: near zero, only `nonPlanar` residuals) vs crossings ON edges (the relocated swaps). Report both per render.
- **Existing gates** unchanged: octi (0 non-octilinear), seating (0 dots >2px), markerfit (0 bad), overdraw (0 same-coord different-color — critical: swaps must not co-run).
- **Named-station crops** (dark+labels): 3 St, Flatbush Av, Park Av, Wythe Av (the targets) + 22 St, St Lukes, Central Park, J/D, terminus (no regression). Plus a full-map overview diff vs v0.2.45 — line re-flow is expected and broad; judge that crossings moved to bends and families read contiguous at stations.
- **Tests:** node-planarity + edge-crossing-minimality unit tests on synthetic junctions (Y split, X cross, 3-arm fan like 3 St); determinism; the rigid-row + chainPlace suites stay green.
- **Performance:** within ~1.5× current render time.

## 7. Phasing (each phase ships and is reversible)

1. **Plumbing:** edge gains `orderFrom`/`orderTo` (default both = current `lineOrder`); renderer draws permuting lanes with swaps at bends; with `orderFrom===orderTo` everywhere the output is byte-comparable to today. Validates rendering + segPath + overdraw with zero behavior change.
2. **Node-planar order:** the optimizer core (§3 steps 2–3) sets endpoint orders from node planarity. Crossings appear on edges; markers clean up. Gates + crops.
3. **Crossing minimization & placement:** §3 step 4 hill-climb to minimize total edge crossings; swap-placement tuning (best bends). Family-contiguity tiebreak.
4. **Residual → box + ship:** `nonPlanar` nodes box; new crossings gate; full sweep; tune; ship as the next minor version.

## 8. Out of scope / risks

- ILP-optimal ordering (LOOM's exact optimizer) — heuristic only; document the approximation.
- This re-flows every line map-wide and rewrites the finickiest subsystem (untangle) plus the ribbon renderer; high regression risk → the phased, gated rollout and full visual sweep are mandatory, not optional.
- Truly non-planar nodes remain boxed (accepted).
- Paper note: §2 (per-endpoint ordering, crossings as edge inversions, node planarity) is the formal core; pairs with the rigid-row paper as "where the lines cross" complementing "where the dots sit."
