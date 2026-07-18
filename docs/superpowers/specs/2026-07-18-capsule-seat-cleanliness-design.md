# Capsule seat cleanliness (I10) — design

Final junction-fan-rebuild milestone. The interchange capsule machinery ranks
its seat candidates by ink cleanliness (invariant I10,
`docs/draw-geometry-invariants.md`): clean octilinear seats first, overlapped
octilinear seats second, non-octilinear constructions last. Companion
deliverable: the fanzone stop-mark census learns to classify its intrusions
(avoidable defect vs solver-certified least-bad vs lone-stop), so it becomes a
gateable ruler instead of a raw count.

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
- **Two oracle terms, both derived (I7), no fixed constants:**
  1. **Fan-zone penetration** — mirrors the census's own test exactly (same
     zones list from the fan builder, same lateral bound
     `halfWidth(edgeA) + spacing`, same along-vs-reach rule, same exemptions),
     so the search and the ruler cannot disagree about what a zone is.
     Graded by penetration depth toward the node.
  2. **Foreign-strand overlap** — distance from the dot to the nearest strand
     of a non-member line below the clip census's sub-pitch threshold
     (0.75 · spacing), graded by deficit. Catches overlapped ink outside
     zones (transition rubs, coincident strands) per I10's letter.
- **Exclusions mirror the census.** Not counted as dirt: the mark's own line;
  lines that are members of the station being seated (their lanes are what
  the row must cross — crowded-but-normal interchange geometry is I4's
  territory, not a seat choice); zones whose node is the station's own node or
  split base; zones on the station's own corridor when the corridor is shorter
  than the zone reach (the census's no-legal-seat rule — penalizing an
  inescapable zone would only distort the other cost terms).
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

`reportStopSeating` keeps its geometric test and existing exemptions
(own-node, joinStopPos fan seats, own-corridor no-room) and splits its count
into three reported classes:

- **`capsule-avoidable`** — intrusion by a multi-mark station whose recorded
  seat dirt is ZERO (the solve thought the seat was clean; the census says it
  is not). Only oracle blind spots and post-seat movement (slides, trims,
  split connectors) produce these. **Hard gate: 0 corpus-wide.**
- **`capsule-certified`** — intrusion whose recorded dirt is positive: the
  solver searched and no clean seat existed within its freedom (the
  WTC/Rector class). Watch count with new pinned baselines; driving it down
  is layout-spacing / I3 escalation work, not seat-search work.
- **`lone-stop`** — single-mark units, which have no seat search. Watch
  count; a lone-stop slide is a possible follow-up, out of scope here.

Total intrusions are expected to drop materially (the solver now avoids every
zone it can); the new per-class counts become the pinned corpus baselines.

## Architecture

- **New `src/render/layout/seatInk.ts`** — the cleanliness oracle.
  `buildSeatInkOracle({ segments, joinCurves, zones, basePoly, halfWidthOf,
  nodePx, spacing })` snapshots the post-fan lane ink (all `segPath` pieces
  plus sampled join curves) into a uniform spatial hash and returns
  `dirtAt(p, excl)` where `excl` carries the per-station exclusions (member
  line ids, own node ids). Deterministic: sorted-key insertion, squared
  distances, `Math.sqrt` only, no trig.
- **`renderOctilinear.ts`** — build the oracle once after the fan builder,
  before the placement queue (zones and post-fan segPath are both live
  there). Per station, wrap it with the exclusion set and add it to the
  `ropts.proximity` closure; record per-mark dirt at commit into the
  `StopMark`s pushed to `stopsByNode`.
- **`reportStopSeating`** (debug module) — read the per-mark dirt to print
  the three classes and the per-class summary counts.
- **Diagnostics** — extend the `OCTI_PLACE_DEBUG` per-box diagnosis with
  clean/dirty state counts per bundle (how much clean freedom each station
  had), in the existing `rowPlace.debug` module.

Oracle staleness is accepted and monitored: the snapshot is taken before
marker machinery mutates lanes (slides, trims), so a mark slid into a zone
after seating surfaces as `capsule-avoidable` — that is the defect class the
gate exists to catch.

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

- `npm test` green (new seatInk unit tests: hash correctness, exclusion
  rules, zone-term parity with the census test on synthetic fixtures).
- `dev/robustness-check.ts dev/_robustness`: all 8 columns at or below the
  current row values; contiguity 0 is a hard gate.
- Pinned corpus: clips/loops/zigs/non-contig 0 everywhere; tapers ≤ 2 (HOR);
  spikes ≤ NYC 50 / SF 37 / SEA 13 / HOR 32 / DEN 5 / LON 7; stairs ≤ SF 1;
  twist census stays 0.
- Fanzone stop-mark census: `capsule-avoidable` = 0 (hard); total intrusions
  materially below 64; new per-class baselines recorded.
- Before/after crops of the hot sites: WTC/Rector cluster, Court Sq, Times
  Sq, Montgomery, Bar Ilan, Neve Sha'anan; plus full-map diffs per city to
  bound seat churn.

## Risks

- **Seat churn**: a dominant new cost term reshuffles capsules corpus-wide.
  Mitigated by the exclusion rules (member lanes and inescapable zones do not
  perturb costs) and by reviewing full-map visual diffs, not just crops.
- **Extension trades**: a capsule may stretch its elbow toward the extCap
  bound to escape a zone. Bounded by construction; weight tuning on the
  corpus decides how much stretch a px of dirt is worth.
- **Oracle-census drift**: the two share the zone test by construction, but
  the strand term and post-seat movement can disagree; the
  `capsule-avoidable` gate makes any drift loud instead of silent.
- **Crowded complexes**: WTC/Rector-class sites have no clean seat; the
  certified count stays positive by design. Do not chase it to zero with
  seat-search tweaks (three prior falsified fix families in this area were
  all attempts to fix placement problems downstream of layout spacing).
