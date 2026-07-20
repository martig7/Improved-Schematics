# Draw-robustness backlog: loops and incontiguities under a minimized warp

**Status:** collection + characterization only. No fixes were made. This is a
handoff for a follow-up RCA session.

> **Follow-up RCA correction (supersedes the headline claims in §2-§4).**
> A later RCA session root-caused these findings. The single most important
> correction: the "catastrophic" incontiguities were NOT draw defects. See
> §0 immediately below; the per-family tables in §3-§4 are kept as the raw
> census record but must be read through §0's reclassification.

---

## 0. Reclassification and fixes (follow-up RCA)

Every finding here falls into one of two buckets. Mixing them was the original
doc's central error: it read the contiguity census's numbers literally and
called the largest ones "catastrophic draw bugs" when the draw was in fact
producing connected ink.

### 0.1 Census-diagnostic artifacts (the draw was already correct)

**Contiguity, the catastrophic `*-LN` / regional / airport "splits" (§3.A, §3.B,
and the SF rows of §3.A).** `4-LN` @ Franklin Av (1342px), `E-LN` @ Briarwood
(2005px), SF `PH` / `Tempo` / `Gold Runner` / `Capitol Corridor`, and the
airport people-movers are all **branching routes**: a line that serves a spur,
or closes a terminal ring, has a node of degree >=3 in its own drawn ink, so it
is necessarily drawn as several SVG subpaths that meet at a **T-junction** (a
spur subpath's endpoint sits ON the trunk subpath's INTERIOR ink, not at the
trunk's endpoint). The contiguity census tested connectivity by chain-ENDPOINT
coincidence only, so it could not see a T-junction and reported the route as two
components whose "gap" is the distance to the nearest ENDPOINT (large by
construction, hence the 1000-2000px figures).

Evidence: `4-LN`'s west-spur subpath begins at exactly `(5752,7293)`, which is a
vertex on the trunk subpath's interior ink (the corridor edge is drawn
`(5752,7293)->(5870,7293)` as part of the main component). A thin-skeleton
render of `4-LN` at that junction shows one fully-connected line with no gap;
the two census "components" meet at the T. `E-LN` (2005px), and SF `PH` /
`Tempo` / `Gold Runner` / `Capitol Corridor` were verified the same way (all
report 0 breaks / N T-joins after the fix). The draw is correct; the ruler's
connectivity model was incomplete for branching routes.

Fix (diagnostic only, `reportContiguity`): a chain endpoint lying ON another
chain's SEGMENT within 2px now counts as connected (a T-junction), reported as
a distinct `T-joins` count. Proven to remove only false positives: a real gap
(an endpoint on empty canvas) stays flagged, because there is no ink for the
endpoint to land on. The §3.C hub seams below STAYED flagged (0 T-joins) under
this change until they were fixed in the draw.

**Loops, the phantom crossings (much of §4).** The loop census measured a
route's *traversal-concatenated painted track* (offset lanes strung together in
traversal-step order), not the drawn ink. When a course retraces or jumps
between non-adjacent traversal steps (`HOR` route `M` has a 2551px jump between
consecutive steps), the concatenation inserts a **phantom straight chord**
spanning the jump; that chord crossed the route's own real ink and was reported
as an artifact/bigloop. The drawn ink is a single clean subpath with no
self-crossing. Fix (diagnostic only, `reportPaintedLoops` -> `detectDrawnLoops`):
loops are now measured on the FINAL DRAWN ink (`drawnSegsByLine`, the same source
the contiguity census uses), within a chain and across two chains of one line;
no phantom chord exists, so retrace/jump routes no longer self-report.

### 0.2 Real draw defects (fixed in the draw, ruler unchanged)

**Contiguity hub seams (§3.C, and the small-gap families §3.D/E/F that are true
gaps).** `E` @ 50 St, `B` @ 5 Av/53 St, `D` @ Borough Hall, `A` @ 59 St (~45-90px)
are genuine breaks: the per-line assembler's `emitJoint` DECLINED a joint whose
two edges genuinely SHARE the traversal node but whose offset lane-ends were
farther apart than a fixed `maxGap` (`spacing*8`), which happens at a sharp turn
on a wide bundle. The decline exists to reject a pathological non-adjacent jump,
but here the node is shared and the lanes truly meet there. Fix
(`assemblePath.ts`): bridge the joint whenever the two edges share the joint
node; keep the `maxGap` decline ONLY for a non-shared-node teleport. The route
now draws continuously through the turn.

A second, related severance: a course can pass through a RUN of suppressed
jog-slivers (lanes the merge dropped as sub-pitch noise). The assembler already
carries the course across a suppressed sliver "in one stroke", but a run of them
spans several nodes, so the eventual bridge joint reaches across a gap larger
than `maxGap` between two NON-shared nodes and was declined (`D` @ East Broadway,
~45px, only at the tightest canvas). Fix (same guard): a joint that bridges a
suppressed-sliver run is forced through regardless of span, exactly like a
shared-node turn, because it is reconnecting real course the merge erased.

### 0.25 Corpus validation (full sweep, 32 dumps x 20 configs, 640 runs)

Before is the committed `run-summary.tsv` (old census + old draw); after is a
clean re-run with all four changes.

- **Contiguity: 224 -> 0 non-contiguities, 126 -> 0 distinct issues, corpus-wide,
  with ZERO regressions** (no config's contig count rose). Every one of the
  original breaks was either a T-junction false positive (§0.1) or a
  shared-node / suppressed-sliver bridge decline (§0.2).
- **Loops:** distinct ARTIFACT-loop issues 894 -> 321; non-micro (>=10px)
  594 -> 177 (large 73->15, medium 239->64, small 282->98). The drop is the
  phantom-crossing elimination (§0.1). The 177 non-micro residue are REAL drawn
  self-crossings (§0.3); the raw per-run count is flat-to-slightly-up only
  because drawn-ink measurement also surfaces small real junction hooks the
  painted-track census could not see, plus sub-pixel (<10px) junction-fillet
  nicks that tier out as micro.

### 0.3 Remaining real draw residue (characterized, not yet fixed)

Small junction/closure **hooks**: an airport terminal-ring closure curve laid
across an adjacent ring edge of the same line (JFK AirTrain at Terminal 4, a
small visible arrowhead), and spur-junction nubs (`4-LN` west-spur junction).
These are genuine drawn self-crossings, correctly flagged by the corrected loop
census (the terminal-ring TOPOLOGY is genuine and must be preserved; only the
overshoot/crossing is the artifact). They are deep junction-fan geometry with a
real risk of flattening the intended ring, so they are left for a focused
follow-up rather than a rushed fan change. Sibling AirTrain services (other
colors through the same terminal) close cleanly, so the fan CAN do it right; the
hook is specific to one line's lane offset at the junction.

The corpus residue's three real-hook families, by frequency:
1. **Airport terminal-ring hooks** (`JFK-H`/`JFK-J` @ Terminal 7/8/1, SF `PH` @
   Jackson & Leavenworth) — present at `base`, the most reproducible; the closure
   curve overshoots the ring vertex.
2. **Whole-hub fan loops under one warp alpha** (`42 St-Bryant Park` at `warp50`:
   `D`/`F`/`M`/`B` and their `-LN` variants ALL loop together) — one shared
   junction-fan construction failing at a specific spacing, not per-line.
3. **Tightest-pinch junction hooks** (many `medium`/`small` spots only at
   `growth1` / `noBoth_growth1` and `warp50`) — small local hooks the extreme
   canvas-preserving pinch or warp alpha provokes; absent at looser settings.

All three are junction-fan corner/closure geometry; the fix belongs in
`fanJoin.ts` (corner reach / closure clamp so a corner curve cannot cross an
adjacent bundle edge of the same line) and must be verified to preserve the
genuine ring topology.

---

**Why this exists.** The box warp is being reframed as a purely *aesthetic*
feature (breathing room + emphasis), so it will stop pre-spreading every tight
station pinch. When the warp stops rescuing pinched geometry, the draw pipeline
must still render it cleanly. The draw must never produce a **broken route
(incontiguity)** or a **self-crossing artifact loop**, at *any* warp setting, for
*any* input geometry. This document enumerates, as exhaustively as one overnight
sweep allows, every place where it currently does.

**Do NOT fix these by re-adding warp demand boxes.** Every issue here is a
draw-level defect (fan builder / per-line assembler / connector / merge). Fixing
it by making the warp spread the pinch again is exactly the coat-of-paint this
effort is retiring. Fixes belong in `src/render/renderOctilinear.ts`,
`src/render/fanJoin.ts`, and `src/render/layout/imageMerge.ts`.

---

## 1. How this was produced (reproduce any case)

The warp is simulated at various strengths by env knobs read in
`src/render/layout/densityBoxWarp.ts` and `src/render/renderGeographic.ts`.
Turning the warp's survival oracles off (or capping canvas growth) reproduces
the "minimized warp" geometry that the draw then has to handle.

### Reproduction scaffold (not committed)

To reproduce the exact minimized-warp geometry this sweep used, the worktree
carries two working changes that are **reproduction scaffolding only** and must
not land in a draw-fix commit:

1. `src/render/layout/densityBoxWarp.ts` was replaced with the version from the
   `feature/box-warp-linear-calibration` branch (the draw files
   `renderOctilinear.ts` / `fanJoin.ts` / `imageMerge.ts` are **byte-identical**
   between that branch and `master`, so draw fixes apply to either).
2. An env-gated filter was added to that file:
   `OCTI_BOX_CONTRACT_FILTER=capsule` drops contraction boxes fully contained in
   a capsule box (the falsified capsule-subsumption reduction), which is one of
   the contiguity-break producers below.

### Knobs (env)

| Knob | Effect | Meaning for the draw |
|---|---|---|
| `OCTI_BOX_CONTRACTION=0` | drop the contraction survival oracle | pinched pairs are no longer pre-separated |
| `OCTI_BOX_DENSITY=0` | drop the density aesthetic oracle | no regional dilation |
| `OCTI_BOX_DROP_TINY=0` | keep padding/lone-stop boxes | (mild) |
| `OCTI_BOX_GROWTH=<x>` | max per-axis canvas growth (default 2.5) | `1` = canvas-preserving → demand clawed back → *maximum pinch* |
| `OCTI_BOX_EXPAND=1` | demand multiplier = 1 | weaker per-box push |
| `OCTI_WARP=<a>` | scale the whole separable warp (`0` disables) | `0` = raw geographic pinch |
| `OCTI_BOX_CONTRACT_FILTER=capsule` | *scaffold*: drop capsule-nested contraction boxes | reintroduces the falsified reduction |

### Harnesses (all under `dev/`, gitignored)

| Script | Purpose |
|---|---|
| `dev/_dr_one.ts` | one `(dump, config)` run: full recompute + draw, parse every census to one JSON line |
| `dev/_dr_drive.ts` | Phase-A pool driver: 32 dumps × 20 configs |
| `dev/_dr_drive_b.ts` | Phase-B pool driver: fine growth/warp ladder on the sensitive dumps |
| `dev/_dr_agg.ts` | aggregate `dev/_dr_out/*.json` → dedup issues by `(city, route, nearest-station)` |
| `dev/_dr_crop.ts` / `_dr_cropbatch.ts` / `_dr_cases.ts` | render crops for representative cases |

Single-case reproduction (example):

```bash
# HOR's capsule-filter contiguity break (line 4 @ Kiryat HaSharon)
OCTI_BOX_CONTRACT_FILTER=capsule OCTI_LOOPS=1 OCTI_LOOP_SEGS=1 OCTI_CONTIG=1 \
  npx tsx dev/_dr_one.ts testdata/improvedschematics-map-HOR.json capsuleFilter

# render a crop around a census location (cx cy from the [contig]/[loops] line)
OCTI_BOX_CONTRACT_FILTER=capsule \
  npx tsx dev/_dr_crop.ts testdata/improvedschematics-map-HOR.json out.png 5034 1295 340
```

The censuses live in `src/render/debug/renderOctilinear.debug.ts`
(`OCTI_LOOPS` → `[loops]`, `OCTI_CONTIG` → `[contig]`; `OCTI_LOOP_SEGS=1` adds
the two crossing segments per loop).

### Sweep scope

- **32 dumps** (all `testdata/improvedschematics-map-*.json`: 12 NYC snapshots,
  5 SF, 4 LON, 5 SEA, HOR, DEN, TPA, 3 TPE).
- **46 configs** (20 in Phase A + 26 finer in Phase B).
- **816 successful runs** (0 degenerate, 0 draw-throws).

The full catalog is copied next to this doc under `docs/draw-robustness-data/`
(regenerate any time with `npx tsx dev/_dr_agg.ts`, which writes the `scratch_*`
originals):

- `docs/draw-robustness-data/digest.txt` — the full ranked digest this document
  summarizes (all 126 contig + all 594 non-micro loop lines). **Trackable.**
- `docs/draw-robustness-data/run-summary.tsv` — per-`(dump,config)` counts for
  all 816 runs. **Trackable.**
- `docs/draw-robustness-data/contig-issues.json` — 126 distinct contiguity
  breaks, each with every `(dump,config)` reproduction and geometry range.
- `docs/draw-robustness-data/loop-issues.json` — 894 distinct artifact loops
  (+51 genuine bigloops excluded), same shape.

(The two `.json` files are large and match the global `*.json` gitignore, so
they live in the worktree but do not travel via git; the `.txt`/`.tsv` do, and
either can be regenerated from `dev/_dr_out/` with `dev/_dr_agg.ts`.)

---

## 2. Headline numbers

Across 816 runs: **451 produced ≥1 artifact loop; 180 produced ≥1 contiguity
break.** Deduped by physical spot `(city, route, nearest-station)`:

- **126 distinct contiguity breaks.**
- **894 distinct artifact loops**, tiered by the crossing's diameter:
  large (≥80px) **73**, medium (30–80px) **239**, small (10–30px) **282**,
  micro (<10px, sub-pixel detector noise) **300**.

**No config is fully clean.** Even `base` (full warp, all oracles on) produces
**3 contiguity breaks** and **13 artifact-loop runs**. Those base-present cases
(§3.A, §4.A) are pure pre-existing draw bugs and are the highest priority: they
are *not* caused by minimizing the warp at all.

Config → issue-count is **not monotonic** with pinch severity. The tightest
pinch (`OCTI_WARP=0`, `growth1`) is *not* the worst for contiguity; a *mild*
canvas-growth cap (`growth1_25`, and the fine `growthF_1_1…1_3` band) triggers
the most distinct contiguity breaks. This means several breaks are threshold
effects of a specific spacing, not "everything collapses when tight" — the RCA
must sweep the growth ladder, not just test the extreme.

---

## 3. Contiguity breaks (a route drawn in ≥2 disconnected components)

A `[contig]` finding means one line's final ink splits into ≥2 components whose
nearest endpoints are `minGap` px apart (crop-window exemptions already removed).
`comp≤N` is the max component count seen.

### 3.A — Present at FULL WARP (`base`) — pre-existing, highest priority

These break with every oracle on. Minimizing the warp is irrelevant to them.

| City | Line | Near | gap (px) | dump | note |
|---|---|---|---|---|---|
| NYC | **4-LN** | Franklin Av-Medgar Evers College | 287–**1450** | NYC-EXTRA-DIFFICULT | catastrophic; 28 configs total |
| NYC | **E-LN** | Briarwood | 461–**2130** | NYC-EXTRA-DIFFICULT | catastrophic; 16 configs total |
| SF | **PH** | Powell & O'Farrell | 312–435 | SF-jul-10/14 | 11 configs |
| SF | **PH** | Powell | 155–184 | SF-jul-10 | 12 configs |
| SF | **Tempo** | 19th St/Oakland | 178–674 | SF-jul-14 | 2 dumps, 11 configs |
| SF | **Gold Runner** | Richmond | 109–170 | SF-jul-14 | regional rail |
| SF | **Capitol Corridor** | Richmond | 115–170 | SF-jul-14 | regional rail |
| SF | **AirTrain Blue** | SF International Airport | 34 | SF-jul-10 | airport people-mover |

**Pattern.** Every base-present break is a *non-trunk* line type: the NYC
`*-LN` "line-network" branch variants, SF named regional/rapid lines (PH, Tempo,
Gold Runner, Capitol Corridor), and airport people-movers. These have unusual
topology (isolated branches, express/local pairs, terminal stubs). Their ink is
severed into two pieces sitting hundreds—thousands of px apart. This is a
routing/placement/merge failure that severs the line, **not** a small seam gap.
The `-LN` cases (§ also 3.B) are the single largest and most reproducible family.

### 3.B — The `*-LN` branch-line family (NYC), across many configs

The `-LN` variant lines break contiguously at many places and under many
configs (including base for the two above). Distinct spots collected:

- **4-LN** @ Franklin Av (≤1450), Eastern Pkwy-Brooklyn Museum (≤871),
  New Lots Av (≤677), Park Pl (≤434).
- **E-LN** @ Briarwood (≤2130), Chambers St (≤2052, warp-alpha only),
  Kew Gardens-Union Tpke (491), Jamaica Center-Parsons/Archer (≤121),
  Jamaica-Van Wyck (87).
- **R-LN** @ DeKalb Av (≤90). Plus non-`-LN` branch/regional: **NER-1** and
  **Bronx Branch** @ Grand Central-42 St (≤121, at `warpF_0_1`).

`E-LN @ Chambers St` is notable: it breaks **only** under the warp-alpha ladder
(`noWarp`/`warp25…75`/`warpF_*`), never under the growth/oracle ladder — a
distinct trigger from the growth-cap cluster.

### 3.C — NYC interchange-hub cluster (growth-cap triggered)

Triggered by mild canvas-growth caps (mostly `growth1_25` and the
`growthF_1_1…1_3` band), highly reproducible **across 7 NYC snapshots** each
(same physical spot, so same bug):

| Line | Near | gap (px) | trigger |
|---|---|---|---|
| D | Borough Hall | 61 | growth1_25 (7 dumps) |
| E | 50 St | 55 | growth1_25 (7 dumps) |
| A | 59 St-Columbus Circle | 50 | growth1_25 (7 dumps) |
| B | 5 Av/53 St | 48 | growth1_25 (7 dumps) |
| F | 5 Av-53 St | 61 | growth1_25 |
| A / C | Jay St-Metrotech | 51 / 53 | growth1_25 |
| G | Court St, Lafayette Av | 54–67 | growthF_1_2/1_3 |
| B | York St | 48–71 | growthF/noBoth_growthF |

These are ~45–90px seam gaps at busy interchanges — the "mild pinch at a hub"
regime. Distinct from the catastrophic §3.A splits.

### 3.D — SF `growth1`-family cluster (oracle-off + tight canvas)

Triggered by `growth1` / `noBoth_growth1` / `noContraction_growth1` (tight
canvas with the contraction oracle removed), ~15–99px:
Lockheed Martin (B, 99), Orchard (G, 98), Judah and 12th Avenue (F, 68),
Contra Costa College (C, 15, 3 dumps), plus NYC East Broadway (D, 45),
CBX @ Roosevelt Av (28).

### 3.E — capsule-subsumption filter (the scaffold `OCTI_BOX_CONTRACT_FILTER=capsule`)

The falsified reduction reintroduces these (small gaps, ~15–95px):
HOR **line 4 @ Kiryat HaSharon** (53 — the task's flagged worst case),
NYC M / J @ Delancey St-Essex St (95 / 93), NYC E-LN @ Jamaica-Van Wyck (87),
SF N @ Ferry Building (15–28), NYC JFK-J✈ @ Terminal 1 (54).

### 3.F — HOR small-gap cluster (growth/capsule triggered)

Even Yehuda (line 3, ≤96, 19 configs), Apollonia (M, ≤96), Poliva (line 1, ≤88),
Mazkeret Batya (line 1, ≤133), Bnei Zion (U, ≤50), Geva St (line 1, ≤63),
Bar Ilan University (W, ≤45).

---

## 4. Artifact loops (a route's own ink self-crosses)

A `[loops]` `ARTIFACT` finding is a self-crossing whose enclosed diameter is
small enough that it cannot be a genuine route loop (genuine ones are reported
as `BIGLOOP` and excluded here). `OCTI_LOOP_SEGS=1` prints the two crossing
segments. **Ignore the 300 `micro` (<10px) issues** — they are sub-pixel
detector noise (e.g. SEA K @ 96 St `diam=0`, SF H/T @ Arleta `diam=3`); they are
listed in `scratch_dr_loops.json` but are not actionable defects.

### 4.A — Airport terminal people-mover loops (present at FULL WARP)

The dominant pre-existing loop family. The JFK AirTrain (unlabeled yellow route
`#fccc0a`) loops at **Terminal 4** identically across most NYC snapshots at
`base` (`at=(8561,5442)`, `diam≈153`; ~7 of the 12 NYC dumps show this exact
loop, the rest show the same family at Terminal 8/7 instead), plus JFK-H✈/JFK-J✈
@ Terminal 8 / 7 / 1 (`diam` 118–201, several at base) and SF **AirTrain
Blue/Red** @ the terminals, Garage A, Grand Hyatt (`diam` up to 157). These are
loop-/stub-shaped terminal
services whose octilinear fan self-crosses at the terminal. Because they recur
at `base` across every snapshot, they are the most reproducible loop defect in
the corpus and a clean RCA target independent of warp.

### 4.B — Interchange-hub crossing loops (largest artifacts)

| City | Route | Near | artDiam | trigger |
|---|---|---|---|---|
| SF | PH | Jackson & Leavenworth | ≤265 | capsuleFilter, warp75 |
| HOR | **M** | Bney Dror / Shikun Yaziv / Tel Mond | ≤234 | noBoth family (the task's flagged case) |
| SF | Tempo | 12th St/Oakland City Center | ≤231 | noBoth |
| SF | J | Powell | ≤225 | noBoth |
| SF | N / M / K / J | Van Ness/Market | ≤192 | growth1_5 (whole hub loops) |
| SF | S | Taylor & Francisco | ≤171 | growth2 |
| SF | B / G | Japantown/Ayer | ≤168 | growth1 family |
| NYC | D/M/F/B/D-LN/F-LN | **42 St-Bryant Park** | ≤98 | **warp50** (a whole shared hub loops at one alpha) |
| NYC | A / A-LN / K | 34 St-Hudson Yards | ≤46 | growth1 family |

Two sub-patterns worth separating: **whole-hub loops** where every line through
one interchange loops together at a specific setting (Van Ness/Market under
`growth1_5`; 42 St-Bryant Park under `warp50`) — these smell like one shared
fan/junction geometry failing — versus single-route loops.

### 4.C — HOR route M (the task's flagged case), confirmed

`HOR` route **M** self-crosses near Bney Dror / Shikun Yaziv where it crosses a
perpendicular trunk. `diam` 163–234. Triggers: `noBoth`, `noContraction`,
`growth1_5/2`, `capsuleFilter` (as `Shikun Yaziv`), and warp-alpha. The
crossing segments are a short off-corridor stub crossing a long (~2500px)
through-segment — the classic self-crossing "hook" where a jog taper is laid
across an absorbed span (see `fanJoin.ts` `sharpPin` / jog-taper handling).
**HOR base is fully clean (0/0/0)**, so this loop is entirely a
minimized-warp-exposed draw bug.

---

## 5. Config sensitivity (which knob surfaces what)

- **Loops** scale broadly with pinch: the hottest configs are `growth1`,
  `noBoth_growth1`, `noContraction_growth1`, `growth1_25`, `noBoth_growth1_5`
  (22/22/22/21/21 runs-with-loops). But 13 loop runs occur at `base` — a floor
  that no warp setting removes.
- **Contiguity** is dominated by the **canvas-growth cap** in the 1.0–2.25 band
  (`growth1_25`=12, `growth2`=10, `growth1`/`noBoth_growth1`=9, plus the whole
  `growthF_*` fine ladder). This is the non-monotonic signal: caps *near* 1.25
  break more hub seams than either the default 2.5 or the extreme 1.0.
- **Warp-alpha** (`OCTI_WARP`/`warpF_*`) is a *distinct* contiguity trigger,
  responsible for `E-LN @ Chambers St`, `NER-1`/`Bronx Branch @ Grand Central`,
  and SF Fort Mason Park — none of which the growth ladder reproduces.
- **capsule-subsumption filter** produces its own small-gap contiguity family
  (§3.E) that the plain oracle-off configs do not.

Practical implication for RCA: reproduce the branch-line splits (§3.A/B) at
`base`; reproduce the hub-seam cluster (§3.C) at `growth1_25`; reproduce the
warp-alpha splits at `warp50`/`warpF_0_1`. One config does not surface all.

---

## 6. Where to look (draw pipeline)

The censuses operate on the *final drawn ink*, so every issue is downstream of
layout. Likely origins:

- **`src/render/renderOctilinear.ts`** — the per-line assembler and connectors.
  Contiguity components that sit tens of px apart at a hub (§3.C/D) are most
  likely a connector/lane-join that fails to bridge two edge lanes at a pinched
  node.
- **`src/render/fanJoin.ts`** — the junction fan builder (miter caps, sharp
  pins, jog tapers, self-crossing "hook" suppression at l.413+). The hub loops
  (§4.B) and the HOR-M hook (§4.C) are fan/join geometry: a fan reach or jog
  taper laid across an absorbed span that crosses back over itself.
- **`src/render/layout/imageMerge.ts`** — merge, fold-collapse, and per-line
  splice (`splitAtLattice`, twin-strand fold handling, manufactured fold-stub
  collapse at l.390+). The **catastrophic branch-line splits** (§3.A/B, the
  `*-LN` lines whose ink lands 1000–2000px away) are the prime suspect here: a
  fold collapse or service-conserving splice that severs a branch variant's ink
  and re-homes one component far from the rest. Start with
  `NYC-EXTRA-DIFFICULT` `base`, lines `4-LN`/`E-LN`.

Suggested RCA order (severity × reproducibility):
1. `*-LN` / regional branch-line component splits at `base` (§3.A/B) — worst and
   warp-independent.
2. Airport terminal loops at `base` (§4.A) — most reproducible loop.
3. NYC hub-seam contiguity cluster at `growth1_25` (§3.C) — 7-snapshot stable.
4. Whole-hub loops (Van Ness/Market `growth1_5`, 42 St-Bryant Park `warp50`) (§4.B).
5. HOR-M hook (§4.C) and the capsule-filter small-gap family (§3.E).

---

## 7. Caveats

- `micro` loops (<10px, 300 of them) are detector noise; do not chase them.
- The `at=` pixel coordinates are in each run's warped space, so they differ per
  config for the same physical spot; the nearest-station label is the stable
  identifier used for dedup.
- A handful of "large" loop instances in the raw data are genuine route loops
  the classifier split as `BIGLOOP`; the artifact list already excludes lines
  that were *only* ever bigloops, but a spot that is a bigloop under one config
  and an artifact under another is kept (the artifact instance is the actionable
  one).
- Representative crops are under `dev/_dr_crops/` (gitignored); regenerate with
  `npx tsx dev/_dr_cases.ts > scratch_dr_cases.json && npx tsx dev/_dr_cropbatch.ts scratch_dr_cases.json`.
