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
  /** Outline of the harvested DATA REGION in the current coordinate frame
   *  (closed polygon, no repeated end point). Absent = the bbox rect. Set by
   *  rotateSchematicInput: the rotated harvest rect is a diamond in the render
   *  frame. The renderer draws LAND only inside this hull. The canvas
   *  outside it is data void and paints as background, never as fake land. */
  hull?: Coordinate[];
}

/** A raw harvested feature tagged with the source-layer it came from. */
export interface TaggedFeature {
  sourceLayer: string;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
