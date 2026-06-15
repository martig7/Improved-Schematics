import type { Projection } from './projection';
import type { SchematicTheme } from './types';
import { DARK_THEME } from './types';
import type { GeographyData, GeoPolyFeature } from '../geography/types';

const r = (n: number): number => Math.round(n * 10) / 10;

// Same-colour stroke width (projected units) that bridges extremely-close parks
// into one shape (their fattened outlines meet in the gap) and lightly rounds
// them. 0 disables. Dev override: GEO_PARK_BRIDGE.
const PARK_BRIDGE = (() => {
  const env = typeof process !== 'undefined' ? Number((process as { env?: Record<string, string> }).env?.GEO_PARK_BRIDGE) : NaN;
  return Number.isFinite(env) ? env : 5;
})();

/** Render a set of polygon features as one filled SVG group through `proj`.
 *  `fillRule` is 'evenodd' for water (so island holes read as land) and
 *  'nonzero' for parks (so overlapping tile-duplicate polygons merge solid
 *  instead of XOR-ing into holes). A positive `strokeWidth` paints a same-colour
 *  stroke that bridges near-touching shapes. The `imp-geo` class marks the group
 *  so the panel leaves its stroke in world units (not constant screen px). */
export function polyGroup(
  features: GeoPolyFeature[],
  proj: Projection,
  fill: string,
  fillRule: 'evenodd' | 'nonzero' = 'evenodd',
  strokeWidth = 0,
): string {
  let paths = '';
  for (const f of features) {
    if (f.geometry.type !== 'Polygon') continue;
    let d = '';
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = proj.toSVG(c);
        d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
      });
      d += 'Z ';
    }
    if (d.trim()) paths += `<path d="${d.trim()}"/>`;
  }
  if (!paths) return '';
  const stroke =
    strokeWidth > 0
      ? ` stroke="${fill}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"`
      : ' stroke="none"';
  return `<g class="imp-geo" fill="${fill}" fill-rule="${fillRule}"${stroke}>${paths}</g>`;
}

/**
 * Tile-derived geography backdrop: green first, then water on top (cleaner coast
 * where generalized land-use bleeds into water). Returns '' when geography is
 * absent — the single "no background" fallback. Rendered through whatever `proj`
 * the caller passes, so in smoothed mode it rides the density warp for free.
 */
export function geographyBackdrop(
  geo: GeographyData | undefined,
  proj: Projection,
  theme: SchematicTheme,
  dark: boolean,
): string {
  if (!geo) return '';
  const greenFill = dark ? DARK_THEME.green : theme.green;
  const waterFill = dark ? DARK_THEME.water : theme.water;
  return polyGroup(geo.green, proj, greenFill, 'nonzero', PARK_BRIDGE) + polyGroup(geo.water, proj, waterFill, 'evenodd');
}
