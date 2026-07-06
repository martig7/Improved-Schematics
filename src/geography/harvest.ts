import { logHarvestFit, logHarvestCounts, logHarvestFailed, logHarvestDisposed } from './debug/harvest.debug';
import type { Map as MlMap, StyleSpecification, SourceSpecification } from 'maplibre-gl';
import type { TaggedFeature } from './types';
import type { BoundingBox } from '../types/core';
import type { ProbeResult } from './schemaProbe';

// Offscreen canvas size. Tiles-to-cover-the-viewport scales with this, so keep
// it small: halving the dimension loads ~4× fewer tiles (less GPU and less
// contention with the real map's tile worker during the one-time harvest), at a
// slightly lower fitBounds zoom. That is fine, since we simplify the geometry
// afterwards anyway.
const CONTAINER_PX = 512;
// Total budget to wait for the offscreen source's tiles after fitBounds. On a fresh
// game load the basemap is saturating the tile worker/network, so the harvest tiles
// can take a long time to arrive. Waiting on a single `idle` event is unreliable
// (it can fire before the fitBounds tiles arrive under contention). We instead wait
// until areTilesLoaded() actually reports them in, up to this budget.
const TILE_WAIT_MS = 20_000;
const POLL_MS = 250;
// Cap the wait for the offscreen map's `load` event. If the source can't initialize (the
// game's tile backend not serving yet, so the map errors instead of firing `load`), this
// await would otherwise hang forever, which strands the caller's warm-up (its `warming`
// guard never clears) and blocks every future attempt. Timing out throws so the caller
// can retry.
const LOAD_TIMEOUT_MS = 15_000;

/** Resolve once the tiles for the fitBounds view are loaded, or the budget elapses. */
async function waitForTiles(map: MlMap): Promise<void> {
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const deadline = now() + TILE_WAIT_MS;
  const idleOrDelay = (capMs: number): Promise<void> => Promise.race([
    new Promise<void>((r) => { map.once('idle', () => r()); }),
    new Promise<void>((r) => setTimeout(r, Math.max(0, capMs))),
  ]);
  // Wait for the post-fitBounds move + tile load to settle (the NEXT idle) BEFORE trusting
  // areTilesLoaded(): right after fitBounds it still reports the prior (z0/world) view as
  // "loaded", so an early check returns before the target tiles are even requested, and we'd
  // query 0 features off the empty world view.
  await idleOrDelay(deadline - now());
  // If idle fired before every tile arrived (first-load contention), keep waiting.
  while (!map.areTilesLoaded() && now() < deadline) {
    await idleOrDelay(Math.min(POLL_MS, deadline - now()));
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
  // Borrow the constructor from the live instance so we never import the runtime.
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
    logHarvestFit(bbox, map.getZoom());
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
    logHarvestCounts(counts, loaded, tileErrors, out.length, TILE_WAIT_MS);
    return out;
  } catch (err) {
    logHarvestFailed(err);
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
    logHarvestDisposed(ms);
  }
}
