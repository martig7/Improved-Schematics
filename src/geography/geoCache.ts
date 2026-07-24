// Persistent, geography-specific cache (separate from the smoothed-layout mapCache).
//
// Geography (water/parks) is harvested once per city from the game's vector tiles in a slow,
// flaky, async step. Persisting the harvest to localStorage makes geographic mode show
// instantly on reload instead of re-harvesting, and, because geography feeds the smoothed
// fingerprint, stabilizes the :pre: cache's hit rate. It uses its own KEY namespace so it's
// independent of the layout cache. A layout-cache eviction never drops geography, and
// vice-versa.
//
// Keyed by city only: geography is geographic truth at the (fixed) demand extent, so it's
// deterministic and reused across reloads. Only DEMAND-based harvests are persisted (see
// generateGeography) so a transient early station-fallback can't be frozen in.

import type { GeographyData } from './types';
import type { BoundingBox } from '../types/core';
import type { KVStore } from '../render/mapCache';

const KEY = 'improvedschematics:geocache';
const VERSION = 6; // v6: harvest detail level (offscreen container size) is part of the entry
const key = (city: string) => `${KEY}:${city}`;

/** A persisted harvest + the demand extent it was harvested at, so a later session can tell
 *  whether the extent changed (re-harvest) vs is unchanged (reuse). */
export interface GeoCacheEntry {
  bbox: BoundingBox;
  geography: GeographyData;
  /** Land-detail level the harvest was taken at. A different level is treated as a
   *  miss (like a changed bbox), so raising detail re-harvests instead of serving
   *  the coarser geometry. */
  detail?: string;
}

function defaultStore(): KVStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Persisted geography + its harvest extent for `city`, or null on miss / version mismatch /
 *  error. The caller compares the stored bbox to the current demand extent to decide reuse
 *  vs re-harvest. */
export function readGeoCache(city: string, store: KVStore | null = defaultStore()): GeoCacheEntry | null {
  if (!store || !city) return null;
  try {
    const raw = store.getItem(key(city));
    if (!raw) return null;
    const o = JSON.parse(raw) as { v?: number; bbox?: BoundingBox; geography?: GeographyData; detail?: string };
    if (o.v !== VERSION || !o.geography || !o.bbox) return null;
    return { bbox: o.bbox, geography: o.geography, detail: o.detail };
  } catch {
    return null;
  }
}

/** Persist a harvested geography for `city` together with the extent it was harvested at.
 *  Best-effort: on quota it evicts OTHER cities' geography and retries once; if it still
 *  can't fit it gives up, and the next open just re-harvests. */
export function writeGeoCache(city: string, bbox: BoundingBox, geography: GeographyData, detail: string, store: KVStore | null = defaultStore()): void {
  if (!store || !city) return;
  const payload = JSON.stringify({ v: VERSION, bbox, geography, detail });
  try {
    store.setItem(key(city), payload);
  } catch {
    try {
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (k && k.startsWith(KEY) && k !== key(city)) store.removeItem(k);
      }
      store.setItem(key(city), payload);
    } catch {
      /* give up and re-harvest next time */
    }
  }
}

/** Drop one city's persisted geography (or all of it when `city` is omitted). */
export function clearGeoCache(city?: string, store: KVStore | null = defaultStore()): void {
  if (!store) return;
  try {
    if (city) {
      store.removeItem(key(city));
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
