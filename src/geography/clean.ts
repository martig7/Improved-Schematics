import type { BoundingBox, Coordinate } from '../types/core';
import type { GeoPolyFeature } from './types';
import { douglasPeucker, chaikin, type Pt } from '../water/simplify';
import { ringArea } from '../water/bodies';

export interface CleanOptions {
  /** Drop a polygon whose outer ring is smaller than this fraction of the total
   *  map (bbox) area. Scale-invariant — trims proportionally on any city size. */
  minAreaFrac: number;
  /** Douglas–Peucker tolerance in meters (0 = no simplification). */
  simplifyM: number;
  /** Chaikin corner-rounding iterations (0 = no smoothing). */
  smoothIters: number;
  /** Keep only the exterior ring (fill holes). Used for parks; water keeps its
   *  holes so islands read as land. */
  dropHoles?: boolean;
}

/**
 * Declutter + smooth tile-derived geography. Areas and tolerances are real-world
 * meters via a local equirectangular scale at the bbox center latitude: each
 * polygon is projected to meters, dropped if its outer ring is too small, then
 * each ring is simplified (Douglas–Peucker, removing MVT stair-steps) and rounded
 * (Chaikin) before being projected back to [lng,lat]. Pure + cached upstream.
 */
export function cleanFeatures(features: GeoPolyFeature[], bbox: BoundingBox, opts: CleanOptions): GeoPolyFeature[] {
  const lng0 = bbox[0];
  const lat0 = bbox[1];
  const centerLat = (bbox[1] + bbox[3]) / 2;
  const mx = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const my = 111_320;
  const toM = (c: Coordinate): Pt => [(c[0] - lng0) * mx, (c[1] - lat0) * my];
  const toLngLat = (p: Pt): Coordinate => [lng0 + p[0] / mx, lat0 + p[1] / my];

  // Absolute area threshold (m²) = fraction × total map area, so the filter
  // scales with the bbox rather than needing a per-city tweak.
  const mapAreaM2 = Math.abs((bbox[2] - bbox[0]) * mx) * Math.abs((bbox[3] - bbox[1]) * my);
  const minAreaM2 = opts.minAreaFrac * mapAreaM2;

  const out: GeoPolyFeature[] = [];
  for (const f of features) {
    const rings = f.geometry.coordinates;
    if (rings.length === 0) continue;
    const ringsM = rings.map((r) => r.map(toM));
    if (ringArea(ringsM[0]) < minAreaM2) continue; // outer ring too small → drop whole polygon
    const cleaned: Coordinate[][] = [];
    const sourceRings = opts.dropHoles ? ringsM.slice(0, 1) : ringsM; // exterior only when filling holes
    for (const rM of sourceRings) {
      const s = smoothRing(rM, opts.simplifyM, opts.smoothIters);
      if (s.length >= 3) cleaned.push(s.map(toLngLat));
    }
    if (cleaned.length > 0) out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: cleaned } });
  }
  return out;
}

/** Simplify + smooth one closed ring (in meter space). The closing duplicate is
 *  stripped so DP/Chaikin treat it as a loop; the SVG renderer re-closes via 'Z'. */
function smoothRing(ringM: Pt[], simplifyM: number, smoothIters: number): Pt[] {
  let pts = ringM.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
  if (pts.length < 3) return ringM.slice();
  let s = simplifyM > 0 ? douglasPeucker(pts, simplifyM) : pts;
  if (smoothIters > 0) s = chaikin(s, smoothIters, true);
  return s;
}
