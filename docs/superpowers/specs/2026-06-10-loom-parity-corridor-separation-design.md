# LOOM parity: corridor separation + Tacoma clump — design

Date: 2026-06-10
Status: approved (user, this date)
Investigation: workflow wf_96e78406-5c8 (three-agent attribution + dHat sweep); artifacts under `dev/_parity-*`

## Problem

Comparing our smoothed render of the live Seattle save (`dev/_dump.png`) against the
user's LOOM reference (`dev/out-loom-sea.png`):

1. **Blue/pink conjoining.** Routes D (`6b681564`, #0039a6) and H (`a3f11a38`, #b933ad)
   run 0.9–1.6 km apart down parallel avenues (Hanford St → 118 St), meeting only at the
   two end junctions. LOOM draws two separate corridors; we weld the entire ~335px stretch
   into one corridor (support edges `he441..he452` carry both lines). A second weld (D +
   route I `bbf5a87e`) extends a genuine 60 m meeting at 2 St/Benson Rd into a ~81px shared
   corridor (~20× LOOM's extent).
2. **Tacoma clump.** The SW cyan sub-network renders as a mush of 3–6-lane welded ribbons
   with capsule glyphs; LOOM renders a sparse radial star of single lines.

## Root causes (measured)

- **Q1 is the merge-round refeed, not the merge radius.** Merge round 1 keeps D/H apart
  (20px genuinely shared). `inputFromBuilder` (`src/render/layout/topo.ts`) re-feeds each
  merged corridor into round 2 as a straight **endpoint chord**; two bowed corridors
  between the same junction pair become near-identical chords and weld at *any* dHat
  (sweep: weld survives at dHat=4). A dHat sweep (16/12/8/6/4) showed 16 is the best
  value: smaller radii fragment Tacoma and the wider map. dHat stays 16.
- **Q2 has two primary causes.** (a) Over-merge: 55% of cyan corridor length carries ≥2
  welded routes (max 6; LOOM: 1%, max 3); trunk centerlines sawtooth (polyline/chord
  ratio 2.75) oscillating between swallowed parallel tracks. (b) Scale: LOOM draws
  20 m lines on 2300 m cells (cell/lineWidth ≈ 115); we draw 5px lines on ~15px cells
  (ratio 3), so parallel corridors sit 3–6 line-widths apart vs LOOM's 18–27.
- **Exonerated:** LOOM's `loom` stage (untangle/prune) is geometry-neutral (it only
  permutes line order within bundles; `Optimizer.cpp:277`, `LineEdgePL.cpp:152-159`) —
  porting it would not affect either problem. densityPen likewise irrelevant here (both
  pipelines collapse deg-2 chains; spring cost never shapes these areas).

## Design

### 1. Geometry-preserving merge refeed

In `inputFromBuilder` (`src/render/layout/topo.ts:572-589`), replace
`points: [a, b]` with the corridor's real polyline simplified by the existing
module-private `simplifyRdp(e.points, eps)` at **eps = dHat** (dHat/2 measured worse:
299 edges / 47 spurious pairs vs 231 / 30), endpoints re-pinned to the current node
positions. Interactions: runs after `cutPolylineFolds` sanitation (folds already
excised), before contraction passes; the historical "re-walking interiors re-densifies
and fragments" concern is defused by RDP — measured 237 → 231 corridor edges, no
fragmentation.

Measured effects (simulation `dev/_parity-q1-fix.ts`): D+H shared corridor 344px → 48px
(only genuine ≤22 m end-approaches remain), D+I 100px → 69px; spurious line-pair welds
vs LOOM-topo ground truth 40 → 30, including the largest Tacoma cyan welds (Z+U 1644px,
V+U 526px, W+Y 289px, W+U 287px). Known residuals to eyeball in verification: a few new
small spurious pairs (4+2 ≈ 414px, 2+X ≈ 482px, C+J ≈ 285px) and one new missing-vs-LOOM
pair (B+3, 383 m).

### 2. Tacoma spacing: joint grid-coarseness + line-width sweep

With corridors unmerged, parallels must land ≥ several line-widths apart or the clump
re-mushes (one fine cell = 3 line-widths today). Jointly sweep, on the live dump,
with fix 1 applied:

- grid divisor: 2.5 (current), 1.6, 1.2, 1.0 (`cellSize = max(12, medLen/divisor)`), and
- theme line width: current 5px and thinner candidates (~3.5px, ~2.5px) — user approved
  thinner lines; stops/capsule radii and lane gap scale with `LINE_WIDTH` constants in
  `src/render/constants.ts`.

Pick the combination by the investigation's quantitative criteria plus visual crops
(below). Ship the chosen defaults in `renderSmoothed`; keep `OCTI_DIVISOR` override.

### 3. Capsule cleanup

Most SW capsules should disappear once station groups stop straddling welded-parallel
corridors. After 1+2, if capsule noise remains in the clump: suppress transfer capsules
joining nodes whose drawn positions are < ~2 grid cells apart in favor of a single
marker (they denote the same group split across corridors that octi placed adjacent).
Far-apart group members keep the bracket treatment (existing transfers primitive).

### Non-goals

- No port of LOOM's `loom` stage (geometry-neutral; revisit only for line-ordering
  quality inside genuinely shared bundles).
- No dHat change (16px stays; sweep evidence).
- Full-station octi mode stays parked behind the diagnostic `combineDeg2:false` flag /
  `OCTI_NO_COMBINE=1`; even intermediate-station spacing is accepted (it is also what
  the LOOM reference did).
- The zero-offset partial-coincidence overdraw bug in `imageMerge` is tracked as a
  separate spawned task (`task_fa2ee89d`), not in this scope — fix 1 must not regress
  it at dHat=16, which the SVG-scan check below guards.

## Verification

Quantitative (probes exist from the investigation; re-run after each stage):

- D+H shared support-corridor length ≤ 60px; D+I ≤ 70px (`dev/_parity-q1-support.ts`).
- Tacoma window: cyan length-weighted multiplicity ≤ 1.1; no support edge with
  sawtooth (polyline/chord) factor > 1.3; transect corridor spacing ≥ 6 line-widths;
  near-duplicate drawn pairs (< 2 cells apart, disjoint lines) ≈ 0
  (`dev/_parity-sw-anatomy.ts`, `dev/_parity-sw-mult.ts` patterns).
- No same-coordinate different-color path pairs in the output SVG
  (`dev/_parity-dhat-svgscan.ts` pattern) — guards the overdraw bug at default params.
- Full suite (`pnpm test`, 125 tests) + new unit tests for the refeed (bowed-parallel
  corridors stay separate through merge rounds; genuine ≤dHat parallels still weld).

Visual checkpoints (user preference): full map + center window (blue/pink) + SW window
crops from the live dump at each stage; NYC checkpoint + geojson Seattle render as
regressions; final in-game check via panel reload (game hot-loads the mod bundle).

## Risks

- RDP-refeed changes merge dynamics globally: watch the three known new small spurious
  pairs and the B+3 missing pair; acceptance is "strictly better overall," not zero
  diffs.
- Coarser grids previously caused detour chaos in *full-station* mode; in comb mode
  divisor 1.2 is already production behavior for >800-edge graphs. The sweep decides
  empirically; if no divisor beats 2.5 once multiplicity drops, keep 2.5 and rely on
  thinner lines for spacing legibility.
- Thinner lines affect every mode and save (NYC bundles get thinner too) — the
  regression renders cover this; treat line width as a theme default change with
  explicit before/after crops.
