// Plan B: a fingerprint-gated layout cache. One entry per city in localStorage:
//   :fp:<city>  = "v<VERSION>:<fingerprint>"   (tiny — the cache key/guard)
//   :pre:<city> = serializePre(pre)            (heavy — the octi precompute)
//
// Read at Generate: if the stored fp equals the fingerprint of the LIVE inputs,
// deserialize and reuse the precompute (skips the 3.7s-158s octi run); otherwise
// it's a miss and the caller runs octi + writes a fresh entry. Because the key IS
// the input fingerprint (see cacheFingerprint.ts), a stale layout (geography
// arrived late, network/settings changed) can never be restored — the fp simply
// won't match. There is no auto-restore and no second in-memory store, so the
// stale-render bugs that killed the old cache can't recur.

import type { SmoothedPrecomputed } from './schematic';
import { serializePre, deserializePre } from './persist';

const KEY = 'improvedschematics:mapcache';
const VERSION = 3; // bump to invalidate every cached entry on a format change
// v3: pre now carries `geometry` (memoized marker placement) so a cache read skips
// the 80-90% draw cost — bumped so pre-geometry entries refresh on next Generate.

/** Minimal synchronous key/value store (localStorage shape). Injectable for tests. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function defaultStore(): KVStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const fpKey = (city: string) => `${KEY}:fp:${city}`;
const preKey = (city: string) => `${KEY}:pre:${city}`;
const selKey = (city: string) => `${KEY}:sel:${city}`;
const setKey = (city: string) => `${KEY}:set:${city}`;
const subKey = (city: string) => `${KEY}:sub:${city}`;
const stamp = (fp: string) => `v${VERSION}:${fp}`;

/** Cheap hit test: is there a cached entry for `city` whose fingerprint matches
 *  `fp`? Reads only the tiny `:fp:` key — no deserialize. For UI that wants to
 *  show "cache hit" before paying the full read. */
export function peekCache(city: string, fp: string, store: KVStore | null = defaultStore()): boolean {
  if (!store || !city) return false;
  try {
    return store.getItem(fpKey(city)) === stamp(fp);
  } catch {
    return false;
  }
}

/** Deserialized precompute for `city` IFF a cached entry's fingerprint matches
 *  `fp` (the digest of the current live inputs). Null on miss / absent / error. */
export function readCachedPre(
  city: string,
  fp: string,
  store: KVStore | null = defaultStore(),
): SmoothedPrecomputed | string | null {
  if (!store || !city) return null;
  try {
    if (store.getItem(fpKey(city)) !== stamp(fp)) return null; // miss → caller runs octi
    const preStr = store.getItem(preKey(city));
    if (!preStr) return null;
    return deserializePre(preStr);
  } catch {
    return null;
  }
}

/** Persist a freshly-computed precompute under the current input fingerprint.
 *  Best-effort: on quota it drops OTHER cities' entries and retries once; if it
 *  still can't fit it gives up (the next open is just a cache miss, never wrong). */
export function writeCachedPre(
  city: string,
  fp: string,
  pre: SmoothedPrecomputed | string,
  store: KVStore | null = defaultStore(),
): boolean {
  if (!store || !city) return false;
  const preStr = serializePre(pre);
  const write = (): boolean => {
    store.setItem(preKey(city), preStr);
    store.setItem(fpKey(city), stamp(fp));
    return true;
  };
  try {
    return write();
  } catch {
    // Quota: evict every OTHER city's cache, then retry once.
    try {
      const keepFp = fpKey(city);
      const keepPre = preKey(city);
      const keepSel = selKey(city);
      const keepSet = setKey(city);
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (k && k.startsWith(KEY) && k !== keepFp && k !== keepPre && k !== keepSel && k !== keepSet) store.removeItem(k);
      }
      return write();
    } catch {
      // give up — drop a half-written entry so a partial pre can't be read back
      try {
        store.removeItem(fpKey(city));
        store.removeItem(preKey(city));
      } catch {
        /* ignore */
      }
      return false;
    }
  }
}

/** Persist the detail-area selections the user drew on the layout fingerprinted by
 *  `fp`. Tiny + synchronous (unlike `:pre:`) — best-effort; a write failure just means
 *  the areas won't auto-restore next time. Stamped with VERSION+fp so they can only be
 *  restored against the exact layout they were drawn on (see readSelections). */
export function writeSelections(
  city: string,
  fp: string,
  selections: unknown[],
  store: KVStore | null = defaultStore(),
): void {
  if (!store || !city) return;
  try {
    // An EMPTY write must not clobber another LAYOUT's saved areas. There is one `:sel:`
    // entry per city, so a write replaces whatever fp was stored. A generate under a
    // *transient* fingerprint (classically before geography finishes loading → a `nogeo`
    // fp) clears the live selections, and that empty write would otherwise overwrite the
    // real `{geo-fp, [areas]}` — so the areas vanish even though the layout cache later
    // hits. If the stored entry belongs to a DIFFERENT fp, preserve it. (A non-empty write
    // always wins: the user is actively drawing on THIS layout.)
    if (selections.length === 0) {
      const raw = store.getItem(selKey(city));
      if (raw) {
        try {
          const prev = JSON.parse(raw) as { stamp?: string };
          if (prev.stamp && prev.stamp !== stamp(fp)) return; // preserve another layout's areas
        } catch {
          /* corrupt entry — fall through and overwrite */
        }
      }
    }
    store.setItem(selKey(city), JSON.stringify({ stamp: stamp(fp), selections }));
  } catch {
    /* ignore — areas are non-critical UI state */
  }
}

/** The detail-area selections saved for `city` IFF they were drawn on the SAME layout
 *  (the stored fingerprint matches `fp`). Returns null on miss / absent / format change /
 *  error. Gating on the fingerprint is what makes restore safe: the boxes are in render-
 *  pixel coords, so they're only valid against the byte-identical layout they were drawn
 *  on — a different network/geography/settings produces a different fp and no restore. */
export function readSelections(
  city: string,
  fp: string,
  store: KVStore | null = defaultStore(),
): unknown[] | null {
  if (!store || !city) return null;
  try {
    const raw = store.getItem(selKey(city));
    if (!raw) return null;
    const o = JSON.parse(raw) as { stamp?: string; selections?: unknown };
    if (o.stamp !== stamp(fp)) return null; // areas belong to a different layout
    return Array.isArray(o.selections) ? o.selections : null;
  } catch {
    return null;
  }
}

/** A cached sub-layout's frame (the panel's viewBox into its sub-map), or null. */
type SubFrame = { x: number; y: number; w: number; h: number } | null;
export interface SubEntry { pre: string; selFrame: SubFrame }

/** The cached sub-layout (a detail area's octi precompute of its cropped region) for
 *  `boxKey` on the layout fingerprinted by `fp`, or null on miss. Lets a DetailInset skip
 *  the heavy re-simulation on remount/reload — restoring the area instantly, like the main
 *  map cache. fp-gated (the sub-layout is derived from the main inputs, so a changed layout
 *  invalidates it) and box-keyed (each region is its own entry; editing the bounds is a new
 *  key). Safe by the same argument as the main pre cache: same (fp, box) ⇒ deterministic
 *  sub-layout, so a hit equals a recompute. */
export function readSubPre(
  city: string,
  fp: string,
  boxKey: string,
  store: KVStore | null = defaultStore(),
): { pre: SmoothedPrecomputed | string; selFrame: SubFrame } | null {
  if (!store || !city) return null;
  try {
    const raw = store.getItem(subKey(city));
    if (!raw) return null;
    const o = JSON.parse(raw) as { stamp?: string; subs?: Record<string, SubEntry> };
    if (o.stamp !== stamp(fp)) return null; // belongs to a different layout
    const e = o.subs?.[boxKey];
    if (!e) return null;
    return { pre: deserializePre(e.pre), selFrame: e.selFrame ?? null };
  } catch {
    return null;
  }
}

/** Persist a freshly-computed sub-layout under (fp, boxKey). One `:sub:` entry per city
 *  holds a boxKey→sub-layout map stamped with the layout fp; a write under a NEW fp starts a
 *  fresh map (the old regions are stale). Best-effort: on quota it drops the whole sub-cache
 *  for the city and gives up (the area just re-simulates next time — never wrong, only slower). */
export function writeSubPre(
  city: string,
  fp: string,
  boxKey: string,
  pre: SmoothedPrecomputed | string,
  selFrame: SubFrame,
  store: KVStore | null = defaultStore(),
): void {
  if (!store || !city) return;
  try {
    const preStr = serializePre(pre);
    const o: { stamp: string; subs: Record<string, SubEntry> } = { stamp: stamp(fp), subs: {} };
    const raw = store.getItem(subKey(city));
    if (raw) {
      try {
        const prev = JSON.parse(raw) as { stamp?: string; subs?: Record<string, SubEntry> };
        if (prev.stamp === stamp(fp) && prev.subs) o.subs = prev.subs; // same layout → merge in
      } catch {
        /* corrupt entry — start fresh */
      }
    }
    o.subs[boxKey] = { pre: preStr, selFrame };
    store.setItem(subKey(city), JSON.stringify(o));
  } catch {
    // Quota or error: drop the (purely-perf) sub-cache for this city and give up.
    try { store.removeItem(subKey(city)); } catch { /* ignore */ }
  }
}

/** Every cached sub-layout for (`city`, `fp`) as a raw boxKey→entry map (the serialized
 *  sub strings, untouched), or null on miss / format change. Lets the panel bake the whole
 *  sub-layout cache into a saved map file so a load restores each area instantly — exactly
 *  like a localStorage cache hit. */
export function readAllSubPres(
  city: string,
  fp: string,
  store: KVStore | null = defaultStore(),
): Record<string, SubEntry> | null {
  if (!store || !city) return null;
  try {
    const raw = store.getItem(subKey(city));
    if (!raw) return null;
    const o = JSON.parse(raw) as { stamp?: string; subs?: Record<string, SubEntry> };
    if (o.stamp !== stamp(fp) || !o.subs) return null;
    return o.subs;
  } catch {
    return null;
  }
}

/** Replace the whole sub-layout cache for (`city`, `fp`) with `subs` in one write. Used to
 *  seed the sub-cache from a loaded map file, so its detail areas restore from cache instead
 *  of re-simulating. Best-effort: on quota it drops the (purely-perf) sub-cache and gives up. */
export function writeAllSubPres(
  city: string,
  fp: string,
  subs: Record<string, SubEntry>,
  store: KVStore | null = defaultStore(),
): void {
  if (!store || !city) return;
  try {
    store.setItem(subKey(city), JSON.stringify({ stamp: stamp(fp), subs }));
  } catch {
    try { store.removeItem(subKey(city)); } catch { /* ignore */ }
  }
}

/** Drop cached sub-layouts for `city`/`fp` whose box isn't in `keepBoxKeys` — keeps the
 *  sub-cache aligned with the live areas, so a deleted or bounds-edited area's old region
 *  doesn't linger and waste quota. No-op when the stored stamp is for a different fp. */
export function pruneSubPres(
  city: string,
  fp: string,
  keepBoxKeys: string[],
  store: KVStore | null = defaultStore(),
): void {
  if (!store || !city) return;
  try {
    const raw = store.getItem(subKey(city));
    if (!raw) return;
    const o = JSON.parse(raw) as { stamp?: string; subs?: Record<string, SubEntry> };
    if (o.stamp !== stamp(fp) || !o.subs) return;
    const keep = new Set(keepBoxKeys);
    let changed = false;
    for (const k of Object.keys(o.subs)) {
      if (!keep.has(k)) { delete o.subs[k]; changed = true; }
    }
    if (changed) store.setItem(subKey(city), JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

/** Persist the user's appearance settings (the applied layout sliders + draw prefs)
 *  for `city`. UNVERSIONED on purpose: a renderer/pre format bump (VERSION) shouldn't
 *  wipe benign UI prefs, and the panel reads each field defensively (`?? default`), so a
 *  shape change degrades gracefully rather than discarding the user's customizations. */
export function writeSettings(city: string, settings: unknown, store: KVStore | null = defaultStore()): void {
  if (!store || !city) return;
  try {
    store.setItem(setKey(city), JSON.stringify({ settings }));
  } catch {
    /* ignore — settings are non-critical UI state */
  }
}

/** The saved appearance settings for `city` (or null). Read SYNCHRONOUSLY at mount to
 *  seed the slider/toggle initializers BEFORE first render — so a customized layout's
 *  fingerprint matches its cached `pre` and Generate hits (which in turn lets its detail
 *  areas restore). Unconditional (no fp gate): settings are benign and the `pre` itself
 *  stays fingerprint-gated, so a stale layout can still never be served. */
export function readSettings(city: string, store: KVStore | null = defaultStore()): unknown | null {
  if (!store || !city) return null;
  try {
    const raw = store.getItem(setKey(city));
    if (!raw) return null;
    return (JSON.parse(raw) as { settings?: unknown }).settings ?? null;
  } catch {
    return null;
  }
}

const setModeKey = (city: string, mode: string) => `${setKey(city)}:${mode}`;

/** Persist the per-MODE visual settings (toggles + appearance + label size) for `city`.
 *  Geographic and smoothed keep independent visual settings, so switching modes restores
 *  each mode's own look. Export prefs stay shared in writeSettings (they're about the output
 *  file, not the view). Same benign/unversioned contract as writeSettings. */
export function writeModeSettings(city: string, mode: string, settings: unknown, store: KVStore | null = defaultStore()): void {
  if (!store || !city) return;
  try {
    store.setItem(setModeKey(city, mode), JSON.stringify({ settings }));
  } catch {
    /* ignore — settings are non-critical UI state */
  }
}

/** The saved per-mode visual settings for `city`/`mode` (or null). The panel falls back to
 *  the shared readSettings on a miss, so a pre-split (single-settings) cache migrates into
 *  each mode on first use. */
export function readModeSettings(city: string, mode: string, store: KVStore | null = defaultStore()): unknown | null {
  if (!store || !city) return null;
  try {
    const raw = store.getItem(setModeKey(city, mode));
    if (!raw) return null;
    return (JSON.parse(raw) as { settings?: unknown }).settings ?? null;
  } catch {
    return null;
  }
}

/** Drop one city's cache (or all of it when `city` is omitted). */
export function clearCachedPre(city?: string, store: KVStore | null = defaultStore()): void {
  if (!store) return;
  try {
    if (city) {
      store.removeItem(fpKey(city));
      store.removeItem(preKey(city));
      store.removeItem(selKey(city));
      store.removeItem(setKey(city));
      store.removeItem(subKey(city));
      // Per-mode visual settings live under `:set:<city>:<mode>`; remove them too.
      const setPrefix = `${setKey(city)}:`;
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (k && k.startsWith(setPrefix)) store.removeItem(k);
      }
      return;
    }
    for (let i = store.length - 1; i >= 0; i--) {
      const k = store.key(i);
      if (k && k.startsWith(KEY)) store.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}
