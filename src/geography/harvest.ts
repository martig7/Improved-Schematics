import type { Map as MlMap, StyleSpecification, SourceSpecification } from 'maplibre-gl';
import type { TaggedFeature } from './types';
import type { BoundingBox } from '../types/core';
import type { ProbeResult } from './schemaProbe';

const TAG = '[ImprovedSchematics] geography:';
// Offscreen canvas size. Tiles-to-cover-the-viewport scales with this, so keep
// it small: 512px loads ~4× fewer tiles than 1024px (less GPU + less contention
// with the real map's tile worker during the one-time harvest), at a slightly
// lower fitBounds zoom — fine, since we simplify the geometry afterwards anyway.
const CONTAINER_PX = 512;
// Total budget to wait for the offscreen source's tiles after fitBounds. On a fresh
// game load the basemap is saturating the tile worker/network, so the harvest tiles
// can take well over the old 6s — and waiting on a single `idle` event is unreliable
// (it can fire before the fitBounds tiles arrive under contention). We instead wait
// until areTilesLoaded() actually reports them in, up to this budget.
const TILE_WAIT_MS = 20_000;
const POLL_MS = 250;
// Cap the wait for the offscreen map's `load` event. If the source can't initialize (the
// game's tile backend not serving yet → the map errors instead of firing `load`), this
// await would otherwise hang FOREVER — which strands the caller's warm-up (its `warming`
// guard never clears) and blocks every future attempt. Time out → throw → retry.
const LOAD_TIMEOUT_MS = 15_000;

/** Resolve once every tile for the current view is loaded, or the budget elapses.
 *  Combines the `idle` event (cheap settle signal) with an areTilesLoaded() check so a
 *  premature idle (common under first-load contention) doesn't cut the harvest short. */
async function waitForTiles(map: MlMap): Promise<void> {
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const deadline = now() + TILE_WAIT_MS;
  while (now() < deadline) {
    if (map.areTilesLoaded()) return;
    const remaining = deadline - now();
    await Promise.race([
      new Promise<void>((r) => { map.once('idle', () => r()); }),
      new Promise<void>((r) => setTimeout(r, Math.min(POLL_MS, remaining))),
    ]);
  }
}

/**
 * Build a hidden offscreen MapLibre map carrying only the probed vector source,
 * fit it to the given bbox (the demand/populated-city extent), wait for tiles to
 * load, and return every feature from the target source-layers tagged with its
 * layer name. The view of the real game map is never touched. Returns [] on any
 * failure (caller treats as "no geography").
 */
export async function harvestTaggedFeatures(
  gameMap: MlMap,
  probe: ProbeResult,
  bbox: BoundingBox,
): Promise<TaggedFeature[]> {
  // Borrow the constructor from the live instance — we never import the runtime.
  const MapCtor = gameMap.constructor as typeof MlMap;

  const container = document.createElement('div');
  container.style.cssText =
    `position:absolute;left:-99999px;top:0;width:${CONTAINER_PX}px;height:${CONTAINER_PX}px;visibility:hidden;`;
  document.body.appendChild(container);

  // Minimal style: just the probed source + transparent fill layers for each
  // target source-layer, which forces MapLibre to fetch + decode those tiles.
  const style: StyleSpecification = {
    version: 8,
    sources: { [probe.sourceId]: probe.source as SourceSpecification },
    layers: probe.sourceLayers.map((sl, i) => ({
      id: `harvest-${i}`,
      type: 'fill' as const,
      source: probe.sourceId,
      'source-layer': sl,
      paint: { 'fill-opacity': 0 },
    })),
  };

  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let map: MlMap | null = null;
  let tileErrors = 0;
  try {
    map = new MapCtor({ container, style, interactive: false, attributionControl: false, fadeDuration: 0 });
    // Count tile/source load failures (e.g. the game's `map://` protocol returning 404 /
    // "Unusable" before its tile backend is ready). 0 features + tileErrors>0 ⇒ the basemap
    // isn't serving yet (the caller should retry); 0 features + no errors ⇒ genuinely empty.
    map.on('error', () => { tileErrors++; });
    await Promise.race([
      new Promise<void>((resolve) => { map!.once('load', () => resolve()); }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`offscreen map 'load' timed out after ${LOAD_TIMEOUT_MS}ms`)), LOAD_TIMEOUT_MS)),
    ]);
    map.fitBounds(
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { animate: false, padding: 0, duration: 0 },
    );
    await waitForTiles(map);

    const out: TaggedFeature[] = [];
    const counts: Record<string, number> = {};
    const loaded = map.areTilesLoaded();
    for (const sl of probe.sourceLayers) {
      const feats = map.querySourceFeatures(probe.sourceId, { sourceLayer: sl });
      counts[sl] = feats.length;
      for (const f of feats) {
        out.push({
          sourceLayer: sl,
          properties: (f.properties ?? {}) as Record<string, unknown>,
          geometry: f.geometry as TaggedFeature['geometry'],
        });
      }
    }
    console.info(`${TAG} harvested per source-layer:`, counts, `(tilesLoaded=${loaded}, tileErrors=${tileErrors})`);
    if (out.length === 0 && tileErrors > 0) {
      console.warn(`${TAG} 0 features with ${tileErrors} tile error(s) — basemap not serving tiles yet; caller will retry`);
    } else if (!loaded) {
      console.warn(`${TAG} tiles still loading after ${TILE_WAIT_MS}ms — harvest may be partial; caller will retry`);
    }
    return out;
  } catch (err) {
    console.warn(`${TAG} offscreen harvest failed:`, err);
    return [];
  } finally {
    // Tear the offscreen map down immediately so it stops contending with the
    // real map. remove() disposes the WebGL context in maplibre 5, but we also
    // force WEBGL_lose_context so the GPU frees the 2nd context now rather than
    // at GC. Grab the canvas before remove() detaches it.
    const canvas = (() => {
      try {
        return map?.getCanvas() ?? null;
      } catch {
        return null;
      }
    })();
    try {
      map?.remove();
    } catch {
      /* ignore */
    }
    try {
      const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* ignore */
    }
    container.remove();
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0);
    console.info(`${TAG} offscreen map disposed (lived ${ms}ms)`);
  }
}
