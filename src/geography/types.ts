import type { Coordinate, BoundingBox } from '../types/core';

/** Which OSM vector-tile schema the game's basemap uses. */
export type GeoSchema = 'openmaptiles' | 'protomaps' | 'mapbox';

/** Geography category we keep; everything else is dropped. */
export type GeoCategory = 'water' | 'green';

/** A single-ring-set polygon feature in geographic coords (first ring exterior, rest holes). */
export interface GeoPolyFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Coordinate[][] };
}

/** Tile-derived geography for one city, ready to project + render. */
export interface GeographyData {
  bbox: BoundingBox;
  water: GeoPolyFeature[];
  green: GeoPolyFeature[];
}

/** A raw harvested feature tagged with the source-layer it came from. */
export interface TaggedFeature {
  sourceLayer: string;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
