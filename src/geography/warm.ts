// Background geography warm-up — decoupled from the panel.
//
// The harvest's inputs (the game map, the city code, and the demand/stations used for
// the bbox) aren't all ready the instant the game loads. The panel used to drive the
// retry itself, but that retry died the moment the panel closed — so a too-early first
// open left no backdrop and only a reopen (with the inputs now ready) recovered. Here we
// run the retry at the module level, kicked off from city load, so the per-city cache is
// warm by the time the panel opens AND the work survives the panel being closed/reopened.

import { generateGeography, peekGeography } from './geography';
import { computeHarvestBbox } from './harvestBbox';

const TAG = '[ImprovedSchematics] geography:';
const warming = new Set<string>(); // cities with an in-flight warm-up loop (dedupe)

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
      const r = computeHarvestBbox();
      if (!r) { schedule(); return; } // demand/stations not ready yet
      // Persist only demand-based harvests (the stable full extent); a station-fallback is
      // session-only so a later reload can re-harvest properly once demand is ready.
      generateGeography(cityCode, r.bbox, undefined, r.fromDemand).then(
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
