# Cache-read latency — diagnosis + fix plan

The fingerprinted layout cache (Plan B) made a reload skip the octi *precompute*,
but the cache read is "still too long." Measured why, then traced where the cost
lives and whether it can be hoisted out of the per-draw path.

## Measurements (real city dumps, warm, median; `dev/_cache-bench.ts`)

What a cache HIT actually pays:

| city    | stored | localStorage read+`JSON.parse`+Map-rebuild | **`drawSmoothedSchematic`** | hit total |
|---------|-------:|-------------------------------------------:|----------------------------:|----------:|
| Chicago | 1.0 MB | ~19 ms | **1,525 ms** | ~1.5 s |
| NYC     | 0.7 MB | ~33 ms | **4,590 ms** | ~4.6 s |
| Seattle | 1.3 MB | ~36 ms | **7,793 ms** | ~7.8 s |
| SF      | 1.9 MB | ~49 ms | **51,726 ms** | ~52 s |
| London  | 3.2 MB | ~46 ms | **69,906 ms** | ~70 s |

**Deserialize is negligible (20–50 ms). The whole cost is the DRAW** — which still
runs on every hit, because the cache stores the *precompute* (`pre`), and the draw
(`drawSmoothedSchematic` → `renderRibbons`) re-derives the svg + Scene from it.

## Where the draw time goes (instrumented; `dev/_draw-perf.ts`)

Per-phase split of the draw (temporary timers in `renderRibbons`, reverted):

| city    | total | **marker placement** (`rowPlace`, 811/953) | collision slide (1274) | lane geometry (199–810) | renderStops | labels |
|---------|------:|-------------------------------------------:|-----------------------:|------------------------:|------------:|-------:|
| Chicago | 1323 ms | **1089 ms (82%)** | 127 ms | 8 ms | 2 ms | 90 ms |
| NYC     | 4326 ms | **3481 ms (80%)** | 470 ms | 15 ms | 6 ms | 340 ms |
| Seattle | 7848 ms | **6984 ms (89%)** | 577 ms | 18 ms | 3 ms | 257 ms |

The dominator is the **rigid-row marker-placement solver** (`rowPlace`) — **not**
the lane/ribbon geometry (a negligible ~15 ms; the earlier "base ribbon geometry"
framing was wrong), not the collision slide, not labels (3–7%) or `renderStops`
(<0.1%). Placement is the super-linear term: NYC→Seattle, stations grow ×1.14 but
placement grows ×2.01 (the slide is only ~linear). That super-linearity is what
turns into 52 s / 70 s on SF / London.

## Root cause

The cache skips octi but not the draw, and the draw is ~90% the marker-placement
solver — which the cache never stored. So cache-read latency ≈ placement time =
1.5 s (Chi) to 70 s (London).

## Is the placement hoistable out of the draw and storable? — YES (verified)

Dependency analysis + an adversarial refutation pass (which tried to break it)
both confirm: the entire geometry + marker-placement output is a **pure function
of `pre`** plus fixed layout constants. Crucially, it is **independent of every
user-mutable draw option**:
- `stationRadius` and `labelScale` are **never passed into the smoothed draw path**
  — `drawSmoothedSchematic` forwards only `{showLabels, showStations}`
  (`schematic.ts`); the marker radius used in all collision/slide math is the
  constant `LINE_WIDTH*0.7`.
- `showLabels` / `showStations` are read **only after** placement finishes
  (`renderStops` bullet visibility at ~1996, `placeLabels` at ~1997).
- `dark` is color-only and already baked into `pre.dark` at precompute.

Adversarial search of `renderRibbons` and everything it calls (`rowPlace.ts`,
`capsuleSlide.ts`, `offsets.ts`, `chainPlace.ts`, `stops.ts`, `constants.ts`)
found **zero** paths where any of those five sliders flow into a marker position,
capsule size, or lane offset. Toggling them cannot desync a cached placement. The
geometry *is* sensitive to `LINE_WIDTH`/`MARKER_SCALE`/`width`/`height` — but those
are build/process-fixed and belong to the layout fingerprint domain.

## Fix — split the draw; hoist the geometry into `pre` (recommended)

Split `renderRibbons` into:
- **`computeRibbonGeometry(layout, …) → GeometryResult`** — the expensive,
  toggle-independent part (lane polylines + the `rowPlace` placement + slide).
  Output is `stopsByNode` (placed marker positions / chains / `cornerAfter` /
  `mega` flags) + the per-line lane polylines (`segPath` / `dByLine`). All plain
  Maps + arrays of numbers — **the existing persist replacer/reviver round-trips
  it with no change** (no functions to special-case, unlike `unproject`).
- **`paintRibbons(geometry, {showLabels, showStations, dark}) → {svg, scene}`** —
  the cheap tail: string/scene assembly + `renderStops` + `placeLabels`
  (~tens of ms; the toggle-dependent work was already cheap).

Move `computeRibbonGeometry` into `precomputeSmoothed` so its result lands in a new
**`pre.geometry`** field and is cached/serialized alongside the rest of `pre`. A
cache hit then deserializes `pre` (incl. geometry) and runs only the cheap tail:
**1.5–70 s → tens of ms.**

### Why this beats "cache the scene + svg keyed by fp+toggles"
1. **Toggles become free** — `showLabels`/`showStations` re-run only the cheap
   tail; no need to key the cache on them, no re-placement.
2. **svg and scene stay coherent** — both regenerate from one cached geometry, so
   the three SVG-*string* consumers that never touch the Scene IR keep working:
   `buildExportSvg` (regex/DOM surgery), the SVG-mode inject, the cutout effect —
   plus `DetailInset`'s `subSvg`/`baseSvg`.
3. **Smaller storage** — geometry is the numeric heart without the duplicated SVG
   markup that a cached svg would carry.
4. **Fresh Generate** also benefits — placement lands in `pre`, cached for reload.

### Invariants the split must preserve (from the consumer audit)
- The svg string and Scene IR must stay two views of the *same* draw
  (`emittedSceneRef` pairs them by `emitted.svg === svg`); cache/regenerate both
  together or keep that identity.
- The cheap tail must still emit the exact svg markup contract: classes
  `.edges/.stops/.stations/.imp-stop/.imp-lbl-s/.imp-lbl`, the `data-frame` attr,
  and `viewBox` (export + SVG-fallback + cutout parse these from the string).
- `labelScale` must stay a **live** multiplier (applied at canvas/export time, not
  baked into geometry) — it already is.
- Keep `pre.stationPx` + `pre.unproject` on `pre` and serializable — the magnifier
  (`DetailInset`) and the Save/Load file feature need them (the draw never does).

### Storage
`GeometryResult` is roughly one extra `pre`-sized blob (the numeric heart of the
svg). `pre + geometry` is fine for Chi/NYC/Sea but may approach/exceed the ~5 MB
localStorage cap for **London**. Either drop now-redundant `pre` fields (the draw
recomputes nothing once geometry is stored) or move the heavy blobs to the game's
async `api.storage` (no cap; read off the main thread). Bump a schema-version byte
so old caches without `geometry` don't deserialize stale. Verify the fingerprint
covers `LINE_WIDTH`/`MARKER_SCALE`/`width`/`height` (the documented unverified-
fingerprint trap).

### Refactor risk
`renderRibbons` is ~1900 lines and regression-prone (see memory). The compute/paint
split must be **byte-identical** to today's output. Gate it with a golden-master
test: hash `{svg, scene}` for all 5 cities before the refactor, assert identical
after (verify the *drawn output*, per the regression-test-invariants memory — not a
proxy). This is the real cost/risk of the change; the concept is sound.

## Secondary — placement is too slow even for a fresh Generate

Hoisting caches the result, but a **fresh** SF/London Generate still pays the
~50–70 s `rowPlace` solve (now at precompute time instead of draw time). The solver
is super-linear (placement grows ×6.4 over ×2.1 stations, Chi→Sea). Optimizing
`rowPlace` itself (spatial index / bound the per-row collision search / skip work
in dense megaboxes) would speed fresh Generates AND any cache miss. Bigger, and
bug-prone — separate effort.

## Suggested order
1. ✅ Golden-master safety net over `{svg, scene}` for all 5 cities
   (`dev/_golden-draw.ts` + `dev/_golden/baseline.txt`).
2. ✅ Split `renderRibbons` → `computeRibbonGeometry` + `paintRibbons`, byte-identical
   (commit fc70543).
3. ✅ Memoize geometry on `pre.geometry` (lazy, in `drawSmoothed`); serialized by the
   existing replacer/reviver; `mapCache` VERSION 2→3 (commit 9e46120). Cache reads
   and toggles skip the solver — **measured 14–148× (London 61s→415ms)**; storage
   London 4.0MB, under cap. Guarded by `src/render/geometryCache.test.ts`.
4. Storage: only needed if a future city exceeds ~5MB — drop redundant `pre` fields
   or move to `api.storage`. Not required today (London fits).
5. (Deeper, OPEN) profile + bound `rowPlace`'s super-linear cost → faster *fresh*
   Generates (caching only fixes reloads/toggles; first generate still pays it once).
