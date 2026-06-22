import type { Map as MlMap } from 'maplibre-gl';
import type { GeographyData, TaggedFeature } from './types';
import type { BoundingBox } from '../types/core';
import { probeVectorSchema, type ProbeResult, type StyleLike } from './schemaProbe';
import { harvestTaggedFeatures } from './harvest';
import { bucketFeatures } from './classify';
import { cleanFeatures } from './clean';
import { featuresBbox } from './bbox';
import { combineClose } from './combine';

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
    // Merge extremely-close park fragments BEFORE the size filter (morphological
    // close on a raster), so a park split into sub-threshold pieces survives as
    // one. GEO_PARK_GAP_M = bridge distance in meters (0 disables).
    const mergedGreen = combineClose(rawGreen, { gapM: envNum('GEO_PARK_GAP_M', 50) });
    // Min area to keep as a fraction of total map area (scale-invariant). Thin
    // rivers fall below it and get dropped — accepted trade-off.
    // smoothIters: 0 for water — Chaikin rounds the corner where a per-tile ocean
    // piece's seam meets the coastline, pulling that seam edge off the shared tile
    // boundary so adjacent pieces no longer align → a thin gap (the mid-ocean
    // "spike"). DP alone keeps the seam edges straight, so the tiles stay flush.
    const water = cleanFeatures(rawWater, bbox, { minAreaFrac: envNum('GEO_MIN_WATER_FRAC', 0.00004), simplifyM, smoothIters: 0 });
    const green = cleanFeatures(mergedGreen, bbox, { minAreaFrac: envNum('GEO_MIN_PARK_FRAC', 0.0001), simplifyM, smoothIters, dropHoles: true });

    if (water.length === 0 && green.length === 0) {
      console.warn(`${TAG} all polygons trimmed away (raw ${rawWater.length}+${rawGreen.length})`);
      return null;
    }
    console.info(`${TAG} ${probe.schema}: ${water.length} water + ${green.length} green (raw ${rawWater.length}+${rawGreen.length} → ${mergedGreen.length} merged parks), bbox [${bbox.map((n) => n.toFixed(3)).join(', ')}]`);
    return { bbox, water, green };
  } catch (err) {
    console.warn(`${TAG} build failed:`, err);
    return null;
  }
}

/** Cached per city: a SUCCESSFUL harvest is reused for the rest of the session.
 *  A null result (map/tiles not ready yet, or a transient failure) is deliberately
 *  NOT cached, so an early call before the basemap is ready doesn't poison the
 *  city for the session — the caller (panel) retries until it succeeds. */
export async function generateGeography(
  cityCode: string,
  harvestBbox: BoundingBox,
  deps: GeographyDeps = defaultDeps,
): Promise<GeographyData | null> {
  const cached = cache.get(cityCode);
  if (cached) return cached;
  const result = await buildGeography(harvestBbox, deps);
  if (result) cache.set(cityCode, result);
  return result;
}
