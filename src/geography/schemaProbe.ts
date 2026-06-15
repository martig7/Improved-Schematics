import type { GeoSchema } from './types';

/** Minimal read-only view of a MapLibre style (we only read sources + layers). */
export interface StyleLike {
  sources?: Record<string, { type?: string; [k: string]: unknown }>;
  layers?: Array<{ source?: string; 'source-layer'?: string }>;
}

export interface ProbeResult {
  sourceId: string;
  /** The vector source spec copied verbatim from the style (for the offscreen map). */
  source: unknown;
  schema: GeoSchema;
  /** Source-layers to query (water + green layers present in the style). */
  sourceLayers: string[];
}

/** Ordered so the most specific signature wins. `collect` lists every green
 *  source-layer to query; `requireAny` is the discriminator that must be present
 *  for the schema to match (so Protomaps's `natural` distinguishes it from the
 *  OpenMapTiles/Mapbox `landuse` schemas, which classify identically anyway). */
const SIGNATURES: Array<{ schema: GeoSchema; water: string[]; collect: string[]; requireAny: string[] }> = [
  // The game's own `general-tiles` schema. `parks` (plural) is the discriminator
  // — no OSM schema uses it — and `ocean_foundations` carries the saltwater/sea
  // while `water` is inland lakes/rivers, so both count as water.
  { schema: 'subwaybuilder', water: ['water', 'ocean_foundations'], collect: ['parks'], requireAny: ['parks'] },
  { schema: 'protomaps', water: ['water'], collect: ['natural', 'landuse'], requireAny: ['natural'] },
  { schema: 'openmaptiles', water: ['water'], collect: ['landcover', 'park', 'landuse'], requireAny: ['landcover', 'park'] },
  { schema: 'mapbox', water: ['water'], collect: ['landuse', 'landcover'], requireAny: ['landuse', 'landcover'] },
];

/** Find the first vector source whose layers match a known OSM schema. */
export function probeVectorSchema(style: StyleLike): ProbeResult | null {
  const sources = style.sources ?? {};
  for (const [sourceId, src] of Object.entries(sources)) {
    if (!src || src.type !== 'vector') continue;
    const present = new Set<string>();
    for (const l of style.layers ?? []) {
      if (l.source === sourceId && l['source-layer']) present.add(l['source-layer']!);
    }
    for (const sig of SIGNATURES) {
      const hasWater = sig.water.some((w) => present.has(w));
      const discriminates = sig.requireAny.some((g) => present.has(g));
      if (!hasWater || !discriminates) continue;
      const greens = sig.collect.filter((g) => present.has(g));
      const sourceLayers = [...new Set([...sig.water.filter((w) => present.has(w)), ...greens])];
      return { sourceId, source: src, schema: sig.schema, sourceLayers };
    }
  }
  return null;
}
