import { toPolyFeatures } from './normalize';
import type { GeoCategory, GeoPolyFeature, GeoSchema, TaggedFeature } from './types';

/** Land-use/land-cover/natural values we treat as green space, across schemas
 *  (OpenMapTiles `class`, Protomaps `pmap:kind`, Tilezen/Subway-Builder `kind`). */
const GREEN_VALUES = new Set([
  'park', 'grass', 'grassland', 'forest', 'wood', 'woodland', 'meadow', 'scrub',
  'heath', 'fell', 'moor', 'garden', 'recreation_ground', 'cemetery', 'grave_yard',
  'nature_reserve', 'protected_area', 'national_park', 'conservation', 'farmland',
  'farmyard', 'orchard', 'vineyard', 'allotments', 'village_green', 'common',
  'golf_course', 'pitch', 'playground', 'dog_park', 'wetland', 'marsh', 'greenfield',
  'plant_nursery',
]);

/** Classify a harvested feature into a geography category, or null to drop it.
 *  Reads the value from whichever property key the schema uses (class / kind /
 *  pmap:kind / subclass / type). */
export function classifyFeature(
  sourceLayer: string,
  props: Record<string, unknown>,
  _schema: GeoSchema,
): GeoCategory | null {
  if (sourceLayer === 'water' || sourceLayer === 'ocean_foundations') return 'water';
  if (sourceLayer === 'park' || sourceLayer === 'parks') return 'green'; // dedicated park layer (OMT / Subway Builder)
  const value = String(
    props['class'] ?? props['kind'] ?? props['pmap:kind'] ?? props['subclass'] ?? props['type'] ?? '',
  ).toLowerCase();
  return GREEN_VALUES.has(value) ? 'green' : null;
}

/** Classify every feature and normalize the kept ones into polygon collections. */
export function bucketFeatures(
  features: TaggedFeature[],
  schema: GeoSchema,
): { water: GeoPolyFeature[]; green: GeoPolyFeature[] } {
  const water: TaggedFeature[] = [];
  const green: TaggedFeature[] = [];
  for (const f of features) {
    const cat = classifyFeature(f.sourceLayer, f.properties ?? {}, schema);
    if (cat === 'water') water.push(f);
    else if (cat === 'green') green.push(f);
  }
  return { water: toPolyFeatures(water), green: toPolyFeatures(green) };
}
