import type { Map as MlMap } from 'maplibre-gl';
import type { BoundingBox } from '../types/core';
import type { GeographyData, TaggedFeature } from './types';
import { probeVectorSchema, type ProbeResult, type StyleLike } from './schemaProbe';
import { harvestTaggedFeatures } from './harvest';
import { bucketFeatures } from './classify';

const TAG = '[ImprovedSchematics] geography:';
const cache = new Map<string, GeographyData | null>();

/** Injectable seams so the orchestrator is testable without a live map. */
export interface GeographyDeps {
  getMap: () => MlMap | null;
  probe: (style: StyleLike) => ProbeResult | null;
  harvest: (map: MlMap, probe: ProbeResult, bbox: BoundingBox) => Promise<TaggedFeature[]>;
}

// window.SubwayBuilderAPI is accessed lazily (only when getMap is actually
// called in-game), so importing this module under node:test never touches it.
const defaultDeps: GeographyDeps = {
  getMap: () => window.SubwayBuilderAPI.utils.getMap(),
  probe: probeVectorSchema,
  harvest: harvestTaggedFeatures,
};

/** Probe → harvest → classify. Returns null (→ no backdrop) on any failure. */
export async function buildGeography(bbox: BoundingBox, deps: GeographyDeps = defaultDeps): Promise<GeographyData | null> {
  try {
    const map = deps.getMap();
    if (!map) return null;
    const probe = deps.probe(map.getStyle() as unknown as StyleLike);
    if (!probe) {
      console.warn(`${TAG} no usable vector source in the basemap`);
      return null;
    }
    const raw = await deps.harvest(map, probe, bbox);
    const { water, green } = bucketFeatures(raw, probe.schema);
    if (water.length === 0 && green.length === 0) return null;
    return { bbox, water, green };
  } catch (err) {
    console.warn(`${TAG} build failed:`, err);
    return null;
  }
}

/** Cached per city. The first bbox seen for a city wins (harvested once per
 *  session); pad the bbox at the call site to cover expected network growth. */
export async function generateGeography(
  cityCode: string,
  bbox: BoundingBox,
  deps: GeographyDeps = defaultDeps,
): Promise<GeographyData | null> {
  if (cache.has(cityCode)) return cache.get(cityCode) ?? null;
  const result = await buildGeography(bbox, deps);
  cache.set(cityCode, result);
  return result;
}
