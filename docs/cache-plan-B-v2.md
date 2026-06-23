# Plan B v2 — settings + detail-area auto-restore

v1 (`47430d7`) caches the octi `pre` per city, keyed by the input fingerprint, and
reuses it on Generate. v2 adds a tiny `:meta:` companion so a reload can restore
the user's **appearance settings** and **detail areas** — WITHOUT re-introducing
the stale-render bugs that killed the old cache.

> **STATUS:** detail-area auto-restore is BUILT (commit 641a022) — but as a focused
> `:sel:<city>` entry (`{stamp, selections}`) rather than the combined `:meta:` blob
> below. Areas persist on a `[selections]` effect and restore on a fingerprint hit via
> `readSelections(city, fp)` → `restoreSelectionsRef` (the file-load path). The
> **settings** half (restoring `applied`/toggles so a *customized-appearance* user's fp
> matches and hits) is still NOT built — default-appearance users already hit in v1, so
> areas restore for them today. The `:meta:` design below is the original combined plan;
> the shipped `:sel:` is its area-only subset.

## Why v2 (the two v1 gaps)

1. **Customized-appearance users miss the cache.** The fingerprint includes the
   layout-affecting `applied` options (`mapMargin`, `warpPos`, `linePos`,
   `boxWarpPos`, `lineWidth`) + `dark`. On a fresh mount v1 starts these at
   defaults, so a user who changed, say, warp, generated (cache written under the
   *custom* fp), then reloaded, now computes the *default* fp → MISS → re-octi.
   To hit, the restored `applied` must match what the cached `pre` was built with.
   **The only way to make a customized layout hit is to restore the settings that
   produced it.** (Default-appearance users — the majority — already hit in v1.)

2. **Detail areas are lost on reload.** Drawn boxes (`selections`) live only in
   React state; a reload drops them. The old cache restored them, but
   unconditionally — against a possibly-different layout — which misplaced them.

## What to store

Add one tiny synchronous entry per city (mirrors `mapCache.ts`'s `:fp:`/`:pre:`):

`improvedschematics:mapcache:meta:<city>` = JSON `{ version, fp, settings, selections }`
- `fp` — the fingerprint of the `pre` this meta belongs to (so we can tell whether
  the saved areas match the layout we're about to show — see the gate below).
- `settings` — `{ showStations, showLabels, applied, rasterScale, jpegQuality,
  exportFormat, labelScale }` (the same blob the old `:meta:` carried; a few KB).
- `selections` — the detail areas (`{id, box, color, name, locked}[]`), plain data.

Read synchronously at mount (it's tiny — unlike `:pre:`). Keep `:pre:` heavy and
read only on a Generate hit, as in v1.

## Restore flow

1. **Mount (sync):** read `:meta:<city>`. If present, seed the settings useState
   initializers from `meta.settings` (re-add a LEAN `restored`-style read — just
   the meta, no pre/svg/smoothedStore). Hold `{fp, selections}` in a
   `pendingRestoreRef` for the area step. Mode still starts `geographic`; nothing
   auto-renders. The restored `applied` now feeds `buildInput()`.
2. **Generate:** the svg memo computes `fp = fingerprintInputs(buildInput()).fp`
   using the restored `applied`, then `readCachedPre(city, fp)`:
   - **HIT** → reuse `pre` (instant). Because `applied` was restored, a customized
     layout now matches → hits. AND, since `pendingRestoreRef.fp === fp` (same
     layout), queue its `selections` via the existing `restoreSelectionsRef`; bump
     `selCountRef` past their ids (reuse the old applyBundle logic). The inject
     effect's layout-change branch installs them against the freshly-shown layout.
   - **MISS** → octi as today, and **do NOT restore areas** (different inputs ⇒
     different octi geometry ⇒ saved boxes would be misplaced). Drop
     `pendingRestoreRef`. Settings stay as restored (benign).

## The load-bearing correctness rule

- **Settings restore is unconditional** — they're benign UI prefs; even if the
  network changed, the user's chosen appearance is still valid, and the `pre` is
  still gated by the fingerprint.
- **Area restore is gated on a fingerprint HIT** — areas are only reinstated when
  the layout is provably identical to the one they were drawn on. This is the one
  rule that makes v2 safe where the old cache was buggy (it restored areas against
  whatever layout happened to load).

## Write cadence

Reuse v1's deferred-write seam (`cacheWriteRef` + the post-render effect):
- **Fresh octi generate** (miss): write `:pre:` + `:fp:` (v1) AND `:meta:` with
  the new fp + current settings + selections.
- **Cache-hit generate:** `:pre:`/`:fp:` already current; (re)write `:meta:` so a
  later edit is captured. Remember the active fp in a `currentFpRef`.
- **Draw-setting change** (labels/stations/labelScale/stationRadius/export prefs)
  or **area edit** — these don't change `pre`, so rewrite `:meta:` only (settings/
  selections), keeping `currentFpRef`'s fp. A meta-write effect keyed on
  `[settings…, selections]` while a cached `pre` exists for the city.
- **Layout-setting change** (warp/line/box/margin/lineWidth) already routes
  through Save→`regenerate`, producing a new `pre`/fp/meta — no special handling.

Note: only `applied` LAYOUT options are in the fp; the draw-time settings ride in
`meta.settings` and are reapplied at draw time (a restored map honours its stored
toggles without invalidating the `pre`) — same partition as the fingerprint.

## Edge cases

- **meta present, pre evicted** (quota dropped `:pre:` but kept `:meta:`): Generate
  → `readCachedPre` null → MISS → octi, no area restore (no hit). Settings still
  restored. Safe. Keep meta/pre eviction together in `writeCachedPre`'s quota path
  for tidiness (evict a city's `:meta:` alongside its `:fp:`/`:pre:`).
- **Geography not yet loaded at Generate:** fp has the `nogeo` token → mismatch vs
  the cached (geo-present) fp → MISS → octi, no area restore. Self-heals once the
  harvest (now retried, `f06135f`) completes and the user regenerates. Optionally
  gate the Generate button on "geography resolved" to remove this window entirely.
- **Areas drawn on a hit, then the user edits the network:** next Generate's fp
  differs → MISS → areas dropped (correct).

## Why this is safe (vs the torn-out cache)

The old cache replayed a stored SVG/layout on mount and restored areas blindly →
gray backdrops and misplaced boxes. v2 never auto-shows a map (Generate stays
explicit), the `pre` is fingerprint-gated (v1), settings are benign, and areas are
gated on a fingerprint hit. No second in-memory store, no `:svg:` cache, no
mount-time heavy parse (meta is tiny; `pre` loads only on a confirmed hit).

## Effort, testing, open questions

- **Effort:** small–medium. New: `readMeta`/`writeMeta` in `mapCache.ts`; a lean
  meta-seed at mount (re-add `rset`/`rapp` from `meta.settings`, ~the block torn
  out, minus the pre/svg/restore plumbing); wire `restoreSelectionsRef` on a hit;
  one meta-write effect. Reuses `restoreSelectionsRef` + the inject restore branch
  + `selCountRef` bump that already exist for the FILE load.
- **Tests:** extend `mapCache.test.ts` (meta round-trip; meta fp tied to pre fp;
  area-restore gate = restore iff `meta.fp === currentFp`). The mount-seed + inject
  install are React integration — cover by build + in-game (Generate, draw an area,
  change label size, reload, Generate → same layout + areas + label size restored,
  instant).
- **Open questions for you:**
  1. Restore *all* draw settings (label size, toggles, export prefs) or just the
     layout-affecting ones needed for the hit? (Restoring all is friendlier and
     costs nothing extra since it's the same meta blob.)
  2. Should a customized-appearance reload restore the sliders to the saved values
     silently, or surface "restored your settings"? (Silent matches the old UX.)
  3. Keep area `locked` state across reload? (It's in the selection data already.)
