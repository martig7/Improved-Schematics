// Pure pipeline: ocean index → simplified, smoothed geographic WaterCollection.
// All rings go into a single Polygon feature; the renderers' evenodd fill turns
// nested rings into land-holes automatically.

import type { OceanIndex } from './types';
import type { WaterCollection, WaterFeature } from '../render/types';
import { buildWaterMask } from './grid';
import { traceRings } from './marchingSquares';
import { douglasPeucker, chaikin, type Pt } from './simplify';
import { keepLargestWaterBodies } from './bodies';

const DP_EPS = 0.75; // corner units (~¾ cell)
const CHAIKIN_PASSES = 2;

// Declutter the water layer: keep only bodies whose footprint is at least this
// fraction of the largest body's, dropping the swarm of tiny ponds. Water
// sources are typically dominated by one body with a large gap to the rest, so
// this threshold keeps the handful of recognizable major bodies and removes
// everything smaller.
const WATER_MIN_FRAC_OF_LARGEST = 0.01;

export function generateWaterFromIndex(index: OceanIndex): WaterCollection {
  const grid = buildWaterMask(index);
  const rings = traceRings(grid);
  const geoRings: [number, number][][] = [];

  for (const ring of rings) {
    // ring is closed (first === last); simplify the open form, then re-close
    const open = ring.slice(0, -1) as Pt[];
    if (open.length < 3) continue;
    const dp = douglasPeucker(open, DP_EPS);
    if (dp.length < 3) continue;
    const smooth = chaikin(dp, CHAIKIN_PASSES, true);
    const geo = smooth.map(([cx, cy]) => grid.cornerToGeo(cx, cy));
    geo.push(geo[0]); // close
    geoRings.push(geo);
  }

  const features: WaterFeature[] = geoRings.length
    ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: geoRings } }]
    : [];
  const collection: WaterCollection = { type: 'FeatureCollection', features };
  return keepLargestWaterBodies(collection, { minFracOfLargest: WATER_MIN_FRAC_OF_LARGEST });
}
