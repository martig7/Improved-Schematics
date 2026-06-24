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
  const dbg = (m: string) => { if (typeof window !== 'undefined') console.log(`[areas] WRITE ${city} ${m}`); };
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
          if (prev.stamp && prev.stamp !== stamp(fp)) { dbg(`n=0 SKIP-preserve (stored ${prev.stamp} != ${stamp(fp)})`); return; }
        } catch {
          /* corrupt entry — fall through and overwrite */
        }
      }
    }
    store.setItem(selKey(city), JSON.stringify({ stamp: stamp(fp), selections }));
    dbg(`n=${selections.length} under ${stamp(fp)}`);
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
  const dbg = (m: string) => { if (typeof window !== 'undefined') console.log(`[areas] READ ${city} ${m}`); };
  try {
    const raw = store.getItem(selKey(city));
    if (!raw) { dbg(`want ${stamp(fp)} -> ABSENT`); return null; }
    const o = JSON.parse(raw) as { stamp?: string; selections?: unknown };
    if (o.stamp !== stamp(fp)) { dbg(`want ${stamp(fp)} have ${o.stamp} -> MISMATCH`); return null; } // areas belong to a different layout
    const r = Array.isArray(o.selections) ? o.selections : null;
    dbg(`want ${stamp(fp)} -> HIT n=${r ? r.length : 'null'}`);
    return r;
  } catch {
    return null;
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

/** Drop one city's cache (or all of it when `city` is omitted). */
export function clearCachedPre(city?: string, store: KVStore | null = defaultStore()): void {
  if (!store) return;
  try {
    if (city) {
      store.removeItem(fpKey(city));
      store.removeItem(preKey(city));
      store.removeItem(selKey(city));
      store.removeItem(setKey(city));
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
