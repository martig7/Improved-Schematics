# Micro-Edge Chains — Design

Corner constructions that span a run of short edges as one unit, so a
junction whose geometry outgrows its edges resolves anchor-corridor to
anchor-corridor instead of fighting its neighbours seam by seam.

## 1. Problem

The fan builder constructs per (junction, edge-pair). Absorption extends a
corner across ONE adjacent short edge per flank. Everything between two
genuine corridors that is longer than one edge has no owner, and the
evidence says that gap is now the binding constraint:

- **Taper residuals at the structural floor.** The fan-zone census reports
  6 taper intrusions corpus-wide, all of one shape: a corner's constructed
  extent covers (or overhangs) an entire adjacent short edge, and the seat
  seams at that edge's far end have no zone-free room. The ramps are
  already at the 45-degree step ceiling (invariant I9); no taper placement
  can fix them. Observed instances include a corner whose extent reaches
  18px past the whole 37px edge beside it, and 6-pitch band exchanges
  riding one-sided at 45 degrees through a neighbour's sweep.
- **Two falsified cheap fixes.** Locking each turn group to ONE absorption
  side removed the intrusions but manufactured a 53px visible clip: the
  members' mixed-side absorption was load-bearing (each side's absorption
  was resolving a different seam). Both-flank absorption is correct but
  declines exactly here, because the through edge carries other lines'
  rub-length lanes (the sibling frame guard, which is itself load-bearing:
  removing it manufactures sub-pitch frame-mix clips).
- **Detector fragility under settings variation.** Re-rendering a dump
  with a different warp growth or with station splits off re-manufactures
  the known clip families at the same junction shapes. The constructions
  hold on the pinned corpus because their detectors (the parallel-pair
  finder, seat-absorb gates) found the specific structures there; in
  variant geometry the same structures reappear unfound. A corridor-level
  construction owns the geometry structurally instead of by detection.

Root pattern in all three: **interior edges of a congested junction
complex have frames (slot + per-edge bias) that no construction is
allowed to own end-to-end.** Every mechanism (bias relaxation, jog
tapers, absorption, joint seating) negotiates one seam at a time, and the
seams interact inside each other's zones.

## 2. Design

### 2.1 The chain unit

A **chain** is a maximal run of consecutive edges `e1..ek` along a
corridor where every interior edge is DOMINATED by junction geometry,
bounded on both ends by **anchor edges** that are not. Dominated, per
invariant I7, derives from the actual geometry:

- `arc(e) < reach(nA) + reach(nB)` where `reach(n)` is the THEORETICAL
  fan reach of the turn groups at the edge's two nodes, computed from
  half widths and turn angles alone (chains are detected before any
  construction exists to measure; the edge cannot host its own
  constructions plus both neighbours'), OR
- the edge is collinear with its chain neighbours (chord dot >= 0.99) and
  distinguishable from them only by a bias seam (the whole-edge constant
  frames that downstream machinery papers over).

An anchor edge is any edge failing both conditions: long enough to host
its constructions with room to spare, and genuinely directional. Chains
are per-corridor structures (edge-level), computed once, before the fan.

### 2.2 Chain rails

For each (chain, line) the authoritative frames are the ANCHORS' lane
frames; interior frames become advisory. Construction mirrors the joint
seating rails, longitudinally:

1. **Chain centerline**: the concatenated base polylines of `e1..ek`,
   vertices merged by arclength (both corner vertices and node positions
   survive; the same merged-centerline construction corridorSep uses).
2. **Entry/exit seats** per line: its lateral offset in the entry anchor's
   frame and the exit anchor's frame (slot + bias of the anchors, which
   nothing inside the chain may re-negotiate).
3. **Rail** per line: offsetPolyline of the centerline at the entry seat,
   transitioning to the exit seat over the chain's LARGEST zone-free
   interior room (the census's roomOf, maximized over interior spans), at
   a slope within the I9 ceiling; if no interior room exists the
   transition rides the corner constructions themselves (the seat change
   happens ACROSS a turn, where a lateral step is invisible inside the
   sweep: the ride-until-turn semantics).
4. **Corners on rails**: the fan's corner machinery runs unchanged, but
   members whose edges are chain-interior take their reference lines from
   the RAILS (which are anchor-frame-true by construction) instead of from
   interior lane frames. This generalizes baseEndDir: the reference is not
   just the base direction but the whole anchor-seated rail.
5. Interior lane polylines in segPath are REPLACED by the rail pieces
   (per edge, so every downstream consumer sees ordinary lanes), exactly
   the way joint seating mutates lanes in place.

### 2.3 Branch lines and sibling safety

A line that leaves the chain at an interior node is seated by the SAME
rail family up to its departure node (its rail simply ends there and its
corner at the branch references its rail). Because all co-chain lines'
rails derive from one centerline and one seat ladder, pitch between a
pass-through line and a branching line is preserved by construction; the
sibling frame guard's job (never mix frames beside a lane that keeps its
own) is met structurally, not by declining.

This is the part both falsified probes could not provide: a single frame
family covering every line that touches the interior, rather than one
line's construction re-framing ink beside another's.

### 2.4 What the chain subsumes (and what it does not)

- **Cross-chain merge (approved 2026-07-17).** Two chains whose interior
  edges geometrically overlap (share an edge, or sustain the parallel
  sub-clearance test of the joint-seating pair detector WITHOUT its
  shared-hub gate, scoped to chain interiors only) seat as ONE merged
  ladder in a shared lateral frame. The pair detector's (d0, sign)
  output is the frame transform between the chains. Rationale: under a
  tight warp, two compressed parallel corridors otherwise each seat in
  their own frame and ride sub-pitch beside each other; the shared-hub
  gate that protects unrelated close streets stays in force for the
  cross-corridor joint seating pass, while chain interiors (short
  dominated micro-corridors) coordinate structurally.
- Single-flank and both-flank seat absorption become the 1-edge chain
  special case; they remain for genuinely isolated micro lanes whose
  neighbourhood is not a chain.
- The ride-until-node one-sided jog remains for seams AT anchors.
- Joint seating (parallel-pair rails) remains: it is the CROSS-corridor
  analog. The two share the rails machinery (merged centerline +
  offsetPolyline + bend-vertex insertion) which should be extracted into
  a shared module.
- The bias relaxation is untouched; chains simply stop trusting interior
  biases as authoritative.

## 3. Milestones

- **C1. Chain detection + census.** Compute chains; OCTI_FANZONE gains a
  chain report (count, interior edges, room). No behavior change. Gate:
  every current taper-intrusion site lies inside a detected chain.
- **C2. Rails construction, flag-gated.** OCTI_CHAIN=1 builds rails and
  reroutes fan references; default off. Unit tests: seat transition in
  interior room; transition across a corner when no room; branch-line
  pitch preservation; anchor frames never re-negotiated.
- **C3. Corpus certification + default on.** Gates: taper intrusions -> 0
  on the pinned corpus; clip/loop/zig censuses no worse anywhere; the
  settings-variant sweep (station-split off, warp growth changed) shows
  strictly fewer visible clips than its current baselines (4 and 3) and
  ZERO artifact loops. The loop census is the authoritative ruler for the
  small self-cross "plus" shape (a route crossing its own ink at a
  turn): it is same-color, so the clip census cannot see it, and the
  variant sweeps must gate on it explicitly.
  **CERTIFIED + DEFAULT ON (2026-07-17).** Construction shipped as the
  seat POLICY (constant ladder seats at lane build) rather than rail
  geometry; see 2.2/2.3 deviations. Measured gates, chains on vs off:
  pinned corpus 0 visible clips in all six cities (off keeps 1), 0
  artifact loops, 0 zigzags; tapers 2 in both modes (the anchor
  band-exchange family named in C1 as out of scope; the original
  interior-micro-edge trio -> 0 via the node-space jog room fix, which
  also cleared the off mode). Variant sweep: zero artifact loops on
  every variant; visible clips better or equal on five of six variants
  (station-split off 1 vs 4, deep-warp 3 vs 6) and 5 vs 3 on the tight
  warp, where two of the five are pre-existing compression sites at
  LOWER amplitude than the off mode paints them and the staircase and
  taper censuses read 2 vs 8 and 1 vs 5 in the policy's favor.
  Accepted with that one cell above baseline. OCTI_CHAIN=0 is the
  escape hatch.
- **C4. Consolidation.** Fold the machinery the chains subsume; the
  superseded paths move to `old/` per the deprecation policy only after
  sign-off.

## 4. Risks

- **Chain over-detection**: a long collinear corridor of legitimate
  chained edges (station spacing) must not become one giant rail that
  erases real station-local geometry. The domination criterion is
  junction-derived (I7), not length-alone; C1's census exists to verify
  scope before any construction changes.
- **Interior stations**: stops and capsules seated on interior edges must
  read positions from the rails. The stop machinery already consumes
  segPath lanes, so replacement-in-place covers it; the capsule rewrite
  (I10) lands after and reads the same lanes.
- **Determinism**: rails derive from sorted iteration over deterministic
  inputs, same as joint seating; no new nondeterminism sources.
