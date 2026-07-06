// Runtime loader: load the city's ocean_depth_index via the modding API and
// generate the water layer, cached per city code. The pure core lives in
// generate.ts for tests/harness.
//
// Must use api.utils.loadCityData() (which resolves through the game's local
// data server) — a plain fetch() of "/data/..." fails in the Electron renderer.
// getCityDataFiles() returns undefined for built-in cities, so we mirror the
// game's own path: "/data/<city>/ocean_depth_index.json".

import type { OceanIndex } from './types';
import type { WaterCollection } from '../render/types';
import { generateWaterFromIndex } from './generate';

const api = window.SubwayBuilderAPI;
const cache = new Map<string, WaterCollection | null>();
const TAG = '[ImprovedSchematics] water:';

async function fetchOceanIndex(cityCode: string): Promise<OceanIndex | null> {
  const files = api.cities.getCityDataFiles(cityCode);
  const path = files?.oceanDepthIndex ?? `/data/${cityCode}/ocean_depth_index.json`;
  try {
    const raw = await api.utils.loadCityData(path);
    const index = (typeof raw === 'string' ? JSON.parse(raw) : raw) as OceanIndex | null;
    return index?.cells ? index : null;
  } catch (err) {
    console.warn(`${TAG} load failed for ${path}:`, err);
    return null;
  }
}

/** Generate (and cache) the water layer for a city. Null if unavailable. */
export async function generateWater(cityCode: string): Promise<WaterCollection | null> {
  if (cache.has(cityCode)) return cache.get(cityCode) ?? null;
  const index = await fetchOceanIndex(cityCode);
  const water = index ? generateWaterFromIndex(index) : null;
  cache.set(cityCode, water);
  return water;
}
