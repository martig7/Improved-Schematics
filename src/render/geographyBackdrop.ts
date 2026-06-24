import type { Projection } from './projection';
import type { SchematicTheme } from './types';
import { DARK_THEME } from './types';
import type { GeographyData, GeoPolyFeature } from '../geography/types';

const r = (n: number): number => Math.round(n * 10) / 10;

/** Render a set of polygon features as one filled SVG group through `proj`.
 *  `fillRule` is 'evenodd' for water (so island holes read as land) and
 *  'nonzero' for parks (so overlapping tile-duplicate polygons merge solid
 *  instead of XOR-ing into holes). */
export function polyGroup(
  features: GeoPolyFeature[],
  proj: Projection,
  fill: string,
  fillRule: 'evenodd' | 'nonzero' = 'evenodd',
  cls = '',
): string {
  // Accumulate every ring into ONE <path> so abutting per-tile polygons fill as a
  // single region. Separate <path>s leave a ~1px anti-aliasing seam where two
  // ocean tiles meet (the mid-ocean "spike"); one path + nonzero has no seam, and
  // correctly-wound holes (islands) still render as holes.
  let d = '';
  for (const f of features) {
    if (f.geometry.type !== 'Polygon') continue;
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = proj.toSVG(c);
        d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
      });
      d += 'Z ';
    }
  }
  d = d.trim();
  if (!d) return '';
  // The class lets the canvas backend (sceneFromSvg → prepareScene) bucket the backdrop
  // into its dedicated layer (z below the routes) BY DESIGN — without it the unclassed
  // group fell into 'other' and sat under the routes only by emit-order accident.
  const classAttr = cls ? `class="${cls}" ` : '';
  return `<g ${classAttr}fill="${fill}" fill-rule="${fillRule}" stroke="none"><path d="${d}"/></g>`;
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
  // Both nonzero: overlapping/self-overlapping tile polygons fill solid instead
  // of XOR-ing into gaps (the mid-ocean "spike"). Correctly-wound holes (islands)
  // still render as holes under nonzero.
  return polyGroup(geo.green, proj, greenFill, 'nonzero', 'green') + polyGroup(geo.water, proj, waterFill, 'nonzero', 'water');
}
