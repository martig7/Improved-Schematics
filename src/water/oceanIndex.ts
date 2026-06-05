// Runtime loader: fetch + gunzip the city's ocean_depth_index and generate the
// water layer, cached per city code. Browser/Electron only (uses fetch +
// DecompressionStream); the pure core lives in generate.ts for tests/harness.

import type { OceanIndex } from './types';
import type { WaterCollection } from '../render/types';
import { generateWaterFromIndex } from './generate';

const api = window.SubwayBuilderAPI;
const cache = new Map<string, WaterCollection | null>();

async function fetchOceanIndex(cityCode: string): Promise<OceanIndex | null> {
  const files = api.cities.getCityDataFiles(cityCode);
  const url = files?.oceanDepthIndex;
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    let text: string;
    if (url.endsWith('.gz') && res.body) {
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else {
      text = await res.text();
    }
    return JSON.parse(text) as OceanIndex;
  } catch (err) {
    console.warn('[ImprovedSchematics] ocean index load failed:', err);
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
