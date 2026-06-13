# Interchange Decomposition (Reorder-Nodes + Split-Nodes) — Design

**Date:** 2026-06-13
**Status:** Draft for review. Supersedes the per-segment line-ordering effort (spec 2026-06-13-per-segment-line-ordering-design.md, implemented then reverted) as the approach to clean junction banding.
**Relates to:** the rigid-row marker model (2026-06-12) — this reuses its capsule-join machinery; and the topology passes `separateFusedStations` / `anchorGraphStops` (imageMerge.ts / topo.ts) — this is a sibling of those.

## 1. Problem

Junction markers braid: a band of lines that travel together gets *destination-braided* before it reaches a station, so the marker shows foreign lines threaded into families (NYC Flatbush: gray **Y** / purple **9** wedged among greens 5,6,7,8; 3 St: line **1** stranded between 9 and 4). The user wants the diagram ideal: **tight parallel bands, splitting into contiguous sub-bands, with crossings happening only as clean band-on-band X's — never line-by-line braids under a marker.**

**Root cause (proven, four ways).** Every layout edge carries ONE lateral order for its whole length. A band that splits *differently* at its two ends — e.g. Flatbush's trunk peels `{5,6}` off the station end and `{9}` off the other end, while the middle `{7,8}` vs `{Y,Z,9}` must split again one node further on — cannot be destination-clean at every node with a single order. We confirmed this is a **structural limit, not a tuning or search problem**:

1. Re-tuning untangle penalties (`colorFragPen`→100, `inStatCrossPen`→120): **zero effect** (the order is already a local optimum; same-color split-braids are invisible to `colorFrag`).
2. A per-segment two-order renderer (`orderFrom`/`orderTo`): worked in principle but forcing planarity on every edge **manufactured 76 (NYC) / 60 (SEA) crossings** map-wide — read as *busier*, a regression.
3. Minimal-intervention (planarize only station-incident edges): cleaned simple stations but **knotted or mega-boxed the dense fans** (3 St, Flatbush) — no bend near the marker to absorb the swap.
4. A `destFrag` objective term + a node-planar seed for untangle: the optimizer **reverts every coordinated seed** (planar seed scored 15× worse) because a globally-consistent single-order banding is internally inconsistent and creates crossings everywhere.

The common wall: **the order has to change somewhere, and a single node gives it nowhere to do so.**

## 2. The model: decompose the interchange into a node chain

Give the order a place to change by **splitting a conflicted junction node into a short chain of sub-nodes**, joined by tiny internal edges, so each sub-node hosts exactly one clean operation. Two kinds of sub-node:

- **Reorder-node** — a band's lines cross *within the corridor* to get into split order. One clean band-on-band X, on the **approach** (before the marker). The band enters and leaves *from the same direction* (it stays one coherent band; only the internal lateral order changes).
- **Split-node** — an already-clean band peels off a *contiguous* group to its own direction. No within-band crossing.

Invariants (the diagram, made structural):
- **R1 — bands enter coherent.** Every sub-node receives each incident band as a contiguous group arriving from one direction.
- **R2 — crossings are corridor-X's, pre-split.** A within-band reorder happens only at a reorder-node, drawn as a clean X on open corridor, always *before* the split that needs it.
- **R3 — markers see clean bands.** A split-node's (and therefore the marker's) incident orders are already destination-grouped; dots present as contiguous families.
- **R4 — the capsule spans the chain.** The station's marker is one capsule covering its split-node chain (and the immediately-adjacent reorder-nodes if they fall inside the marker footprint), so the decomposition reads as a single interchange.

Each internal edge carries ONE order and hosts ONE operation, so the single-order model is *sufficient per sub-edge* — the wall is gone because the order changes *between* sub-nodes, not within one.

### 2.0 Why untangle cooperates (the load-bearing mechanism)

The decomposition does not merely *permit* a clean band — it *motivates* untangle to produce one, by changing where the braid's crossing is counted:

- **Make the braid expensive.** The split-node where a band peels a group **is the station**. So a braided arrival (group not contiguous) forces a crossing *at the station* = `inStatCrossPen` (high). Today the same braid costs only cheap non-station crossings at the trunk's neighbors (mn59/mn152 at Flatbush), which is exactly why untangle never fixes it — decomposition removes that loophole.
- **Provide a cheap place to absorb it.** The reorder-node on the approach is a **non-station** node, so the relocated crossing there is cheap (`sameSegCrossPen`, and corner-discounted if it sits at a bend). untangle then *prefers* to reorder on the approach over braiding at the station.
- **Contraction exemption (required).** untangle contracts deg-2 same-line-set runs into one opt edge with one order. A reorder-node is deg-2 with the same line set on both sides, so it would be contracted away and the reorder could not happen. Reorder-nodes must therefore be flagged **contraction-exempt** (a forced opt-edge boundary) — a small, local change to the opt-graph build (`sameLineSet`/run-growth check skips flagged nodes). The crossing between its two opt edges is then scored normally (cheap, non-station), which is precisely the incentive above. This is the single most important thing Phase 0 must verify.

### 2.1 Flatbush, worked

Today (one node mn147, braided trunk `[6,5,Y,8,9,7,Z]`):
- trunk `{5,6,7,8,9,Y,Z}` ← mn59; peels `{5,6}`→Atlantic (S), `{7,8,9,Y,Z}`→mn152 (E); mn152 peels `{7,8}`→Ashland, `{9,Y,Z}`→Adelphi.

Decomposed:
1. **Reorder-node** on the NW approach: the greens arrive `[5,7,6,8]` from Monroe; 6↔7 cross (one X); 9 and the grays settle to the band ends → `[5,6,7,8,Y,Z,9]`. Still one band, still arriving from the NW.
2. **Split-node A = the marker (mn147):** clean band `[5,6,7,8,Y,Z,9]`, dots grouped; `{5,6}` peel south.
3. **Split-node B (mn152):** `{7,8}` peel to Ashland, `{9,Y,Z}` continue to Adelphi — each already contiguous.

Result: every crossing is a corridor-X before its split; mn147 and mn152 markers each show a clean band. Matches the user diagram.

## 3. Algorithm

The decomposition is a topology pass run on the support/merged graph (before `supportToLayout`), per junction node `N`.

1. **Target order.** Compute the destination-grouped target order for `N`'s incident edges (the `desiredOrdersAtNode` grouping — group lines by exit edge, ordered radially). This is the order each band *should* have so its splits are contiguous.
2. **Arriving order.** Take each incident band's *current* order as it arrives at `N` (from untangle / the corridor).
3. **Reorder diff.** For each incident band, the permutation `arriving → target` is the set of within-band crossings that must happen. Zero diff → no reorder-node needed (the band is already clean; most edges).
4. **Stage reorder-nodes.** For each band needing a reorder, insert one (or more) reorder-node(s) on its approach corridor, a short distance back from `N` (≥ a marker-clear distance), decomposing the permutation into corridor-X's. Multiple inversions may stage across multiple reorder-nodes or one (TBD by the placement rule — see §6 open question).
5. **Stage split-nodes.** Replace `N` with a chain of split-nodes, one per peel, ordered so each peels a contiguous group from the (now clean) band. Nested splits (peel from opposite ends) can share one split-node; conflicting splits get separate split-nodes in sequence.
6. **Re-home.** Distribute `N`'s incident edges onto the sub-node chain (each attaches to the sub-node whose split/reorder it belongs to); split traversals, `stopAt`, and station placement onto the chain (mirrors `separateFusedStations`'s re-homing). The station's `stopNodes` point at the split-node(s) carrying its dots.
7. **Order.** untangle runs on the decomposed graph. Because each sub-edge hosts one clean operation, the destination-grouped order is now *reachable and stable* (no global inconsistency), so the four-attempt wall does not recur.

Determinism: fixed node iteration, no randomness; the target order and diff are deterministic functions of the graph.

## 4. Capsule spanning (marker)

The rigid-row marker already draws **multi-segment capsules with joints** (rigid-row spec; the 22 St elbow, Atlantic Av multi-arm). Extend it so a station's marker spans its split-node chain:
- Gather the station's dots from its `stopNodes` (per-line, possibly on different split-nodes) — `renderOctilinear` already positions dots at `flagNode` per line.
- The capsule is the joined hull over the chain's sub-node marks (reuse the joint machinery), so the chain reads as one interchange (R4).
- Reorder-nodes that fall *outside* the marker footprint are NOT covered — their X is open-track corridor (R2). Reorder-nodes *inside* the footprint are covered (acceptable: the crossing is at the interchange).

No new marker math — the chain is just more sub-nodes for the existing capsule-join to span.

## 5. Where it lives

- **New pass** `decomposeInterchanges(h)` in topo.ts (or imageMerge.ts), run after merge/`separateFusedStations`, before `supportToLayout`. Sibling of `separateFusedStations` (node split + re-home) and `anchorGraphStops` (corridor split).
- **untangle.ts**: unchanged objective; it simply orders the larger, now-solvable graph.
- **renderOctilinear.ts / stops.ts**: capsule spans the split-node chain (small extension of existing joint machinery).
- **No per-segment renderer, no orderFrom/orderTo, no marker model change beyond spanning.**

## 6. Open questions (to resolve before/while building)

- **Reorder-node placement.** How far back on the approach (a fixed marker-clear distance? at the first existing bend?), and whether to stage a multi-inversion reorder across one node or several. Risk: a reorder-node too close to the marker re-creates the knot/box (the minimal-intervention failure); too far looks arbitrary.
- **Split ordering.** The sequence of split-nodes when several peels conflict — which peels first. Likely: peel the group whose direction is most divergent first (radial order), nested peels share a node.
- **Reorder feasibility.** Some bands may need a reorder that no single approach corridor can host cleanly (very short approach). Fallback: the existing mega box (honest, rare) — but quantify how often.
- **Interaction with octi / merge.** New sub-nodes and internal edges must survive octilinearization and not get re-merged (the internal edges are sub-`dHat`; `separateFusedStations` precedent shows the clamps needed).
- **Cost.** Node/edge count grows at interchanges; bound the render-time impact.

## 7. Verification & phasing

- **Phase 0 — feasibility probe (no ship):** hand-build the Flatbush decomposition in a dev probe (`dev/_probe-flat.ts` already loads the graph): split mn147 into split-node(s), insert a contraction-exempt reorder-node on the NW trunk, re-home edges/traversals/stops, run untangle, and confirm **untangle relocates the green braid to the reorder-node — yielding a clean station band** (the §2.0 mechanism). Then render and confirm the clean band + spanning capsule. The contraction-exemption + cheap-reorder-vs-expensive-station-braid incentive is the decisive thing to prove; if untangle does NOT move the crossing, the mechanism is wrong and we stop before investing. Go/no-go gate.
- **Phase 1 — decomposition pass (split-nodes only):** decompose nested splits (no reorder-nodes yet); stations that only need a clean split (not a reorder) clean up. Gates + crops.
- **Phase 2 — reorder-nodes:** stage within-band reorders on approaches; the dense fans (Flatbush, 3 St) clean up. Placement rule tuning.
- **Phase 3 — capsule spanning + residual box + ship:** marker spans chains; un-decomposable nodes box; full sweep; ship.
- **Gates (unchanged):** octi 0, seating 0, overdraw 0, markerfit 0; plus crossings now read as corridor-X's at reorder-nodes, families contiguous at markers. Named crops: Flatbush, 3 St, Wythe, Park Av (targets) + 22 St, St Lukes, Central Park (no regression). Full-map overview vs v0.2.45.
- **Risk:** topology surgery is the highest-leverage and highest-risk layer (the `separateFusedStations` history shows fusion/clamp subtleties). Phase 0 must pass convincingly before Phase 1.

## 8. Out of scope / notes

- This does NOT change untangle's objective or the per-edge single-order model — it changes the *graph* untangle sees.
- Paper note: the decomposition is the constructive realization of "where the lines cross" — every crossing localized to a reorder-node corridor-X, every marker a clean band; complements the rigid-row marker ("where the dots sit").
