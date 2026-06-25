# Plan B — fingerprinted precompute cache

> **STATUS: implemented (lean v1, commit 47430d7).** `src/render/mapCache.ts` +
> `cacheFingerprint.ts` + `persist.ts` (serializePre/deserializePre re-added) +
> the panel's svg memo (read cache → hit reuses pre, miss runs octi + deferred
> write; Regenerate forces fresh). v1 caches the LAYOUT only — NO settings/area
> auto-restore — so it hits on the common default-appearance path and respects
> "always open geographic / explicit Generate" (Generate is just instant on a
> hit). Deferred to a possible v2: restoring appearance settings + detail areas
> from the cache (would let customized-appearance users hit too, and survive
> areas across reload). The notes below are the original design rationale.


The automatic cache was torn out (commit `tear out the automatic map cache`). The
smoothed layout now lives only in the per-mount `smoothedCacheRef`; nothing is
persisted automatically, so opening the panel / reloading the game requires a
fresh **Generate** (octi: Chi ~3.7s · NYC ~14s · Sea ~17s · SF ~139s · London
~158s). The explicit **Save/Load map file** is the only persistence.

> **Save file = a portable cache snapshot.** The Save map JSON (`persist.ts`
> `MapBundle`) now mirrors EVERYTHING the per-city localStorage cache holds for the
> shown layout: the precompute (`pre`), the layout fingerprint (`fp`), the detail
> areas (`selections`), the per-mode visual settings (`modeSettings`), and the
> per-area sub-layout cache (`subs`). On load the panel reseeds the localStorage
> cache from those fields and adopts the saved `city`/`fp`, so a file-load behaves
> exactly like a cache hit — detail areas restore from their saved sub-layouts
> without re-simulating, and a later remount + Generate hits. The file also carries
> a debug `inputDump` (the former standalone "input dump": the exact live render
> inputs, plus a cropped sub-input per detail area so any area can be debugged in
> isolation offline). `inputDump` is for repro only and is **ignored on load**.

Build Plan B **only if** re-paying octi on reload becomes painful enough (London
158s) to justify it — and **only after** the id-stability prerequisite below
passes. It re-adds reload-survival while staying correct, by caching exactly one
artifact (the octi `pre`) under an input fingerprint.

## 0. Prerequisite — confirm id stability across a reload (do this FIRST) ✅ PASSED (2026-06-23)

Tested in-game: two separate game loads, same network, produced an **identical**
fingerprint (`v1-756a0096`; all six sub-parts matched, incl. `geo`). So
ids/coords ARE stable across a reload → a fingerprinted localStorage cache will
hit. Green light to build Plan B. (`fingerprintInputs` lives in
`src/render/cacheFingerprint.ts`; the temporary `[fp]` Generate log has been
removed.) Original procedure, for reference:


The whole design hinges on the game emitting **identical** route/station/track ids
(and coords) for an unchanged network across a save→reload. If ids regenerate on
load, the fingerprint never matches and the cache is dead weight. This is **not
verifiable from the repo** — test it in-game:

1. Temporarily add, in the Generate handler (or panel open), a
   `console.log('[fp]', fingerprint(buildInput()))` using the helper from §2.
2. Generate a smoothed map; note the `[fp]` value.
3. Save the game, fully reload it, reopen the panel, Generate again **without
   changing the network**; note the `[fp]`.
4. **Pass** = identical fp. **Fail** = different fp → do NOT build Plan B as a
   localStorage cache; ids aren't stable. (Fallback would be a content-only
   fingerprint over coords, which is costlier and weaker — reconsider whether
   the cache is worth it at all.)

Also confirm the network getters (`getRoutes/getTracks/getStations`) return
populated data at mount; if they lag, the mount-time fp would mismatch (a safe
MISS, but a lost hit).

## 1. What to cache (and what to drop)

- **Cache:** the octi `pre` (`SmoothedPrecomputed`) — ONE localStorage entry per
  city: `improvedschematics:map:<city>` = `{ header: {version, fp, settings,
  selections}, pre }`. Header is a few KB (parsed synchronously at open); the
  `pre` body is multi-MB (deserialized lazily, off the first render).
- **Keep `unproject` in the cached `pre`.** `DetailInset` calls
  `getMainPre().unproject(...)` / `.stationPx` directly on the restored object
  (DetailInset.tsx box→geo + hit-test). There is no live re-derivation — dropping
  it breaks the magnifier. (It's the 256-sample table from persist.ts; small.)
- **Drop `:svg:`** entirely — Phase 3 emits the Scene IR on draw (`emittedSceneRef`
  → `sceneCanvas`), so the rendered-image cache + the instant-replay are redundant.
- **Do NOT cache the Scene instead of `pre`.** `buildExportSvg` and the magnifier
  `cropFallback` both consume the `svg` STRING; a scene-only cache breaks Export
  (returns null) and blanks the crop-fallback unless both are ported off the
  string first. Caching `pre` (and letting the svg memo still produce the string
  for export) avoids that.
- **Keep the Save/Load FILE feature** (`serializeMap`/`deserializeMap`,
  `exportMap`/`importMap`/`applyBundle`) unchanged — independent, not buggy.

## 2. The fingerprint spec (must mirror EXACTLY what graph.ts/precomputeSmoothed consume)

Under-coverage = silent stale restore (the dangerous failure). The layout is
built in `src/render/layout/graph.ts` from these fields — the fingerprint MUST
include all of them, and `precomputeSmoothed`'s layout options:

**Stations** (constructed only — `buildType === 'constructed'`, graph.ts:23,150,167):
- `id`, `coords` (rounded), `trackGroupId` (fallback grouping), `buildType`,
  `stNodeIds`, `trackIds`, and `name` (becomes the drawn node label, baked into `pre`).

**Routes** (skip when `tempParentId` set, graph.ts:177,439,483):
- `id`, `bullet` (drawn label, baked), `color` (normalizeColor → baked),
  presence of `tempParentId`,
- each `stCombos[]`: `startStNodeId`, `endStNodeId`, `distance` (drives the
  positioning-leg suppression at graph.ts:313-363 — changes which edges exist!),
  and `path[]` of `{trackId, reversed}`,
- `stNodes[].id` (fallback when no stCombos).

**Tracks** (graph.ts:478-500, corridor geometry → `edge.geo` → octi):
- `id` + a coarse `coords` digest (e.g. first/last point + point count + a hash of
  rounded coords). Full per-point hashing is the costliest part — keep it coarse.

**Station groups** (`resolveStationGroupsFromGameState`, graph.ts:77-132):
- each group `id` + `stationIds` (the merge that defines nodes). Include `center`
  only if the API provides it (else it's derived from station coords already hashed).

**Layout options** (from `buildInput().options` — these bake into `pre`):
- `padding`/mapMargin, `warpAlpha`, `geographicAffinity`, `boxExpand`,
  `boxGrowth`, `dark` (affects the baked `gridOverlay` colors), and
  `theme.lineWidth` (feeds `dHat = max(16, lineWidth*4)` → octi grid).
- **NOT in the fp** (draw-time only, applied fresh on restore): `showLabels`,
  `showStations`, `labelScale`, `theme.stationRadius`. Putting these in would
  force needless octi re-runs.

**Geography token** — presence + a STABLE coarse content tag, NOT `geography.bbox`
(it's a derived value seeded from drifting demand points, geography.ts — would
cause chronic false misses). Use e.g. `geography ? 'geo:'+water.length+':'+green.length
: 'nogeo'`. This is the bug-1 fix: a `pre` baked before the async harvest has the
`nogeo` tag and fails the match once geography arrives.

Implementation: one pure `fingerprintInputs(buildInput())` → short string/hash.
Hash SORTED ids and ROUNDED coords for stability. Add a **dev assertion** that
hashing the same input twice yields the same fp, and a **schema version byte** so a
renderer change busts all caches. When `buildInput()` grows a new layout input,
the fp MUST be updated too (the standing maintenance hazard).

## 3. Structural change — the HIT check runs AFTER geography resolves

Geography is harvested **async** and is `undefined` inside the synchronous
`restored` mount initializer, so you cannot compute a geography-inclusive
fingerprint at mount. Therefore:

- At mount: synchronously read only the tiny **header** (`fp`, `settings`,
  `selections`); seed UI settings + queued areas; do NOT deserialize `pre` yet.
- After geography resolves (the existing geography effect): compute the current
  fingerprint and compare to the header `fp`. **Match** → run the existing
  deferred (rAF×2) path to deserialize `pre` into `smoothedCacheRef` + draw.
  **Mismatch** (incl. the backdrop-less case) → leave smoothed on the Generate
  button. This is a real re-architecture of the restore trigger, not a body swap.
- Also gate the Generate button on a "geography resolved" token (distinct from
  `geoLoading=false`, which can resolve with `geography===undefined` on tile
  failure) so a user can't manually bake a backdrop-less map within the session.

## 4. Open/load timeline (target)

| event | action |
|---|---|
| Panel open | read header (sync) → seed settings; stay geographic; kick async geo harvest |
| Geography resolves | compute fp; match → deferred deserialize `pre` + draw (no octi); mismatch → Generate button |
| Generate/Regenerate | octi → `smoothedCacheRef`; persist `{header(fp,settings,sels), pre}` once |
| Label/station toggle | cheap redraw; rewrite header only (`pre` unchanged) |
| Reload | header survives; fp re-checked after geo resolves; fingerprint-guarded |

## 5. Effort + residual risks

Medium-plus (not surgical): the fp helper is easy; the real work is enumerating
the full input surface above and keeping it in sync with `buildInput()`, the
geography-gated restore re-architecture, and unwinding the last refs. Residuals:
quota — London `pre` alone (>3MB) approaches the ~5MB localStorage cap, so
multi-city still needs the per-city eviction hack or a move to the game's async
`api.storage` (api.d.ts ~476) / IndexedDB (only if London/SF multi-city
reload-survival is required). Under-coverage of the fp = silent stale restore;
keep the dev double-hash assertion and a schema version byte.
