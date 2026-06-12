# Dots-on-Lanes Marker Placement via Chain DP — Design

**Date:** 2026-06-12
**Status:** Approved direction (option C — exact optimizer); spec pending user review
**Supersedes:** the cross-line marker placement stack in `renderOctilinear.ts` (perpendicular collapse, seatOnLane, PAV respacing, 2-D elbow slide solver, seatability dry-runs, pre-normalization, per-dot snap) and the per-segment stadium + joint renderer in `stops.ts`.

## 1. Problem

Station markers are currently built *at station nodes*, where lane geometry is at its worst: join curves displace lane endpoints into corners, corridors kink as they cross, nested bends stagger per-lane corners, and terminus lanes end at staggered positions. Dots are forced onto a straight cross-line through that region and then corrected after the fact. Every off-lane-dot bug of v0.2.31–v0.2.41 (St Lukes Pl column float, 22 St middle-dot offsets and the snap-pass blob, terminus tip hang, Broadway kink offsets) is an instance of the same conflict: a straight row at a node vs. lanes that are not straight at the node.

Hard requirement (user rule): **dots must always sit on their lines.** Strategy (user proposal): keep dots on their lines by construction, move them *along* the lines until the marker coheres ("ends match up"), and fill remaining gaps with capsule ink.

## 2. Formal model

### 2.1 Lane curves

For a station $S$ with stopping lines $\ell_1 \dots \ell_n$ (one dot per stopping line), each line contributes a **lane curve** $\gamma_i : [0, L_i] \to \mathbb{R}^2$: the line's drawn lane through the station's vicinity, arc-length parameterized.

Construction: concatenate the line's lane polylines (`segPath`) on the edges incident to the dot's stop-flag node, bridged through the node by the drawn connector/join geometry where present. A through-line contributes both sides; a terminus line contributes one (its domain ends where the ink ends). The curve is truncated to an arc window of `CHAIN_ARC_LIMIT = 24 px` on each side of the stop anchor (≈ one grid cell; keeps markers local and bounds the solver). $t_i^{stop}$ denotes the arc position of the dot's current stop anchor (`drawnEndAt`) on $\gamma_i$.

The decision variable for dot $i$ is the scalar $t_i \in [0, L_i]$; its position is $p_i = \gamma_i(t_i)$. **On-line holds by construction** — there is no off-line coordinate.

### 2.2 Chain order

The marker is a **chain**: a fixed visiting order $\pi$ over the $n$ dots.

- **Groups:** dots whose lanes share a corridor (same edge set at the cross-section) form a group. Within a group, $\pi$ is the **lane order** — the signed lateral order of lanes inside the edge, which is well-defined and constant within an edge. This replaces the direction-bucket/union-find grouping and reproduces welded interleavings (22 St's 2,3,8,4,6,1,7,5) by construction.
- **Across groups:** group sequence and per-group orientation are chosen by exhaustive minimization of total inter-group link rest-length (groups ≤ 4 in both test saves; $g! \cdot 2^g \le 384$ candidates, evaluated at anchor positions). Adjacent group ends are connected by **link pairs** in $\pi$.

### 2.3 Energy

$$
E(t) \;=\; \sum_{(i,j) \in \pi_{\text{intra}}} \big|\lVert p_i - p_j \rVert^2 - \rho^2\big|
\;+\; \lambda_{\text{link}} \sum_{(i,j) \in \pi_{\text{link}}} \max\big(\lVert p_i - p_j \rVert - \rho,\, 0\big)^2
\;+\; \lambda \sum_{i=1}^{n} \big(t_i - t_i^{stop}\big)^2
$$

subject to the hard non-overlap floor $\lVert p_i - p_j \rVert \ge 2r - 0.05$ for consecutive pairs.

- $\rho$ = lane pitch = `LINE_WIDTH + LINE_GAP` (5.5 px). The **target is the pitch, not the dot diameter**: with target $2r < \rho$, lane-pinch regions (crossings) would attain the target exactly and the optimizer would chase junction interiors. Pinches ($d < \rho$) and fans ($d > \rho$) both cost energy; at a full crossing ($d = 0$) the cost is $\rho^2$, and the near-floor region costs strictly more than under a $(d-\rho)^2$ law.
- The intra-pair form is $|d^2 - \rho^2|$, **not** $(d-\rho)^2$ — this is load-bearing. On parallel lanes $d^2 = \Delta t^2 + \rho^2$, so the pair term equals $\Delta t^2$ **exactly**: quadratic curvature in stagger. Under $(d-\rho)^2$ the curvature is quartic ($\approx \Delta t^4 / 4\rho^2$), the quadratic anchor term dominates near zero stagger, and the minimizer retains $\mathcal{O}(\text{px})$ residual stagger (brute-force verified during implementation: ±1.6 px at $\lambda = 0.05$ with ±3 px anchors) — visibly wobbly rows. With $|d^2-\rho^2|$ the parallel-track energy is a quadratic spring chain plus anchors, and the residual stagger is bounded by $\frac{\lambda}{\lambda + c}\,A$ (anchor stagger $A$, chain stiffness $c \ge 2$), ≈ 0.14 px at the defaults — below the 0.5 px state grid, so the discrete minimizer is the perpendicular row.
- Intra-group pairs use the symmetric quadratic (weight 1): pinches **and** fans both cost energy.
- Inter-group links use a one-sided quadratic (only excess length penalized) at $\lambda_{\text{link}} = 0.25$: links pull rows together but never overpower intra-group straightness, and never reward entering the junction.
- Anchor weight $\lambda = 0.05$: breaks translation invariance on straight track and keeps the marker at its station; weak enough that escaping a kinked junction (a ~15 px slide) is always preferred over absorbing per-pair kink penalties.
- Dots separated by **pass-through (non-stopping) lanes** are consecutive in $\pi$ with rest distance $k\rho$ ($k\ge2$); the resulting constant penalty is position-independent on parallel track and does not distort the minimum. The spine ink fills the gap.
- **Octilinearity (hard, user rule 2026-06-12 round 2):** the rendered marker must be an octilinear polygon. Feasibility constraint on every consecutive pair: if $\lVert p_i - p_j \rVert < \texttt{ELBOW\_MIN} = 1.5\rho$, the segment direction must lie within $\texttt{OCT\_TOL} = 7°$ of a multiple of 45°. (7° is the tightest tolerance honest to the 0.5 px state grid: $\arctan(0.5/\rho) \approx 5.2°$.) Pairs at or beyond $\texttt{ELBOW\_MIN}$ are direction-free — they render as octilinear ELBOWS (§5), so a pair that cannot align must stretch far enough to earn a legible elbow, paying the $|d^2-\rho^2|$ stretch cost. Both clauses are functions of the two endpoint states only, so the constraint is pairwise and the chain DP remains exact. On parallel track the perpendicular row is octilinear, so P1 is unaffected; bends quantize to 45° steps.

All weights are named constants with the defaults above; they are tunables, not magic.

## 3. Properties (paper-facing)

- **P1 (Emergent straightness / clean-track placement).** On parallel lanes at pitch $\rho$, each intra term equals $\Delta t_{ij}^2$ exactly (no approximation), so the restriction of $E$ to clean track is the quadratic form $\sum_{\text{pairs}} \Delta t^2 + \lambda \sum_i (t_i - t_i^{stop})^2$ — a spring chain with weak anchors. Its unique minimizer has residual stagger at most $\frac{\lambda}{\lambda + c} A$ where $A$ is the anchor stagger and $c \ge 2$ the chain stiffness; at the defaults ($\lambda = 0.05$, $A \le$ a few px) this is below half the state grid, so the discrete global minimizer is the exact perpendicular row. Kink/crossing regions pay strictly positive pair costs and are escaped whenever clean track exists in the window. "Slide to clean track" and "rows are perpendicular pills" are theorems with an explicit residual bound, not heuristics.
- **P2 (Emergent bending).** Where no straight placement exists within the arc window, the minimizer bends exactly as far as the lane geometry forces — the bent-capsule fallback requires no code branch.
- **P3 (Containment).** Dots lie on the spine by construction; after RDP simplification with tolerance $\varepsilon = 0.75$ px every dot center lies within $\varepsilon$ of the rendered spine. A dot's outer ring radius is $r + 0.75$ (ring stroke 1.5), the capsule fill half-width is $r + 1.5$, so dot ink never escapes the fill, and the border ring adds a further 1.5 px of margin. Capsule containment is a property, not a gate; the lateral-widening machinery disappears.
- **P4 (Exact solvability).** With fixed $\pi$, $E$ is a chain-structured function (unary + consecutive-pair terms). On a discretized domain it is minimized **exactly** by dynamic programming (§4). No local-minimum caveats. The octilinearity constraint (§2.3) is also pairwise, so it restricts the transition sets without changing the algorithm or complexity.
- **P5 (Octilinear shape).** Every rendered spine segment is either (a) a near-pitch dot pair within $\texttt{OCT\_TOL}$ of an octilinear direction (DP feasibility), or (b) replaced at render time by a two-leg octilinear elbow (§5). Hence the marker outline is an octilinear polygon up to $\texttt{OCT\_TOL}$ (invisible at marker scale). Elbows are inserted only between ADJACENT chain dots — never across spans containing interior dots — so P3 (containment) is preserved: dots remain spine vertices.

## 4. Solver

- Discretize each $t_i$ at 0.5 px over its window: $m \le 192$ states ($2 \times 24$ px / 0.5, fewer at termini).
- DP over the chain: forward pass with $O(m^2)$ transitions per consecutive pair; hard floor and (for masked states, §6) infeasibility encoded as $\infty$. Complexity $O(n m^2)$ ≈ 0.45 M operations for $n = 12$; both saves' ~240 capsule stations total ≈ 10⁸ simple operations — within the existing ~40 s render budget.
- Deterministic: fixed station order (node id), fixed state grids, no randomness.
- **Approximation boundary (stated honestly):** non-consecutive dot pairs and marker-vs-marker separation are not chain-structured and are *not* in the DP. They are enforced by (a) state masks from already-placed neighboring markers (§6) and (b) the existing post-hoc gates; violations trigger a documented local repair (re-run the station's DP with the offending states masked). The global-optimality claim is per-station, per-chain-order, on the discretized domain.
- The curvature-regularized variant ($+\,\mu \sum (1 - \cos\theta_k)$, second-order DP) is **out of scope**: P1 already yields exact straightness where straightness is possible. Listed as a paper extension.

## 5. Rendering (spine capsule)

- **Spine:** polyline through $p_{\pi(1)} \dots p_{\pi(n)}$ with **elbow completion**: walking consecutive pairs, a segment within $\texttt{OCT\_TOL}{+}1°$ of an octilinear direction renders straight; otherwise it renders as two octilinear legs meeting at a corner — the legs' directions are the two octilinear axes bracketing the chord, the corner is their intersection, and of the two symmetric corner candidates the renderer deterministically picks the one minimizing total turning against the adjacent spine segments (tie → the clockwise side). Elbow corners are extra path vertices between the two dots. The completed polyline is then simplified by Ramer–Douglas–Peucker at $\varepsilon = 0.75$ px so collinear runs render ruler-straight (RDP merges only near-collinear vertices, so it cannot remove an elbow corner).
- **Capsule:** the spine path stroked twice — border at width $2r + 6$, fill at $2r + 3$ — with round caps and round joins (`stroke-linejoin="round"`), drawn border-then-fill as today so overlapping geometry fuses. The v0.2.41 flush chamfer is subsumed: an inter-group link *is* a spine segment.
- **Dots:** drawn at $p_i$ exactly, after fills; bullets upright; unchanged from today.
- Single-dot stations: $n = 1$, $t = t^{stop}$ (anchor minimum) — today's behavior. Capsule iff >1 mark or >1 member (unchanged rule). Mega-box code stays dormant and untouched.
- Marker anchor (`data-ax/ay`) = spine centroid; labels follow as today.

## 6. Station interactions

Stations are solved sequentially in fixed node-id order. Dots of already-placed markers impose hard masks on later stations' DP states (any state within $2r - 0.05$ of a placed dot, or whose capsule hull would penetrate a placed capsule beyond the existing tolerance, is infeasible). The existing small-vs-small hull pass and `_chk-markerfit` overlap gate remain as the final check. Fully-coincident fused stations (the 4 known NYC pairs) are an upstream `separateFusedStations` concern, unchanged here.

## 7. What is deleted / kept

**Deleted** (all exist only to fight node-interior geometry):
- `renderOctilinear.ts` stations block: perpendicular collapse, `seatOnLane` correction pass, PAV `respaceAlong` fights, the 2-D elbow slide solver, `seatableSeg`/`slideRangeSeatable` dry-runs, pre-normalization, the final snap pass.
- `stops.ts`: per-segment stadium geometry (`SegGeom`), axis derivation, tip extension, acute-corner logic, joints/chamfers.

**Kept:** mark gathering (which lines stop at which drawn node), `lanePolysOf`-style lane access (feeds $\gamma_i$ construction), marker-vs-marker hull machinery, all gates, mega-box dormant code, label placement, bullets.

**New:** `src/render/layout/chainPlace.ts` — lane-curve construction, group/chain-order derivation, DP solver. Pure functions over `segPath` + marks; unit-testable without rendering.

## 8. Verification

- **Unit tests** (node:test, as the suite): P1 as a property test (parallel synthetic lanes → DP returns the perpendicular row, residual 0 within discretization); bend case (synthetic kink → chain bends, all dots on lanes); link case (two groups → ends meet, one-sided link); terminus domain clipping; determinism (two runs byte-equal).
- **Gates on both saves:** `_chk-seating` expected ≤ 1 px for every dot (discretization + RDP bound) — the gate's threshold tightens from "investigate > 6" to "fail > 2"; `_chk-markerfit` (containment + overlaps) unchanged; `_chk-overdraw` unchanged.
- **Visual baselines:** `_diff-dots` against current v0.2.41 dumps; crops at the named stations — 22 St (V with flush chamfer), St Lukes Pl (column + L-arm), Broadway (row), G/F/D terminus chevron, Howard St (perpendicular pill spanning pass-through lanes), Kew Gardens Rd, Flatbush — plus Seattle J/D, B/L, X/V/U/W/Y+Z, 2/4.
- **In-game check** by the user (panel reopen, both saves), per standing workflow.
- **Performance:** render time within 1.5× of current on the NYC dump.

## 9. Out of scope / future (paper material)

- Curvature-regularized second-order DP; global (cross-station) joint optimization; learned/derived per-corridor pitch targets; comparison study vs. LOOM's station rendering; formal write-up of P1–P4 with the 22 St / St Lukes case studies.
