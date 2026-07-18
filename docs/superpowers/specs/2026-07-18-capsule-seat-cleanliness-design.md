# Capsule seat cleanliness (I10) — design

Final junction-fan-rebuild milestone. The interchange capsule machinery ranks
its seat candidates by ink cleanliness (invariant I10,
`docs/draw-geometry-invariants.md`): clean octilinear seats first, overlapped
octilinear seats second, non-octilinear constructions last.

**Cleanliness is occlusion, not proximity.** A marker sits ON its line; that
is normal everywhere. The defect is a marker placed where its own line is
HIDDEN: a foreign line painted above it covers the strand at the seat, so the
dot appears to float on someone else's ink, disconnected from its visible
line. A seat where the mark's line is the top layer is clean no matter what
runs underneath it. Companion deliverable: the fanzone stop-mark census
learns the same distinction (occluded seat = defect, visible-ink seat =
exemption, lone stops = separate class), so it becomes a gateable ruler
instead of a raw count.

## The defect record (corpus census, full recompute, current code)

Stop-mark intrusions (a drawn mark seated inside a foreign junction's fan
zone): NYC 17, SF 17, SEA 9, HOR 19, DEN 0, LON 2 — 64 intrusion lines total.
Classified:

- **~48 lines are multi-mark capsule stations** — the seat search chose the
  position. Hot sites: World Trade Center / Rector St cluster (NYC, 10 lines,
  marks seated AT the junction throat, `along=0`), Court Sq, the JFK terminal
  pair, Eastern Pkwy, Times Sq (NYC); Second Avenue, I-80/Richmond, Montgomery,
  Garage A (SF); Hill St, Tacoma Av, 160 Av (SEA); Netanya Central, Sharon
  Central, Bar Ilan University, Neve Sha'anan (HOR); Chipmunk Grove (LON).
- **~16 lines are single-mark placement units** (lone stops and platform-split
  singles). These never run a seat search: the mark stays at its lane anchor,
  so today no code even chooses their position.
- Depth profile: roughly a third sit AT the zone node (`along=0`, the marker
  covers the junction's corner construction), a third are mid-zone, and a
  third are sub-2px grazes of the zone boundary (Neve Sha'anan's four marks at
  25.5 vs reach 27.1). A few zones are tiny (reach 2-4px, smaller than a
  marker radius).

The seat search today is blind to ink: `solveRows` prices slide, rotation,
turn, extension, dot-gap deficits, and capsule-capsule proximity, but nothing
about what the ink under a dot looks like. A row that seats its dots on a
corner fan and a row that seats on clean mid-corridor lanes cost the same.

## Design decisions (settled)

- **Ranking is a graded, dominant soft cost, not extra solve tiers.** A new
  per-dot cleanliness penalty joins the existing state cost. It never vetoes
  (no new nulls), so the feasibility class of every station is unchanged: any
  station that seats octilinearly today still does, and the relaxed
  non-octilinear seat stays the last resort by ladder order. Dominance gives
  tier semantics for free: if any feasible all-clean chain exists in the
  searched space, the DP picks it over every dirty one; otherwise least-dirty
  wins. No second solve, no new fallback branch.
- **Cost hierarchy** (strong to weak): hard floors > dot-gap deficit (softW,
  5000/px) > placed-hull penetration (1000/px) > **cleanliness (new)** >
  capsule-comfort proximity (~40) > turn/rotation/slide. A capsule never
  trades marker overlap or capsule collision for clean ink; it does pay
  bounded slide/extension to reach it. Extension is priced in raw px, so the
  worst cleanliness-driven stretch is bounded by the existing extCap safety
  bound; the exact weight is tuned on the corpus at execute time.
- **One oracle term: occluded own ink.** A candidate dot `p` for a mark of
  line L is dirty iff some line M ≠ L has a strand within the clip census's
  sub-pitch threshold (0.75 · spacing, derived, I7) of `p` AND M paints ABOVE
  L. Graded by the proximity deficit, so a sustained parallel strand riding
  over the seat charges a full-depth penalty while a steep crossing charges
  only its small overlap disc. If every nearby foreign strand paints BELOW L,
  the seat is clean: the mark's line is the visible ink there.
- **"Above" comes from the real paint order.** The paint layer builder
  (`computePaintGroups`) already defines the stroke sequence: groups in
  order, lines in group order (casings then strokes per group). A global
  stroke rank (group index, index within group) is computed once and shared:
  the SAME ranks feed the oracle and the final paint, so the oracle can never
  disagree with what the viewer sees. `computePaintGroups` depends only on
  `orderOf` and edge arcs, both stable before marker placement, so the call
  is hoisted above the placement queue and its result reused at emission.
- **Exclusions:** the mark's own line (folds and retraces are its own ink),
  and foreign strands whose line color equals L's color (occlusion by
  identical color is invisible, the clip census's same-color class). No
  member-line exclusion: a co-member painted over L at the dot hides it just
  as much as any foreign line would.
- **All ladder tiers inherit.** The penalty composes into the station's
  `proximity` closure in `renderOctilinear`, which every tier already spreads
  (primary, far-attach, best-effort, relaxed). `rowPlace.ts` is untouched.
  The relaxed seat therefore also prefers clean ink among its free-angle
  states — cleanliness ranks above (is applied before) non-octilinearity, and
  within the relaxed tier it still discriminates.
- **Certification is recorded, not inferred.** At seat commit, each mark
  stores the oracle's dirt depth at its final dot. Dominance means a dirty
  winning chain certifies that no clean feasible chain existed in the search
  space; the census reads the stored depth to classify.

## Census evolution

`reportStopSeating` keeps its geometric zone test and existing exemptions
(own-node, joinStopPos fan seats, own-corridor no-room) but classifies each
intrusion by occlusion at the FINAL mark position (same oracle, same ranks):

- **`visible`** — the mark's line is the top ink at its seat. This is the
  capsule-group exemption the census learns: a capsule legitimately spanning
  its junction complex with its marks on visible own ink is not a defect.
  Printed as an info count, not a violation.
- **`occluded-avoidable`** — multi-mark station, occluded seat, recorded
  seat-time dirt ZERO (the solve thought it was clean; the finished map says
  it is not). Only oracle blind spots and post-seat movement (slides, trims,
  lane crops) produce these. **Hard gate: 0 corpus-wide.**
- **`occluded-certified`** — occluded seat whose recorded dirt is positive:
  the solver searched and no un-occluded seat existed within its freedom
  (the WTC/Rector class). Watch count with new pinned baselines; driving it
  down is layout-spacing / I3 work, not seat-search work.
- **`lone-stop`** — single-mark units, which have no seat search; classified
  visible/occluded for information. Watch count; a lone-stop slide is a
  possible follow-up, out of scope here.

Occluded totals are expected to drop materially (the solver now slides off
hidden ink wherever it has room); the per-class counts become the pinned
corpus baselines.

## Architecture

- **New `src/render/layout/seatInk.ts`** — the cleanliness oracle.
  `buildSeatInkOracle({ segments, joinCurves, strokeRank, colorOf, spacing })`
  snapshots the post-fan lane ink (all `segPath` pieces plus sampled join
  curves) into a uniform spatial hash and returns `dirtAt(p, lineId)`: the
  graded occlusion depth from strands of higher-ranked, different-colored
  lines within the sub-pitch threshold. Deterministic: sorted-key insertion,
  squared distances, `Math.sqrt` only, no trig.
- **`renderOctilinear.ts`** — hoist the `computePaintGroups` call above the
  placement queue and derive the global stroke rank from it (the emission at
  the end of `computeRibbonGeometry` reuses the hoisted result, keeping one
  source of truth). Build the oracle once after the fan builder. Per
  station, add `dirtAt(p, mk.lineId)` to the `ropts.proximity` closure;
  record per-mark dirt at commit into the `StopMark`s pushed to
  `stopsByNode`.
- **`reportStopSeating`** (debug module) — re-query the oracle at final mark
  positions and read the per-mark seat-time dirt to print the four classes
  and the per-class summary counts.
- **Diagnostics** — extend the `OCTI_PLACE_DEBUG` per-box diagnosis with
  clean/dirty state counts per bundle (how much clean freedom each station
  had), in the existing `rowPlace.debug` module.

Oracle staleness is accepted and monitored: the snapshot is taken before
marker machinery mutates lanes (slides, trims, crops), so a mark that ends up
on occluded ink through post-seat movement surfaces as `occluded-avoidable` —
that is the defect class the gate exists to catch.

## Out of scope

- Lone-stop and split-single sliding (no seat search exists for them today).
- Opaque-capsule regimes (rectRows/Tokyu): the capsule covers the ink under
  it; the census already exempts opaque-design crop windows. London bubbles
  and Toronto crossings consume final pill marks and inherit automatically.
- Cleanliness-aware lane-side choice in `buildLaneCurve` (two-longest rule)
  and crossing choice in `lineCrossNearest` (nearest-to-anchor rule):
  possible extensions if corpus cases show the substrate itself was the
  wrong pick.
- I4 transition clearance: mid-corridor rubs remain; dots merely stop
  seating on them.

## Caching and determinism

- `mapCache` VERSION 30 → 31 (drawn mark positions change). Fingerprint
  SCHEMA unchanged (no layout topology change; seating is draw-level).
- No Date/random; sqrt not hypot; sorted iteration; weights are constants.

## Verification gates

Behaviour-changing: the gate is the census battery plus tests plus visual
scrutiny, NOT byte identity.

- `npm test` green (new seatInk unit tests: hash correctness, rank/occlusion
  direction, same-color and own-line exclusions, grading on synthetic
  fixtures).
- `dev/robustness-check.ts dev/_robustness`: all 8 columns at or below the
  current row values; contiguity 0 is a hard gate.
- Pinned corpus: clips/loops/zigs/non-contig 0 everywhere; tapers ≤ 2 (HOR);
  spikes ≤ NYC 50 / SF 37 / SEA 13 / HOR 32 / DEN 5 / LON 7; stairs ≤ SF 1;
  twist census stays 0.
- Fanzone stop-mark census: `occluded-avoidable` = 0 (hard); occluded totals
  materially below today's; per-class baselines recorded.
- Before/after crops of the hot sites: WTC/Rector cluster, Court Sq, Times
  Sq, Montgomery, Bar Ilan, Neve Sha'anan; plus full-map diffs per city to
  bound seat churn.

## Risks

- **Seat churn**: a dominant new cost term reshuffles capsules corpus-wide.
  The occlusion predicate bounds it naturally (most seats have no foreign
  strand above them at all, so most costs are untouched); reviewed with
  full-map visual diffs, not just crops.
- **Extension trades**: a capsule may stretch its elbow toward the extCap
  bound to escape occluded ink. Bounded by construction; weight tuning on
  the corpus decides how much stretch a px of occlusion is worth.
- **Rank stability**: the oracle's stroke ranks are computed before marker
  machinery, the paint runs after it. Hoisting makes both read the same
  value, but if a future pass mutates `orderOf` between the two points the
  ranks silently drift; the `occluded-avoidable` gate makes that loud.
- **Crowded complexes**: WTC/Rector-class sites may have no un-occluded seat;
  the certified count stays positive by design. Do not chase it to zero with
  seat-search tweaks (three prior falsified fix families in this area were
  all attempts to fix placement problems downstream of layout spacing).
