import type { Map as MlMap } from 'maplibre-gl';
import type { GeographyData, TaggedFeature } from './types';
import type { BoundingBox } from '../types/core';
import { probeVectorSchema, type ProbeResult, type StyleLike } from './schemaProbe';
import { harvestTaggedFeatures } from './harvest';
import { bucketFeatures } from './classify';
import { cleanFeatures } from './clean';
import { featuresBbox } from './bbox';

const TAG = '[ImprovedSchematics] geography:';
const cache = new Map<string, GeographyData | null>();

/** Read a numeric dev knob from the environment (Electron renderer exposes
 *  process.env, mirroring the OCTI_* tuning vars), falling back to a default. */
function envNum(name: string, fallback: number): number {
  const v = typeof process !== 'undefined' ? Number((process as { env?: Record<string, string> }).env?.[name]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

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

/** Probe → harvest the demand-extent tiles → classify. The framing bbox is
 *  derived from the harvested features (the real data extent). Null on failure. */
export async function buildGeography(harvestBbox: BoundingBox, deps: GeographyDeps = defaultDeps): Promise<GeographyData | null> {
  try {
    const map = deps.getMap();
    if (!map) return null;
    const probe = deps.probe(map.getStyle() as unknown as StyleLike);
    if (!probe) {
      console.warn(`${TAG} no usable vector source in the basemap`);
      return null;
    }
    const raw = await deps.harvest(map, probe, harvestBbox);
    const { water: rawWater, green: rawGreen } = bucketFeatures(raw, probe.schema);
    const bbox = featuresBbox([...rawWater, ...rawGreen]);
    if (!bbox) {
      console.warn(`${TAG} harvested 0 polygons from '${probe.sourceId}' (${probe.schema}, layers: ${probe.sourceLayers.join(', ')})`);
      return null;
    }

    // Declutter + smooth: drop sub-threshold polygons and round the MVT
    // stair-steps. Tunable via env (set before launching, like the OCTI_* knobs):
    //   GEO_MIN_WATER_M2 / GEO_MIN_PARK_M2 — min area to keep (m²)
    //   GEO_SIMPLIFY_M — Douglas–Peucker tolerance (m); GEO_SMOOTH — Chaikin iters
    const simplifyM = envNum('GEO_SIMPLIFY_M', 30);
    const smoothIters = envNum('GEO_SMOOTH', 2);
    const water = cleanFeatures(rawWater, bbox, { minAreaM2: envNum('GEO_MIN_WATER_M2', 100_000), simplifyM, smoothIters });
    const green = cleanFeatures(rawGreen, bbox, { minAreaM2: envNum('GEO_MIN_PARK_M2', 40_000), simplifyM, smoothIters });

    if (water.length === 0 && green.length === 0) {
      console.warn(`${TAG} all polygons trimmed away (raw ${rawWater.length}+${rawGreen.length})`);
      return null;
    }
    console.info(`${TAG} ${probe.schema}: ${water.length} water + ${green.length} green (from ${rawWater.length}+${rawGreen.length} raw), bbox [${bbox.map((n) => n.toFixed(3)).join(', ')}]`);
    return { bbox, water, green };
  } catch (err) {
    console.warn(`${TAG} build failed:`, err);
    return null;
  }
}

/** Cached per city: the geography is harvested once per session. */
export async function generateGeography(
  cityCode: string,
  harvestBbox: BoundingBox,
  deps: GeographyDeps = defaultDeps,
): Promise<GeographyData | null> {
  if (cache.has(cityCode)) return cache.get(cityCode) ?? null;
  const result = await buildGeography(harvestBbox, deps);
  cache.set(cityCode, result);
  return result;
}
