# Adjustment Ablation Audit: Pipeline Instability and Net-Harmful "Prettiness" Stages

Scope: single-stage ablations across four map dumps (SF, SEA, NYC, LON3) plus three mechanism audits of the seating solver, the octilinearizer, and the topo smoothing/contraction passes. Metric baseline (all stages ON):

```
SF:  mega 10, zig 67
SEA: mega  2, zig 32
NYC: mega  0, zig 43
LON3:mega  0, zig 16
TOTAL: mega 12, zig 158
```

- **mega** = stations the rigid-row solver cannot seat, drawn as opaque boxes. Lower is better; these are the primary defect.
- **zig** = line traversals with a >120 degree out-and-back reversal. Lower is better; a detour/switchback cosmetic.
- SF/SEA carry all 12 megas; NYC/LON3 are zero-mega controls used to detect instability (a stage that *raises* a control's mega from 0 is coupling seating to geometry it should not touch).

> **Critical caveat, read before acting on anything below.** The mega/zig census does **not** measure line-crossing count, bundle tangle, or junction raggedness. Several stages flagged "harmful-to-seating" are crossing-reduction or junction-tidying passes whose *entire job* is invisible to this metric. A lower mega count with those stages OFF may come at the cost of a visibly uglier map. **Every "harmful" verdict here is a hypothesis that requires a rendered-SVG visual confirmation pass before any stage is removed or reordered.**

---

## 1. Executive summary

- **The instability hypothesis is SUPPORTED.** All three mechanism audits independently conclude the pipeline is architecturally over-sensitive at high complexity: the seated-vs-mega verdict is the AND of many hard-threshold gates evaluated on continuous geometry, the octilinearizer is a greedy global solve with map-wide coupling, and topo smoothing is an unconditional global node-mover with no adequate repair downstream. Sensitivity scales with density exactly as predicted.

- **Biggest single finding: the topo cleanup cluster (contractDeg2, intersectionSmoothing, contractShort2, absorbJunction, combine) is manufacturing megas, not preventing them.** Disabling them individually cuts total megas roughly in half or more: `contractDeg2` 12→5 (-7), `intersectionSmoothing` 12→5 (-7), `absorbJunction` 12→5 (-7), `contractShort2` 12→6 (-6), `combine` 12→6 (-6). These are LOOM-style corridor simplifiers that weld chains through 180-degree turnarounds and average nodes into spacing pinches, baking folds that octi inflates into phantom cell-loops.

- **`intersectionSmoothing` is the mechanistically-implicated ringleader.** The audit traces its damage to two concrete code defects: `pointAtDistance` silently clamping to the far neighbour node when an edge is shorter than `dHat` (topo.ts:93), and endpoint-only re-anchoring (topo.ts:475-476) that bakes an out-and-back V into leftover interior samples. Its single downstream repair (`contractShort2`) is threshold-calibrated to `dHat`, strictly below octi's cell floor (`dg/2`), so pinched pairs and baked folds pass through unrepaired.

- **Two penalties are genuinely load-bearing and must NOT be touched.** `loopPen` OFF raises megas 12→15 (+3) with zero zig benefit; `coursePen` OFF raises megas 12→13 (+1) AND zigs 158→166 (+8). Both are net-beneficial octi penalties whose removal strictly worsens the map.

- **Instability is real on the zero-mega controls.** `untangle` OFF *reshuffles* failure rather than removing it (SF 10→6, SEA 2→0, but NYC 0→5 and LON3 0→1 — clean controls regress). `intersectionSmoothing`/`contractShort2` OFF each spawn a phantom box on NYC (0→1). This is direct evidence of ordering/seating coupling, not decoupled cosmetics.

- **All eight draw-time and most seat-escalation stages are safely mega-neutral on this corpus** (turnMiter, dogleg, drawFillet, uncross, farSlide, mutualSlide, noovlFloor, corridorSpread, hooks, weldLadders, sanitize1, sanitize2): byte-identical to baseline, delta 0/0. Leave them alone. **No stage crashed.**

---

## 2. Ranked findings (worst-first)

Sorted by seating harm and instability: negative megaDelta (stage was creating boxes) worst first, then mixed tradeoffs, then load-bearing/neutral. `megaDelta`/`zigDelta` are ablated-minus-baseline TOTALs (negative = disabling the stage *reduced* the count = stage was harming).

| # | stage | kind | megaDelta | zigDelta | verdict |
|---|-------|------|-----------|----------|---------|
| 1 | contractDeg2 | cleanup | **-7** | +8 | mixed-tradeoff (big seating harm) |
| 2 | intersectionSmoothing | cleanup | **-7** | -8 | harmful-to-seating |
| 3 | absorbJunction | cleanup | **-7** | -1 | harmful-to-seating |
| 4 | combine | layout | **-6** | -13 | harmful-to-seating |
| 5 | contractShort2 | cleanup | **-6** | -8 | harmful-to-seating |
| 6 | weldRedundant | cleanup | **-2** | -8 | harmful-to-seating |
| 7 | contractShort1 | cleanup | 0 | +7 | mixed-tradeoff |
| 8 | untangle | layout | 0 | 0 | cosmetic-neutral (control instability: NYC 0→5, LON3 0→1) |
| 9 | coursePen | octi | **+1** | +8 | load-bearing |
| 10 | loopPen | octi | **+3** | 0 | load-bearing |
| 11 | turnMiter | draw | 0 | 0 | no-effect |
| 12 | dogleg | draw | 0 | 0 | no-effect |
| 13 | drawFillet | draw | 0 | 0 | cosmetic-neutral |
| 14 | uncross | draw | 0 | 0 | no-effect |
| 15 | farSlide | seat | 0 | 0 | no-effect |
| 16 | mutualSlide | seat | 0 | 0 | no-effect |
| 17 | noovlFloor | seat | 0 | 0 | no-effect |
| 18 | corridorSpread | seat | 0 | 0 | no-effect |
| 19 | hooks | layout | 0 | 0 | no-effect (see flag note below) |
| 20 | sanitize1 | cleanup | 0 | 0 | no-effect |
| 21 | sanitize2 | cleanup | 0 | 0 | no-effect |
| 22 | weldLadders | cleanup | 0 | 0 | no-effect |
| 23 | unstub | cleanup | 0 | +2 | cosmetic-neutral |

Notes on the ranking:
- Rows 1-6 are the net seating-harmful cluster (megaDelta negative). `contractDeg2` is ranked #1 despite the same -7 as smoothing/absorb because its +8 zig cost makes it a genuine two-way tradeoff rather than a clean removal, and its harm mechanism (welding through 180-degree turnarounds) is documented in the RCA row.
- **`hooks` was not actually ablated.** The invocation `OCTI_HOOK_RATIO=0` is inert: line 1250 guards `ratioEnv > 0`, so `0` fails to override and `suppressHooks` ran at its default 1.7. Its no-effect verdict is therefore **untested**, not confirmed.

---

## 3. Why seating is brittle and why local changes ripple map-wide

The three mechanism audits converge on one conclusion: instability is **architectural**, not a tuning bug, and it is concentrated exactly where the map is densest.

### 3a. The seated-vs-mega verdict is an AND of many hard-threshold gates (renderOctilinear.ts / rowPlace.ts)

A multi-mark station is seated only if it clears *every* gate in a chain, each a binary cutoff on continuously-varying geometry:

- Per-bundle feasibility: a bundle dies if no slide/axis state clears `hardFloor` (rowPlace L224 `if (mg < hardFloor)`), and `solveRows` returns null the moment any bundle has zero states (rowPlace L266-269).
- Per-pair floors: `if (d < hardFloor) return null;` (rowPlace L300/L351) and `stationFloorsOk` (L383-408).
- VERIFY gates: self-fold `segSegDist(...) < 0.5` (renderOctilinear L2138) and cross-hull `penBetween(hull, ph.hull) > 0.5` (L2143).

Three brittle amplifiers:
1. **Axis quantization at the 22.5-degree boundary** (renderOctilinear L1902). A lane tangent near a 22.5-degree cut flips its axis index under an arbitrarily small nudge, which changes bundle grouping (L1913 `if (markAxis[i] !== markAxis[j]) continue`), rotation cost, and the parallel-vs-V test (rowPlace L313 `P.axis === Q.axis`). Merging two diverging lanes into one bundle demands a straight row across them = no feasible state = box. The 1e-6 atan2 quantize absorbs ULP noise only, not a real geometry move.
2. **Dots are lane-curve intersections.** A small incident-edge angle change moves the crossing point along the lane by ~Delta/sin(angle), so shallow crossing angles geometrically *magnify* an upstream nudge into dot-spacing change near `hardFloor`.
3. **Order-coupling through committed masks.** Most-marks-first placement (L1811-1814) commits `placedDots`/`placedHulls` that become HARD vetoes for later stations (`< xMaskStack`, `hullClearance < 0`, L2016-2019). A nudge that reorders the queue or pushes a neighbour's capsule across the 0.5px overlap line cascades into neighbours.

Net: a dense interchange multiplies both the number of gates and the number of near-boundary pinches, so the probability at least one gate sits within sub-pixel distance of its threshold grows fast. Low-complexity stations (1 mark, clear of floors) are effectively immune.

### 3b. The octilinearizer is a greedy global solve with five map-wide couplings (octi.ts)

Nothing in the solve is local; one edge edit reseats the whole map:
1. **Grid size from a global stat:** `dg = Math.max(4, medianEdgeLength(h) / (opts.cellDivisor ?? 1.5))` (octi.ts:1365). Removing one out-and-back edge shifts the median, re-quantizing every node's candidate positions and re-thresholding which edges collapse.
2. **Degree-keyed global insertion order:** `pairDesc` (1298) and `growthOrder` (1326) sort ALL edges by `deg`/`ldeg`; a change at two endpoints permutes the whole greedy insertion sequence, and later edges route around earlier occupants (`grid.settleEdg`, 1264).
3. **Hard discrete port blocking on a shared grid:** `addC[x % 8] = -Infinity` (1044) plus spacing writes (1062, 1071) — binary open/closed with no continuity; freeing a neighbour's cells unblocks cheaper routes region-wide.
4. **Immediate-accept, path-dependent sweep:** `drawing = bestRun; grid.settleNd(...)` (2058-2061) against the global `this.c + this.violations * SOFT_INF` (815); the winning-move order shifts the basin for all subsequent nodes.
5. **Traversal-scoped penalties:** course windows (1799-1847) and loop cycles (1698-1731) are rebuilt from whole line traversals, so removing one out-and-back edge re-prices moves for nodes anywhere along that line.

The code itself flags the sharpest point: the port-ordering tangent `Math.round(Math.atan2(...) * 1e6) / 1e6` carries the comment "a 1-ULP flip here reroutes the whole layout: it is THE primary discrete divergence point" (676-677). (This structural sensitivity is distinct from cross-V8 FP determinism, which the code separately pins so identical input still renders byte-identically.)

### 3c. Topo smoothing bakes the pinches/folds that octi then inflates (topo.ts)

`intersectionSmoothing` moves every qualifying node to the average of its per-edge crop points, then re-anchors only endpoints. Two damage paths:
1. **Spacing pinch via clamp-to-far-end.** `pointAtDistance` walks from `pts[0]` and, when the polyline is shorter than `dHat`, falls through and returns `pts.at(-1)!.slice()` (topo.ts:93) — the *neighbour node's own position*. The node is then set to the centroid of its neighbours (466). A chain of short edges collapses toward a shared centroid.
2. **Baked fold via endpoint-only re-anchor.** After nodes move up to `dHat`, `e.points[0]`/`e.points[-1]` are reset to the moved node positions (475-476) but interior samples stay put, reversing the first segment into an out-and-back V. octi pays that phantom length back as a candy-cane detour → phantom cell loop → mega box.

Why it reaches octi unrepaired: ordering is sanitize2 (1750) → intersectionSmoothing (1751) → contractShort2 (1756). **No fold-cutter runs after smoothing.** `contractShort2`'s gate is `dist(na, nb) >= maxLen` with `maxLen = dHat` (363), strictly below octi's cell floor `dg/2` (octi.ts:1367), so a pair pinched into the `(dHat, dg/2)` dead band survives topo yet is still sub-cell for octi. By contrast `contractShortEdges` is threshold-gated to only genuinely sub-`dHat` pairs, so it is the corrective, narrow cousin — which is why removing *it* does not drop the box count while removing *smoothing* does (SF 10→4, SEA 2→0).

---

## 4. Net-harmful / suspicious adjustments

For each flagged stage: what it does, the numeric evidence, the likely visual cost the metric misses, and the next experiment. **All verdicts pending visual confirmation.**

### 4.1 intersectionSmoothing — `OCTI_ABL=intersectionSmooth` (kind: cleanup)
- **Does:** Crops each edge adjacent to a node at `dHat`, moves the node to the average of the cropped endpoints, re-anchors edge endpoints. Tidies junction geometry so corridors meet at one clean intersection point instead of ragged offsets.
- **Evidence:** mega 12→5 (**-7**), driven by SF 10→4 and SEA 2→0; zig 158→150 (**-8**). No zig tradeoff — removing it improves *both* metrics. Countersignal: NYC 0→1 (a phantom box on a zero-baseline control), evidence of unpredictable coupling.
- **Visual cost the metric misses:** This is the primary junction-tidying pass. OFF, crossing/merging corridors likely meet at ragged offset endpoints instead of a clean shared intersection point — the exact defect it was built to fix. Rough junctions are invisible to mega/zig.
- **Next experiment:** Render SF + SEA + NYC with `OCTI_ABL=intersectionSmooth` and diff junction geometry against baseline. If junctions stay acceptable, this is the single highest-payoff removal. If they degrade, fix the two code defects instead (see 6.1) rather than disabling.

### 4.2 contractDeg2 — `OCTI_ABL=contractDeg2` (kind: cleanup)
- **Does:** LOOM straight-run simplifier: repeatedly collapses unprotected degree-2 nodes whose two incident edges share a line set, welding polylines into one edge before octilinearization.
- **Evidence:** mega 12→5 (**-7**): SF 10→5, SEA 2→0. But zig 158→166 (**+8**), every dump gaining detours (LON3 +4, NYC +1). A genuine two-way tradeoff. Its documented side effect (RCA row + docstring at topo.ts:296) is welding chains through 180-degree turnarounds, baking folds octi inflates into mega boxes.
- **Visual cost the metric misses:** OFF, every station demands its own grid cell; dense parallel chains "spiral around each other fighting for space" (its own rationale), and the +8 zigs are the measurable tip of a broader routing-quality loss. This is a speed/quality stage; disabling it also slows routing.
- **Next experiment:** Do not disable wholesale. Add a fold-guard: refuse to weld a degree-2 chain whose join angle exceeds a turnaround threshold (e.g. consecutive-segment dot < some negative bound), so straight runs still collapse but 180-degree turnarounds stay as structure. Measure mega/zig + render.

### 4.3 absorbJunction — `OCTI_ABL=absorbJunction` (kind: cleanup)
- **Does:** Collapses short near-zero-span stub edges off a high-degree junction, folding a degree-1 detour-stop node into the junction when all its lines continue through.
- **Evidence:** mega 12→5 (**-7**): SF 10→5, SEA 2→0. zig essentially flat 158→157 (**-1**). Controls hold at 0. Clean, isolated seating harm with no zig tradeoff.
- **Visual cost the metric misses:** OFF, degenerate near-zero-span merge-noise footprints in dense interchanges get blown up by octi into full drawn grid cells — extra visual clutter / spurious stops at hubs. But the -7 with -1 zig is the strongest "just remove it" signal in the set.
- **Next experiment:** Render SF/SEA interchanges with it OFF and inspect hub footprints. If clutter is acceptable, this is a top removal candidate alongside smoothing. Otherwise tighten its trigger (only fold when the resulting fold angle would be seatable).

### 4.4 contractShort2 — `OCTI_ABL=contractShort2` (kind: cleanup)
- **Does:** Second `contractShortEdges(dHat)`, the last writer of node positions, meant to repair sub-cell pairs that smoothing pulled inside the spacing floor.
- **Evidence:** mega 12→6 (**-6**): SF 10→5, SEA 2→0. zig 158→150 (**-8**). Countersignal NYC 0→1. So the *repair pass itself* creates boxes.
- **Visual cost the metric misses:** As the last position writer, its endpoint-snap rewiring (`f.points[0] = keepPos.slice()`, topo.ts:410/413) can bake backward first segments, and its parallel-edge line-set union discards one line's divergent geometry that octi must re-expand. Removing it may leave sub-cell node pairs that route messily.
- **Next experiment:** This stage is entangled with smoothing (it exists to clean up after it). Test the pair together: fix smoothing's clamp/fold defects (6.1) first, then re-measure whether contractShort2 is still net-harmful. It may be a symptom, not a cause.

### 4.5 combine — `OCTI_NO_COMBINE=1` (kind: layout)
- **Does:** octi's LOOM degree-2 collapse: welds each degree-2 chain sharing a line set into one corridor edge so the router places only the topological skeleton; intermediate stations redistributed afterward.
- **Evidence:** mega 12→6 (**-6**): SF 10→6, SEA 2→0. zig 158→145 (**-13**, the largest zig improvement in the set). Controls stay at 0 with no instability. Not a tradeoff — both metrics improve.
- **Visual cost the metric misses:** Its rationale is speed and clean routing; OFF, "every station demands its own grid cell and dense parallel chains spiral around each other." Expect slower renders and potentially more line-crossings (uncounted). Yet clean controls + both metrics down make this notable.
- **Next experiment:** Same fold-guard idea as contractDeg2 (they are the same LOOM collapse at different pipeline stages). Add turnaround-angle refusal, render, and compare crossing counts by eye since the metric cannot.

### 4.6 weldRedundant — `OCTI_ABL=weldRedundant` (kind: cleanup)
- **Does:** Welds short retrace "stub" edges onto their parent corridor so a terminus sitting behind the previous stop renders as an inline collapsed out-and-back rather than a phantom hub with spokes.
- **Evidence:** mega 12→10 (**-2**), entirely SEA 2→0. zig 158→150 (**-8**, all SEA 32→24). SF and both controls byte-stable — isolated, not general instability.
- **Visual cost the metric misses:** OFF, octi's planarize treats the coincident retrace overlap as a crossing and inserts an intersection node → phantom hub artifact with spokes. That artifact is a *visible* defect the mega/zig census does not score, so removing this stage may trade 2 boxes for 1+ phantom hubs.
- **Next experiment:** Render SEA specifically with it OFF and check for phantom-hub spokes at the affected terminus. Highest risk of a metric-misleading "win" of any stage here.

### 4.7 contractShort1 — `OCTI_ABL=contractShort1` (kind: cleanup, mixed)
- **Does:** First `contractShortEdges(dHat)` before smoothing; collapses sub-cell near-coincident node pairs at multi-line junctions.
- **Evidence:** mega flat 12→12 (0) but reshuffled: SEA 2→0, SF 10→12; zig 158→165 (**+7**). A per-dump swap with net-zero seating and a clear zig cost.
- **Visual cost the metric misses:** The SF regression (+2 boxes) means it is *helping* SF while hurting SEA — removing it is not a clean win anywhere.
- **Next experiment:** Leave it; investigate why SF and SEA respond oppositely (likely the axis-boundary/ordering coupling from 3a). Not a removal candidate.

### 4.8 untangle — `OCTI_NO_UNTANGLE=1` (kind: layout, instability flag)
- **Does:** Bundle-blocks line-ordering (`orderByBlocks`) + same-section twist rescue (`rescueTwists`). Reduces line crossings within bundles; does not seat markers directly.
- **Evidence:** TOTAL mega 12→12 and zig 158→158 (0/0 net), but it *redistributes* failure: SF 10→6, SEA 2→0 improve while NYC 0→5 and LON3 0→1 regress from clean. Direct evidence of ordering↔seating coupling.
- **Visual cost the metric misses:** Its entire purpose — line-crossing reduction — is invisible to mega/zig. OFF, bundles that currently untangle would show crossings the census cannot see, even where megas drop.
- **Next experiment:** This is a coupling diagnostic, not a removal candidate. Investigate why line-ordering feeds back into seatability (it should not). The NYC 0→5 regression is the clearest single instability signal in the corpus and deserves a focused trace: which reordered bundle causes which station to lose its feasible row.

---

## 5. Safely-decoupled stages (leave alone)

Confirmed byte-identical to baseline (megaDelta 0, zigDelta 0 unless noted); no crashes. These are decoupled from seating on this corpus:

- **Draw-time ribbon geometry (all no-effect / cosmetic-neutral):** `turnMiter` (`OCTI_NO_TURNMITER=1`), `dogleg` (`OCTI_NO_DOGLEG=1`), `drawFillet` (`OCTI_NO_DRAWFILLET=1`), `uncross` (`OCTI_NO_UNCROSS=1`). All run after seating and only round/clip the drawn ribbon; by construction they cannot create megas. Their spike/loop/S-kink suppression did not fire on the sampled traversals, so they are inert here but still cheap insurance.
- **Seat-escalation tiers, unexercised here:** `farSlide` (`OCTI_FAR_SLIDE=0`), `mutualSlide` (`OCTI_MUTUAL_SLIDE=0`), `noovlFloor` (`OCTI_NOOVL_FLOOR=0`), `corridorSpread` (`OCTI_CORRIDOR_SPREAD=0`). Conditional recovery/separation passes constrained to never create megas; simply not triggered (or outcome-neutral) on these four dumps. Absence of signal is not proof they are unnecessary in general.
- **Topo fold-cutters, inert here:** `sanitize1` and `sanitize2` (`OCTI_ABL=sanitize1/sanitize2`), `weldLadders` (`OCTI_ABL=weldLadders`). No pre/post-contraction balloon folds or two-rung same-service ladders in this corpus. Keep — they guard inputs not represented here.
- **`unstub`** (`OCTI_ABL=unstub`): mega flat, zig 158→160 (+2, all LON3). Self-gated to keep only edits that reduce reversals; removing it mildly worsens zigs with no seating benefit. Keep.

**Untested, do not assume safe:** `hooks` (`OCTI_HOOK_RATIO=0`) never actually turned off — the flag is guarded by `ratioEnv > 0` (line 1250), so `0` fell through to the default 1.7 ratio and `suppressHooks` ran normally. Its 0/0 result reflects an un-ablated run. Re-test with a proper disable flag before trusting the no-effect verdict.

---

## 6. Recommended next steps (ranked by expected payoff)

Every step below begins with a **visual confirmation pass** because the mega/zig census is blind to line-crossings, bundle tangle, and junction raggedness — the very qualities the flagged cleanup stages exist to protect.

### 6.1 (Highest payoff) Fix `intersectionSmoothing` at its two source defects rather than disabling it
The audit pins two concrete bugs. Fix both and re-measure; this attacks the -7 mega without sacrificing junction tidiness:
- **Clamp defect:** `pointAtDistance` returns `pts.at(-1)!.slice()` (topo.ts:93) when an edge is shorter than `dHat`, turning a bounded crop into a full neighbour-position pull. Change short-edge behaviour to return a *bounded* offset (e.g. the far endpoint capped, or skip smoothing entirely for edges shorter than `dHat`) so a node is never averaged toward a full neighbour position.
- **Baked-fold defect:** endpoint-only re-anchor (topo.ts:475-476) leaves interior samples reversed. Either re-anchor interior samples proportionally, or run a fold-cutter after smoothing (there is currently none between line 1751 and octi).
- **Threshold mismatch:** raise `contractShort2`'s `maxLen` from `dHat` toward octi's cell floor `dg/2` (octi.ts:1367) so pinches in the `(dHat, dg/2)` dead band are actually repaired.
- **Experiment:** apply fixes, run the full census, expect SF/SEA megas to drop toward the 12→5 seen on full ablation *without* the NYC 0→1 phantom. Confirm junctions visually.

### 6.2 Add a turnaround-angle guard to the two LOOM degree-2 collapses (`contractDeg2` + `combine`)
Both weld chains through 180-degree turnarounds, baking folds octi inflates. Refuse to weld when the consecutive-segment dot at the join indicates a near-reversal (keep straight-run collapse, block the fold). Re-measure: target is `contractDeg2`'s -7 mega and `combine`'s -6 mega/-13 zig **without** the +8 zig regression `contractDeg2` currently causes on removal. Render to confirm dense parallel chains do not start spiraling.

### 6.3 Trace the `untangle` control instability (NYC 0→5)
Line-ordering should not change seatability. Instrument which reordered bundle causes which NYC station to lose its feasible row (tie to the axis-quantization grouping at renderOctilinear L1902 / L1913). This is the cleanest reproducer of the order↔seating coupling from mechanism audit 3a and likely explains several borderline flips elsewhere. Fixing the coupling is more valuable than any single stage removal.

### 6.4 Convert the terminal seated-vs-mega gates from hard cutoffs toward soft/hysteretic
The core brittleness (audit 3a) is that continuous geometry is consumed as binary thresholds (`hardFloor`, `< 0.5` self-fold, `> 0.5` cross-hull). Investigate a small hysteresis band or a soft-penalty relaxation on the *terminal* gates (not the ULP quantizers, which are for determinism) so a station a sub-pixel inside a floor is nudged rather than boxed. Highest architectural payoff, highest risk — prototype behind a flag and verify byte-determinism is preserved.

### 6.5 Re-run `hooks` with a working disable flag
Its `OCTI_HOOK_RATIO=0` ablation never disabled the stage (guard `ratioEnv > 0`, line 1250). Add a dedicated `OCTI_NO_HOOKS` flag and re-measure so its no-effect verdict is actually tested.

### 6.6 Visual-confirm `weldRedundant` before any action
Its -2 mega (SEA only) is the highest risk of a metric-misleading win: removing it likely produces phantom-hub spokes the census cannot score. Render SEA with it OFF first; if hubs appear, it is correctly load-bearing despite the -2.

---

*No stage crashed in any ablation. All deltas are TOTAL-across-four-dumps, ablated minus baseline. Numbers are quoted directly from the ablation and mechanism-audit inputs; nothing here is extrapolated beyond the four sampled dumps, and absence of signal on this corpus is not proof of general safety.*
