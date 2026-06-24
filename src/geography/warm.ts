// Background geography warm-up — decoupled from the panel.
//
// The harvest's inputs (the game map, the city code, and the demand/stations used for
// the bbox) aren't all ready the instant the game loads. The panel used to drive the
// retry itself, but that retry died the moment the panel closed — so a too-early first
// open left no backdrop and only a reopen (with the inputs now ready) recovered. Here we
// run the retry at the module level, kicked off from city load, so the per-city cache is
// warm by the time the panel opens AND the work survives the panel being closed/reopened.

import type { BoundingBox } from '../types/core';
import { computeBounds, padBounds } from '../render/projection';
import { generateGeography, peekGeography } from './geography';

const TAG = '[ImprovedSchematics] geography:';
const warming = new Set<string>(); // cities with an in-flight warm-up loop (dedupe)

/** Harvest extent: the demand-point bbox (where people are), else the station-centroid
 *  extent. Mirrors the panel's old computeBbox so both harvest the same region. Null when
 *  neither demand nor stations are ready yet. */
function computeHarvestBbox(): BoundingBox | null {
  const api = window.SubwayBuilderAPI;
  let raw: BoundingBox | null = null;
  const demand = api?.gameState?.getDemandData?.();
  if (demand && demand.points.size > 0) {
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
    console.warn(`${TAG} harvest bbox too large [${raw.map((n) => n.toFixed(2)).join(', ')}] — coords not settled; retrying`);
    return null;
  }
  return raw;
}

/** Kick off (or no-op if already running) a background harvest+cache for `cityCode`,
 *  retrying until the map + city + demand/stations are all ready. Fire-and-forget;
 *  generateGeography caches success, so the panel's peekGeography picks it up. Safe to
 *  call repeatedly (from city load AND panel open) — the `warming` guard dedupes. */
export function warmGeography(cityCode: string | null | undefined): void {
  if (!cityCode || warming.has(cityCode)) return;
  if (peekGeography(cityCode)) return; // already harvested earlier this session
  warming.add(cityCode);
  let attempts = 0;
  const MAX_ATTEMPTS = 180; // generous — covers slow first loads / a late-servable tile backend
  const DELAY = 2000; // gentle cadence: harvesting spins up a throwaway offscreen map each try
  const stop = (): void => { warming.delete(cityCode); };
  const schedule = (): void => { if (attempts++ < MAX_ATTEMPTS) setTimeout(tick, DELAY); else stop(); };
  const tick = (): void => {
    try {
      const bbox = computeHarvestBbox();
      if (!bbox) { schedule(); return; } // demand/stations not ready yet
      generateGeography(cityCode, bbox).then(
        (g) => (g ? stop() : schedule()),
        () => schedule(),
      );
    } catch {
      schedule(); // never let a throw strand the `warming` guard (would block all retries)
    }
  };
  console.info(`${TAG} warming '${cityCode}' in the background`);
  tick();
}
