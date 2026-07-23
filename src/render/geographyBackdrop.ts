import type { Projection } from './projection';
import type { SchematicTheme } from './types';
import { DARK_THEME } from './types';
import type { GeographyData, GeoPolyFeature } from '../geography/types';
import { stylizeRingsPathD, type LandmassStyle, type Pt } from './geoSimplify';

const r = (n: number): number => Math.round(n * 10) / 10;

/** The smoothed pre's draw-time backdrop source: every water/green ring already
 *  projected to render px (rounded 0.1, same as the emitted path data), plus the
 *  resolved fills. Lets the landmass style re-render the backdrop on toggle
 *  without re-running the projection (which lives in the heavy precompute). */
export interface GeoRingsPx {
  green: Pt[][];
  water: Pt[][];
  greenFill: string;
  waterFill: string;
}

/** Project every polygon ring of both categories through `proj` into px space. */
export function projectGeoRings(
  geo: GeographyData | undefined,
  proj: Projection,
  theme: SchematicTheme,
  dark: boolean,
): GeoRingsPx | undefined {
  if (!geo) return undefined;
  const project = (feats: GeoPolyFeature[]): Pt[][] => {
    const rings: Pt[][] = [];
    for (const f of feats) {
      if (f.geometry.type !== 'Polygon') continue;
      for (const ring of f.geometry.coordinates) {
        const out: Pt[] = [];
        for (const c of ring) {
          const [x, y] = proj.toSVG(c);
          out.push([r(x), r(y)]);
        }
        rings.push(out);
      }
    }
    return rings;
  };
  return {
    green: project(geo.green),
    water: project(geo.water),
    greenFill: theme.green,
    waterFill: theme.water,
  };
}

/** Build the backdrop groups from pre-projected rings. Emits the faithful
 *  polygons when `style` is absent, the simplified/rounded landmass blobs when
 *  set. Mirrors geographyBackdrop's structure (green under water, one path per
 *  category, nonzero fill). */
export function backdropFromRings(rings: GeoRingsPx, extent: { w: number; h: number }, style?: LandmassStyle): string {
  // Parks claim importance far more weakly than water. A lake in the dense
  // core is a landmark; a pocket park is clutter. Full green protection is a
  // major source of mid-map speckle in the diagram modes.
  const GREEN_IMP = 0.5;
  const group = (rs: Pt[][], fill: string, cls: string): string => {
    let d = '';
    if (style) {
      const imp = style.importance;
      // dryPoints + continuity are WATER constraints. A station sitting on a
      // park is fine, and fragmented parks don't read as "created lakes".
      const catStyle = cls === 'green'
        ? {
            ...style,
            importance: imp ? (x: number, y: number) => GREEN_IMP * imp(x, y) : undefined,
            dryPoints: undefined,
            keepConnected: undefined,
          }
        : { ...style, keepConnected: true };
      d = stylizeRingsPathD(rs, catStyle, extent);
    } else {
      for (const ring of rs) {
        ring.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1] + ' '; });
        d += 'Z ';
      }
      d = d.trim();
    }
    if (!d) return '';
    return `<g class="${cls}" fill="${fill}" fill-rule="nonzero" stroke="none"><path d="${d}"/></g>`;
  };
  return group(rings.green, rings.greenFill, 'green') + group(rings.water, rings.waterFill, 'water');
}

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
  // The class lets the canvas backend (sceneFromSvg then prepareScene) bucket the backdrop
  // into its dedicated layer (z below the routes) BY DESIGN. Without it the unclassed
  // group falls into 'other' and sits under the routes only by emit-order accident.
  const classAttr = cls ? `class="${cls}" ` : '';
  return `<g ${classAttr}fill="${fill}" fill-rule="${fillRule}" stroke="none"><path d="${d}"/></g>`;
}

/**
 * Tile-derived geography backdrop: green first, then water on top (cleaner coast
 * where generalized land-use bleeds into water). Returns '' when geography is
 * absent, the single "no background" fallback. Rendered through whatever `proj`
 * the caller passes, so in smoothed mode it rides the density warp for free.
 */
export function geographyBackdrop(
  geo: GeographyData | undefined,
  proj: Projection,
  theme: SchematicTheme,
  dark: boolean,
): string {
  if (!geo) return '';
  const greenFill = theme.green;
  const waterFill = theme.water;
  // Both nonzero: overlapping/self-overlapping tile polygons fill solid instead
  // of XOR-ing into gaps (the mid-ocean "spike"). Correctly-wound holes (islands)
  // still render as holes under nonzero.
  return polyGroup(geo.green, proj, greenFill, 'nonzero', 'green') + polyGroup(geo.water, proj, waterFill, 'nonzero', 'water');
}
