import { toPolyFeatures } from './normalize';
import type { GeoCategory, GeoPlaceFeature, GeoPolyFeature, GeoSchema, TaggedFeature } from './types';

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

/** Label-point source-layers across schemas (see schemaProbe SIGNATURES), each
 *  mapped to the place kind the layer name itself implies. Generic layers map
 *  to null: their features must carry a recognized kind property. The game's
 *  per-kind layers carry the kind in the name, so their features need none. */
const PLACE_LAYERS = new Map<string, string | null>([
  ['place', null],
  ['places', null],
  ['place_label', null],
  ['neighborhood_labels', 'neighbourhood'],
  ['suburb_labels', 'suburb'],
]);

/** Neighborhood-scale place classes we label; city/town/village stay off the
 *  schematic (station labels already carry that scale of orientation). */
const PLACE_KINDS = new Set(['neighbourhood', 'neighborhood', 'suburb', 'quarter', 'borough', 'district']);

/** Extract named neighborhood-class points from the place source-layers. */
export function extractPlaces(features: TaggedFeature[]): GeoPlaceFeature[] {
  const out: GeoPlaceFeature[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const layerKind = PLACE_LAYERS.get(f.sourceLayer);
    if (layerKind === undefined) continue;
    const props = f.properties ?? {};
    const propKind = String(
      props['class'] ?? props['kind'] ?? props['pmap:kind'] ?? props['subclass'] ?? props['type'] ?? '',
    ).toLowerCase();
    const kind = PLACE_KINDS.has(propKind) ? propKind : layerKind;
    if (!kind) continue;
    const name = String(props['name:en'] ?? props['name_en'] ?? props['name'] ?? '').trim();
    if (!name) continue;
    // Point / MultiPoint only; tiles repeat a label point per tile, so dedupe
    // by kind+name (first occurrence wins, deterministic in harvest order).
    let coord: [number, number] | null = null;
    if (f.geometry.type === 'Point') coord = f.geometry.coordinates as [number, number];
    else if (f.geometry.type === 'MultiPoint') coord = (f.geometry.coordinates as [number, number][])[0] ?? null;
    if (!coord || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) continue;
    const key = kind + '|' + name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, coord: [coord[0], coord[1]], kind });
  }
  return out;
}

/** Classify every feature and normalize the kept ones into polygon collections,
 *  plus the named neighborhood place points. */
export function bucketFeatures(
  features: TaggedFeature[],
  schema: GeoSchema,
): { water: GeoPolyFeature[]; green: GeoPolyFeature[]; places: GeoPlaceFeature[] } {
  const water: TaggedFeature[] = [];
  const green: TaggedFeature[] = [];
  for (const f of features) {
    const cat = classifyFeature(f.sourceLayer, f.properties ?? {}, schema);
    if (cat === 'water') water.push(f);
    else if (cat === 'green') green.push(f);
  }
  return { water: toPolyFeatures(water), green: toPolyFeatures(green), places: extractPlaces(features) };
}
