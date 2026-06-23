# Fresh-generate speedup — plan (byte-identical)

The geometry cache made *reloads/toggles* fast, but a **fresh** Generate still pays
the marker-placement solve once (SF/London ~50–60s). This plans that speedup under a
hard constraint: **the rendered map must stay byte-identical** (same svg string +
same Scene IR) for every step here. Relaxing that is a separate, later decision (see
§Ceiling).

## OUTCOME — Step 1 (pairEval memoization) FAILED; reverted

Implemented + measured + **reverted**. Clean back-to-back A/B (min-of-5, cached pre,
cold draw; `dev/_ab-cold.ts`): the memo was **5–6× SLOWER**, not faster — chi
1301→7876ms, nyc 4141→18904ms, sea 7135→35256ms. It was byte-identical (gate passed)
but a severe perf regression.

**Why the plan was wrong:** the research reasoned from `pairEval` *call count*
(25–150M) and assumed collapsing the redundancy would help. But each `pairEval` is
**~50ns** — for the common infeasible pair it returns at the *first* dot-floor
violation (one `hyp`). A `Map` key-compute + `get` + `set` costs *more* than that, and
the per-`solveRows` cache balloons to millions of entries (GC pressure). Memoization
only wins when per-call cost ≫ cache-op cost; here it's the opposite. **This is a
"many cheap calls" problem, not a "few expensive calls" problem.** The cost is the
sheer call *count* (the `g!·2^g` enumeration), each call already near-minimal.

**Implication:** the effective lever is to cut the *call count*. The cleanest is to
**fold orientation into the DP state** — make each chain position choose state AND
orientation jointly, so ONE DP per permutation replaces the `2^g`-mask loop. This
removes the `2^(g-2)` cross-mask redundancy by *restructuring* (no cache → none of the
per-call overhead that sank the memo).

## OUTCOME — orientation fold SHIPPED (commit b19db1a), 1.2–2.4× faster, byte-identical

Implemented the fold with one subtlety: `stationFloorsOk` is an all-pairs check, not
chain-decomposable, so it can't go inside the folded DP. When the cheapest chain over
all orientations violates a floor, fall back to the exhaustive per-mask search **for
that permutation only** — recovering the *exact* feasibility outcome. This makes the
mega-box set provably unchanged (`best` is null ⇔ no permutation has a passing chain,
which the fold reaches exactly when the mask-enum did).

Measured (cold/fresh draw, min-of-N A/B; `dev/_ab-cold.ts`):

| city | baseline | folded | speedup |
|---|---:|---:|---:|
| Chicago | 1275ms | 1061ms | 1.20× |
| NYC | 4119ms | 3343ms | 1.23× |
| Seattle | 7079ms | 4685ms | 1.51× |
| SF | 49094ms | 20138ms | **2.44×** |
| London | 66334ms | 30601ms | **2.17×** |

Gains scale with multi-bundle (high-g) station density — the painful big cities win
most (SF 49→20s, London 66→31s).

**Byte-identity bonus:** despite relaxing the constraint, the output is **byte-identical
on all 5 cities × toggle states** (golden svg + Scene IR), because float placement
costs don't tie in practice, so the fold and the mask-enum converge on the same
global-min chain. It is *not guaranteed* identical if an exact cost tie ever occurs
(equal-cost orientations could then resolve differently) — but quality is still held by
the box-count bar (chi 1 / nyc 0 / sea 0 / sf 18 / lon 1, unchanged). Verification gate:
golden master + `dev/_quality.ts` box counts + 292 tests + tsc.

## OUTCOME 3 — Held-Karp subset DP for g=5 SHIPPED (commit 6df1e31), London ~3.4×

After the fold, a per-g profile (`dev/_gperf.ts`) showed the remaining cost is NOT
uniform: a single **g5** station was **~80% of London's** placement cost (~24s, because
the folded enumeration is still `g!`=120 DPs), while SF/Seattle are g≤4. Held-Karp
collapses the `g!` permutations into an `O(2^g·g²·states²)` subset DP (each ordered
bundle-pair evaluated `2^(g-2)`=8× vs `(g-1)!`=24× → ~3× fewer `pairEval`).

Used as a fast pre-pass; on a floor failure it falls back to the folded enumeration, so
the mega-box set is preserved exactly. **Gated to g=5**: a first cut applied at all g≤5
*regressed SF 1.4×* — SF-difficult has 18 boxes, so many g4 stations' cheapest chain
fails the floor and pays both the subset DP *and* the fallback. g≤4 stays on the fold.

Result: London cold draw **~30s → ~8–9s (~3.4×)**; chi/nyc/sea/sf unchanged. Box counts
identical, **byte-identical on all 5 cities × toggle states** (the g5 station's HK chain
matched the fold's). Verified HK cost == folded-enum cost on every station (zero
mismatch, `CHECK_HK` self-check). tsc 31, 292/292.

### Still on the table (not done)
- The dominant *broad* cost is now the per-pair `states²` cross-product (g2/g3 stations,
  unaffected by the fold/Held-Karp). A **slide-state window/prefilter** (only nearby
  slides can pair feasibly) would cut `states²` for ALL g — likely the next-biggest
  lever — but it touches tie-breaks (box-count bar, not byte-identity). Measure first.

The original plan below is kept for the record (Step-1 memo superseded by the fold).

## Root cause (measured, finer than before)

Instrumented sub-phase profile of the placement (cold draw, chi/nyc/sea):

| sub-phase | chi | nyc | sea | scaling |
|---|---:|---:|---:|---|
| incident-edge / adjacency gather | 0.3ms | 0.9ms | 0.8ms | flat — **not** a factor |
| buildStates (per-bundle geometry) | 50ms | 348ms | 61ms | ~linear, sub-dominant |
| **pairing enumeration + chain DP (`pairEval`)** | **1239ms** | **3217ms** | **6044ms** | **the super-linear culprit** |
| §6 cross-station `blocked()` mask | 8ms | 190ms | 30ms | O(stations²), minor (<6%) |
| mega-escape + collision slide | 119ms | 408ms | 551ms | mildly super-linear, ~7–8% |
| terminus trim / eviction | 22ms | 89ms | 24ms | small |

The dominant 83–90% is the **pairing/chain-DP inside `solveRows`** (`rowPlace.ts`),
and it is **factorial in the per-station bundle count `g`** (the number of lane
bundles meeting at an interchange, capped ~5) — **not** in station count. Evidence:
- `pairEval` is called **25.6M (chi) / 69.7M (nyc) / 150.1M (sea)** times.
- Seattle has *fewer* nodes than NYC (483 vs 491) yet costs ~2× — because it has a
  g4 station: Seattle's per-g DP time is g2=1704ms, g3=1586ms, **g4=2759ms**, and
  that single g4 station fires **59.4M** `pairEval` calls. NYC has zero g4 stations.

Per multi-bundle station the work is ≈ `O(g! · 2^g · S² · D²)` where `S`≈388 row
states/bundle and `D`=dots/bundle: `rowPlace.ts` enumerates all `g!` orderings ×
`2^g` orientation masks, each running a chain DP (`runDP`, O(states²)) whose inner
step calls `pairEval` (O(dots²)).

**Importantly, the earlier "incident-edge scans" hypothesis was wrong** — those are
<1ms in the seating phase (they only matter, mildly, inside the slide passes).

## The plan — staged, each behind the byte-identical gate

### Step 1 (the win): memoize `pairEval` within each `solveRows` call
`pairEval(P, op, Q, oq)` is a pure, deterministic function of two bundle *states*
(`P = bundleStates[seq[k-1]][pi]`, `Q = bundleStates[seq[k]][qi]`) and two orient
bits. Across the `g!·2^g` enumeration the **same** ordered (bundle-pair, state-index,
orient) quadruples recur enormously — the 25–150M calls collapse to at most
`#orderedBundlePairs · S² · 4` distinct evaluations.

- **How:** a `Map` created fresh at `solveRows` entry, keyed by the six integers
  `(seq[k-1], pi, orients[k-1], seq[k], qi, orients[k])`; on miss call `pairEval`
  and store (including `null`). Wrap the call site in `runDP` (~rowPlace.ts:417).
  **Never key on floats.** Fresh cache per call is mandatory (bundleStates are
  rebuilt for the base / wide-window / box-rescue retries).
- **Byte-identical: yes.** Returns bit-identical `PairRes`, so the strict-`<` argmin
  (L420), the `prev[pi] >= best` prune (L416, still sound — cached cost identical and
  ≥0), the final end pick (L433–435), and `tryPairing`'s strict-`<` (L451) are all
  untouched. No reordering, no tie-break change, no float-accumulation change.
- **Gain:** directly attacks the 83–90% term. ~1.5–2.5× on the heavy multi-bundle
  cities (Seattle/SF/London with g3/g4 stations); less on Chicago.

### Step 2 (safe structural scaling): node→incident-edges adjacency map
Build `incidentByNode: Map<nodeId, Edge[]>` in **one pass over `layout.edges` in
array order** (push each edge into its `from` and `to` bucket). Replace every
`for (const e of layout.edges) if (e.from!==nid && e.to!==nid) continue` scan
(`ldegOf`, `lanePolysAt`, `lanePointAt`, the `sets` grouping, `laneEdgeArc`, the four
incident counters) with iteration over the bucket.

- **Byte-identical: yes, with care.** A stable in-order build yields each node's
  edges in the *same relative order* as the filtered scan — required because
  consumers select by first-/nearest-/best-match and the union-find grouping breaks
  on the *first* shared edge id (Set insertion = edge order). **Self-loop guard:** if
  `e.from === e.to`, push once (the original `continue` skips it a single time).
  Must build from `layout.edges` directly, never from a Set/Object.
- **Gain:** modest for chi/nyc/sea (the scans are negligible there), but improves
  large-map (SF/London) scaling inside the slide passes (~7–8%). It's the *safest*
  change; do it for the big cities, don't expect it to move the small ones.

### Step 3: re-measure, then decide
Transiently re-add the env-gated `PLACE_PERF`/`SR_PERF` instrumentation (zero overhead
when off), re-profile chi/nyc/sea. Steps 1–2 shift the bottleneck mix — **do not
implement 4–5 blind.**

### Step 4 (conditional): second-order terms
- **Spatial grid for `blocked()`** (§6 cross-station mask): index `placedDots` into a
  uniform grid (cell ≥ threshold `2·r·xMaskFactor−0.05`), query the 3×3 neighborhood,
  run the *identical* `hyp() < threshold` test (never a squared-distance substitute).
  Byte-identical (boolean any-within-threshold is order-insensitive). Only if NYC's
  residual matters (~190ms).
- **Cache `boxOf(s)` per station**, invalidating on any `mk.pos` mutation
  (`applySlide`, mega-escape commit, eviction). Value is pure; the entire risk is
  invalidation bookkeeping. Only if the slide passes are hot on SF/London.

## Rejected for the byte-identical phase (and why)
- **Branch-and-bound / prune the `g!·2^g` enumeration** — this is the only way to
  attack the DP's *exponential-in-g shape* (not just its redundancy), but it touches
  the global strict-`<` first-found tie-break over the perm×mask order, which
  determines the winning seq-mask (→ positions/order/`cornerAfter`). Can't be proven
  output-preserving. Step 1 removes the redundant work *without* changing enumeration
  order, so it's the right first move.
- **Bucketing DP states by axis** — changes the `pi` iteration order the strict-`<`
  argmin and the prune depend on.
- **Parallelizing the placement loop** — illegal: `placedDots[]` is a strict
  sequential dependency and the placement order (`marks.length` DESC, then `nodeId`
  raw code-unit) is output-determining.
- **`Math.hypot` for `Math.sqrt(a*a+b*b)`** — not correctly-rounded cross-V8; a
  last-ULP diff flips `<minGap`/`<bestD`/threshold comparisons. Never substitute.
- **Non-stable sorts; coarsening the discretization grids (step 0.5, arc windows,
  d-step 4, box-rescue 0.25); recomputing the atan2 axis quantization in other units.**
  All move seated positions.

## Verification gate (run every step, all 5 cities)
1. `npx tsc --noEmit` — clean (31-error baseline, zero new).
2. `npx tsx --test "src/**/*.test.ts"` — **292/292** (esp. `rowPlace`, `capsuleSlide`,
   `chainPlace`, `offsets`, `geometryCache`).
3. Golden master: `npx tsx dev/_golden-draw.ts > dev/_golden/after.txt` then
   `diff dev/_golden/baseline.txt dev/_golden/after.txt` — **zero diff on all 11
   lines** (chi/nyc/sea ×3 toggle states, sf/lon ×1). This is a *draw-side* change, so
   the cached `pre` must not change — do **not** pass `GOLDEN_FRESH`. Never restrict
   via `GOLDEN_CITIES` (checking a subset is how an NYC regression slipped before).
4. Determinism double-run: run golden twice, diff `after.txt` vs `after2.txt` — flushes
   any introduced ordering nondeterminism.

A step lands only when all four pass. Revert any transient instrumentation and confirm
`git diff --stat` is empty for it before committing.

## Ceiling — what byte-identity costs us
Byte-identity caps the achievable win at removing *redundancy* (Step 1's ~1.5–2.5×)
plus structural scaling (Step 2). It cannot attack the DP's exponential-in-`g` shape
itself, nor parallelize the sequential solve — those need the byte-identical
constraint relaxed (accepting "equivalent-quality but not identical" placement). That
is the next frontier and a deliberate future decision, not part of this plan. Net:
ship Step 1, then Step 2, then re-measure.
