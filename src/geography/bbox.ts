import type { BoundingBox } from '../types/core';
import type { GeoPolyFeature } from './types';

/** Axis-aligned [minLng,minLat,maxLng,maxLat] over every coordinate in the given
 *  polygon features, or null if there are none. This is the real data extent —
 *  ≈ the city extent, since the city's tiles only carry features inside it — so
 *  it frames the map without needing a separately-known city bbox. */
export function featuresBbox(features: GeoPolyFeature[]): BoundingBox | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const f of features) {
    for (const ring of f.geometry.coordinates) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (!Number.isFinite(minLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}
