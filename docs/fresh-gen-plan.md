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

**Implication for byte-identity:** the only effective lever is to cut the *call count*
(fold orientation into the DP state → `g!` instead of `g!·2^g`; or Held-Karp subset
DP; or pruning), and every one of those changes the enumeration/tie-break order → not
byte-identical (see §Rejected, §Ceiling). The remaining byte-identical candidates
(adjacency map, bbox pre-check) target <8% terms per the measurements and won't move
the dominant DP. **Conclusion: there is no meaningful byte-identical speedup for the
placement DP.** A real win requires relaxing byte-identity (validate by structural /
visual equivalence instead of pixel-identity).

The original plan below is kept for the record; Steps 1, 4-cheap-call analysis are
superseded by this outcome.

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
