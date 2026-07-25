// The geography harvest extent, shared by the background warm-up (warm.ts) and the
// extent-validation in geography.ts (so a persisted harvest from a DIFFERENT demand extent
// isn't served stale). Kept in its own module to avoid a warm.ts ⟷ geography.ts cycle.

import type { BoundingBox } from '../types/core';
import { computeBounds, padBounds } from '../render/projection';

/** Harvest extent: the demand-point bbox (where people are), else the station-centroid
 *  extent. `fromDemand` says which. Only demand-based (stable, full-city) harvests are
 *  persisted. Null when neither demand nor stations are ready, or the extent is implausibly
 *  large (uninitialized coords early in a load). */
export function computeHarvestBbox(): { bbox: BoundingBox; fromDemand: boolean } | null {
  const api = typeof window !== 'undefined' ? window.SubwayBuilderAPI : undefined;
  let raw: BoundingBox | null = null;
  let fromDemand = false;
  const demand = api?.gameState?.getDemandData?.();
  if (demand && demand.points.size > 0) {
    fromDemand = true;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const p of demand.points.values()) {
      const [lng, lat] = p.location;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    raw = padBounds([minLng, minLat, maxLng, maxLat], 0.1);
  } else {
    const stations = api?.gameState?.getStations?.() ?? [];
    const b = computeBounds(stations.map((s) => ({ points: [s.coords] })));
    raw = b ? padBounds(b, 0.15) : null;
  }
  if (!raw) return null;
  // Reject an implausibly-large extent: early in a load, demand/station coords can be
  // uninitialized (e.g. a point at [0,0]) which drags the bbox across the globe → fitBounds
  // lands at zoom 0 → the offscreen map only ever requests the world tile (404) and harvests
  // nothing. No real city spans this; treat as "not ready" and retry once the data settles.
  if (raw[2] - raw[0] > 12 || raw[3] - raw[1] > 12) {
    console.warn('[ImprovedSchematics] geography: harvest bbox too large — coords not settled; retrying');
    return null;
  }
  return { bbox: raw, fromDemand };
}

/**
 * Extent of the BUILT network (stations), padded, or null when there are none.
 *
 * Distinct from the harvest extent, which follows demand and is much larger: the
 * demand extent is what the map must SHOW, while this is where the detail is
 * actually needed. Sampling the smaller extent at the same container lands at a
 * higher zoom for the same tile cost, which is how a channel narrower than a
 * pixel at the full extent becomes resolvable. Read from game state, so it is
 * known before any harvest and never depends on harvested geography.
 */
export function computeNetworkBbox(): BoundingBox | null {
  const api = typeof window !== 'undefined' ? window.SubwayBuilderAPI : undefined;
  const stations = api?.gameState?.getStations?.() ?? [];
  if (stations.length === 0) return null;
  const b = computeBounds(stations.map((s) => ({ points: [s.coords] })));
  if (!b) return null;
  const raw = padBounds(b, 0.15);
  // Same not-settled guard as the harvest extent: an uninitialised coord drags
  // the bbox across the globe, which would make the extra pass meaningless.
  if (raw[2] - raw[0] > 12 || raw[3] - raw[1] > 12) return null;
  return raw;
}

/** True when two harvest extents are the same to within ~a meter (floats round-trip through
 *  JSON exactly, but use an epsilon for safety). A changed extent ⇒ re-harvest. */
export function bboxApproxEqual(a: BoundingBox, b: BoundingBox): boolean {
  const EPS = 1e-6;
  for (let i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > EPS) return false;
  return true;
}
