import type { Map as MlMap } from 'maplibre-gl';
import type { GeographyData, TaggedFeature } from './types';
import type { BoundingBox } from '../types/core';
import { probeVectorSchema, type ProbeResult, type StyleLike } from './schemaProbe';
import { harvestTaggedFeatures } from './harvest';
import { bucketFeatures } from './classify';
import { cleanFeatures } from './clean';
import { featuresBbox } from './bbox';
import { combineClose } from './combine';
import { readGeoCache, writeGeoCache } from './geoCache';
import { computeHarvestBbox, bboxApproxEqual } from './harvestBbox';
import { getLandDetail, type LandDetail } from './detail';
import { envNum as readEnvNum } from '../env';

const TAG = '[ImprovedSchematics] geography:';
// In-memory per-city cache, tagged with the harvest extent so a changed demand extent
// (across this session OR a reload, via the persisted layer) is re-harvested, not served
// stale. Only successful harvests are stored.
const cache = new Map<string, { bbox: BoundingBox; geography: GeographyData; detail: LandDetail }>();

/** Read a numeric dev knob from the environment (Electron renderer exposes
 *  process.env, mirroring the OCTI_* tuning vars), falling back to a default. */
function envNum(name: string, fallback: number): number {
  const v = readEnvNum(name);
  return Number.isFinite(v) ? v : fallback;
}

/** Injectable seams so the orchestrator is testable without a live map. */
export interface GeographyDeps {
  getMap: () => MlMap | null;
  probe: (style: StyleLike) => ProbeResult | null;
  harvest: (map: MlMap, probe: ProbeResult, bbox: BoundingBox, detail: LandDetail) => Promise<TaggedFeature[]>;
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
export async function buildGeography(
  harvestBbox: BoundingBox,
  deps: GeographyDeps = defaultDeps,
  detail: LandDetail = getLandDetail(),
): Promise<GeographyData | null> {
  try {
    const map = deps.getMap();
    if (!map) return null;
    // Don't probe before the basemap style exists. Early on `getStyle()` is empty
    // (0 sources) or undefined, which the probe cannot read.
    // Defer; the caller retries once the style is in. (Guarded for the injectable test map.)
    const m = map as unknown as { isStyleLoaded?: () => boolean };
    if (typeof m.isStyleLoaded === 'function' && !m.isStyleLoaded()) {
      console.warn(`${TAG} basemap style not loaded yet — deferring harvest`);
      return null;
    }
    const style = map.getStyle() as unknown as StyleLike;
    const probe = deps.probe(style);
    if (!probe) {
      console.warn(`${TAG} no usable vector source in the basemap`);
      return null;
    }
    // Operational probe summary (warn so every console surfaces it): which
    // schema matched, which source-layers will be queried, and what OTHER
    // source-layers the style exposes, so a missing layer class (e.g. the
    // place labels) is diagnosable from a single in-game line.
    {
      const styled = new Set<string>();
      for (const l of style.layers ?? []) if (l.source === probe.sourceId && l['source-layer']) styled.add(l['source-layer']!);
      const unqueried = [...styled].filter((sl) => !probe.sourceLayers.includes(sl));
      console.warn(`${TAG} probe: schema=${probe.schema} source='${probe.sourceId}' querying [${probe.sourceLayers.join(', ')}]; other style layers [${unqueried.join(', ')}]`);
    }
    const raw = await deps.harvest(map, probe, harvestBbox, detail);
    {
      const perLayer = new Map<string, number>();
      for (const f of raw) perLayer.set(f.sourceLayer, (perLayer.get(f.sourceLayer) ?? 0) + 1);
      console.warn(`${TAG} harvested features: ${[...perLayer].map(([k, n]) => k + '=' + n).join(' ') || 'none'}`);
    }
    const { water: rawWater, green: rawGreen, places } = bucketFeatures(raw, probe.schema);
    const bbox = featuresBbox([...rawWater, ...rawGreen]);
    if (!bbox) {
      console.warn(`${TAG} harvested 0 polygons from '${probe.sourceId}' (${probe.schema}, layers: ${probe.sourceLayers.join(', ')})`);
      return null;
    }

    // Declutter + smooth: drop sub-threshold polygons and round the MVT
    // stair-steps. Tunable via env (set before launching, like the OCTI_* knobs):
    //   GEO_MIN_WATER_M2 / GEO_MIN_PARK_M2 set min area to keep (m²)
    //   GEO_SIMPLIFY_M sets Douglas–Peucker tolerance (m); GEO_SMOOTH sets Chaikin iters
    const simplifyM = envNum('GEO_SIMPLIFY_M', 30);
    const smoothIters = envNum('GEO_SMOOTH', 2);
    // Merge extremely-close park fragments BEFORE the size filter (morphological
    // close on a raster), so a park split into sub-threshold pieces survives as
    // one. GEO_PARK_GAP_M = bridge distance in meters (0 disables).
    const mergedGreen = combineClose(rawGreen, { gapM: envNum('GEO_PARK_GAP_M', 50) });
    // Min area to keep as a fraction of total map area (scale-invariant). Thin
    // features below it are dropped, an accepted trade-off.
    // smoothIters is 0 for water. Chaikin rounds the corner where a per-tile ocean
    // piece's seam meets the coastline, pulling that seam edge off the shared tile
    // boundary so adjacent pieces no longer align, producing a thin mid-ocean gap.
    // DP alone keeps the seam edges straight, so the tiles stay flush.
    const water = cleanFeatures(rawWater, bbox, { minAreaFrac: envNum('GEO_MIN_WATER_FRAC', 0.00004), simplifyM, smoothIters: 0 });
    const green = cleanFeatures(mergedGreen, bbox, { minAreaFrac: envNum('GEO_MIN_PARK_FRAC', 0.0001), simplifyM, smoothIters, dropHoles: true });

    if (water.length === 0 && green.length === 0) {
      console.warn(`${TAG} all polygons trimmed away (raw ${rawWater.length}+${rawGreen.length})`);
      return null;
    }
    console.info(`${TAG} ${probe.schema}: ${water.length} water + ${green.length} green + ${places.length} places (raw ${rawWater.length}+${rawGreen.length} → ${mergedGreen.length} merged parks), bbox [${bbox.map((n) => n.toFixed(3)).join(', ')}]`);
    return { bbox, water, green, ...(places.length > 0 ? { places } : {}) };
  } catch (err) {
    console.warn(`${TAG} build failed:`, err);
    return null;
  }
}

/** Synchronous read of the per-city cache (no harvest). Returns the geography if a
 *  prior generateGeography for this city already succeeded, either this session (in-memory) or a
 *  previous one (localStorage, hydrated into memory here); otherwise null. Lets the panel pick
 *  up a background warm-up's result, OR a prior session's persisted harvest, instantly on
 *  open without re-harvesting. */
export function peekGeography(cityCode: string): GeographyData | null {
  // The current demand extent (if the game state is ready). When known, a cached harvest
  // from a DIFFERENT extent is treated as a miss so the poll/warm-up re-harvests; when the
  // extent can't be computed yet, fall back to whatever's cached (best-effort display).
  const cur = computeHarvestBbox();
  // A harvest taken at a different DETAIL level is a miss too, so raising the
  // setting re-harvests rather than showing the coarser geometry indefinitely.
  const detail = getLandDetail();
  const mem = cache.get(cityCode);
  if (mem && mem.detail === detail && (!cur || bboxApproxEqual(mem.bbox, cur.bbox))) return mem.geography;
  const persisted = readGeoCache(cityCode);
  if (persisted && persisted.detail === detail && (!cur || bboxApproxEqual(persisted.bbox, cur.bbox))) {
    cache.set(cityCode, { bbox: persisted.bbox, geography: persisted.geography, detail });
    return persisted.geography;
  }
  return null;
}

/** Cached per city: a SUCCESSFUL harvest is reused for the rest of the session.
 *  A null result (map/tiles not ready yet, or a transient failure) is deliberately
 *  NOT cached, so an early call before the basemap is ready doesn't poison the
 *  city for the session. The caller (panel) retries until it succeeds. */
export async function generateGeography(
  cityCode: string,
  harvestBbox: BoundingBox,
  deps: GeographyDeps = defaultDeps,
  persist = true,
): Promise<GeographyData | null> {
  // Reuse a cached harvest only when it was taken at the SAME extent as requested; a changed
  // demand extent re-harvests (the persisted entry is keyed by city but tagged with its bbox).
  // A harvest is reusable only at the same extent AND the same detail level, since
  // the level caps the tile detail baked into the geometry.
  const detail = getLandDetail();
  const cached = cache.get(cityCode);
  if (cached && cached.detail === detail && bboxApproxEqual(cached.bbox, harvestBbox)) return cached.geography;
  const persisted = readGeoCache(cityCode);
  if (persisted && persisted.detail === detail && bboxApproxEqual(persisted.bbox, harvestBbox)) {
    cache.set(cityCode, { bbox: persisted.bbox, geography: persisted.geography, detail });
    return persisted.geography;
  }
  const result = await buildGeography(harvestBbox, deps, detail);
  if (result) {
    cache.set(cityCode, { bbox: harvestBbox, geography: result, detail });
    // Persist only a DEMAND-based harvest (the stable, full-city extent). A transient
    // station-fallback harvest (demand not ready yet) is kept in memory for the session but
    // not frozen to disk, so a later reload re-harvests at the proper extent.
    if (persist) writeGeoCache(cityCode, harvestBbox, result, detail);
  }
  return result;
}
