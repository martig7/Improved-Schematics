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
const VERSION = 2; // bump to invalidate every cached entry on a format change

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
const stamp = (fp: string) => `v${VERSION}:${fp}`;

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
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (k && k.startsWith(KEY) && k !== keepFp && k !== keepPre) store.removeItem(k);
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

/** Drop one city's cache (or all of it when `city` is omitted). */
export function clearCachedPre(city?: string, store: KVStore | null = defaultStore()): void {
  if (!store) return;
  try {
    if (city) {
      store.removeItem(fpKey(city));
      store.removeItem(preKey(city));
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
