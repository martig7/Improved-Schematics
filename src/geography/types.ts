import type { Coordinate, BoundingBox } from '../types/core';

/** Which vector-tile schema the game's basemap uses. `subwaybuilder` is the
 *  game's own `general-tiles` schema (water / ocean_foundations / parks); the
 *  rest are OSM schemas kept as fallbacks. */
export type GeoSchema = 'subwaybuilder' | 'openmaptiles' | 'protomaps' | 'mapbox';

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

/** Where to point the offscreen harvest map. center = [lng,lat]; zoom is chosen
 *  to frame the whole city (the game's minZoom), so the harvest grabs every city
 *  tile rather than only those near the network. */
export interface HarvestView {
  center: [number, number];
  zoom: number;
}
