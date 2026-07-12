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

/** A named place point (neighborhood-class label) in geographic coords. */
export interface GeoPlaceFeature {
  name: string;
  coord: Coordinate;
  /** Place class from the tile schema (neighbourhood / suburb / quarter ...). */
  kind: string;
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
  /** Neighborhood-class place labels harvested from the tiles. OPTIONAL:
   *  geography cached before this field existed loads without it (the
   *  neighborhoods toggle then has nothing to draw until a re-harvest). */
  places?: GeoPlaceFeature[];
}

/** A raw harvested feature tagged with the source-layer it came from. */
export interface TaggedFeature {
  sourceLayer: string;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
