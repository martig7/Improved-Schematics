import type { Map as MlMap, StyleSpecification, SourceSpecification } from 'maplibre-gl';
import type { BoundingBox } from '../types/core';
import type { TaggedFeature } from './types';
import type { ProbeResult } from './schemaProbe';

const TAG = '[ImprovedSchematics] geography:';
const CONTAINER_PX = 1024; // offscreen canvas size; larger = higher fitBounds zoom = more detail
const IDLE_TIMEOUT_MS = 10_000;

function nextIdleOrTimeout(map: MlMap): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, IDLE_TIMEOUT_MS);
    map.once('idle', done);
  });
}

/**
 * Build a hidden offscreen MapLibre map carrying only the probed vector source,
 * fit it to the city bbox, wait for tiles to load, and return every feature from
 * the target source-layers tagged with its layer name. The view of the real game
 * map is never touched. Returns [] on any failure (caller treats as "no geography").
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

  let map: MlMap | null = null;
  try {
    map = new MapCtor({ container, style, interactive: false, attributionControl: false, fadeDuration: 0 });
    await new Promise<void>((resolve) => map!.once('load', () => resolve()));
    map.fitBounds(
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { animate: false, padding: 0, duration: 0 },
    );
    await nextIdleOrTimeout(map);

    const out: TaggedFeature[] = [];
    const counts: Record<string, number> = {};
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
    console.info(`${TAG} harvested per source-layer:`, counts);
    return out;
  } catch (err) {
    console.warn(`${TAG} offscreen harvest failed:`, err);
    return [];
  } finally {
    map?.remove();
    container.remove();
  }
}
