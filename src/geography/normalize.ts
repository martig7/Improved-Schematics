import type { Coordinate } from '../types/core';
import type { GeoPolyFeature, TaggedFeature } from './types';

type GeomInput = Pick<TaggedFeature, 'geometry'>;

/** Flatten GeoJSON Polygon/MultiPolygon geometries into single-Polygon features.
 *  Non-polygon geometries (points, lines) are dropped. */
export function toPolyFeatures(items: GeomInput[]): GeoPolyFeature[] {
  const out: GeoPolyFeature[] = [];
  for (const it of items) {
    const geom = it.geometry;
    if (geom.type === 'Polygon') {
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: geom.coordinates as Coordinate[][] } });
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as Coordinate[][][]) {
        out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly } });
      }
    }
  }
  return out;
}
