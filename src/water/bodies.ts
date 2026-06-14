// Decompose a WaterCollection into distinct BODIES (one connected water region
// = an outer ring plus the land-holes inside it) and keep only the largest.
//
// Works for BOTH water shapes the app produces:
//   - runtime ocean-index water (generateWaterFromIndex): ONE Polygon feature
//     holding every ring, relying on fill-rule="evenodd" for nesting;
//   - pre-baked OSM geojson (sea_water.geojson): many Polygon features, one
//     body each.
// Both are handled uniformly by flattening every ring and reconstructing the
// containment hierarchy geometrically — ring nesting depth (even = water body
// outline, odd = land hole) comes from point-in-polygon tests, not from the
// input's feature grouping.

import type { WaterCollection, WaterFeature } from '../render/types';
import type { Coordinate } from '../types/core';

type Ring = Coordinate[];

export interface WaterFilterSpec {
  /** Keep at most this many bodies (largest area first). */
  maxBodies?: number;
  /** Keep bodies whose area >= this fraction (0..1) of the largest body's area. */
  minFracOfLargest?: number;
  /** Keep bodies whose absolute area (deg^2) >= this. */
  minArea?: number;
}

/** Shoelace area magnitude of a ring. Closure-agnostic: the wrap edge is always
 *  included, so it is correct whether or not the last vertex repeats the first. */
export function ringArea(ring: Ring): number {
  let a = 0;
  const len = ring.length;
  for (let i = 0; i < len; i++) {
    const j = (i + 1) % len;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

/** Ray-cast point-in-polygon against a ring's vertices. */
function pointInRing(p: Coordinate, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

type BBox = [number, number, number, number]; // [x0, y0, x1, y1]

function ringBBox(ring: Ring): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Is `inner` contained in `outer`? A single boundary vertex's ray-cast result
 * is unstable when that vertex lies exactly ON `outer` (marching-squares pinch
 * corners, coincident OSM hole vertices). Since non-crossing rings are wholly
 * inside or wholly outside, vote across several spread-out vertices so the
 * off-boundary majority decides.
 */
function ringInside(inner: Ring, outer: Ring): boolean {
  const m = inner.length - 1; // distinct vertices (closed ring repeats the first)
  const k = Math.min(7, Math.max(1, m));
  let inside = 0;
  for (let s = 0; s < k; s++) {
    if (pointInRing(inner[Math.floor((s * m) / k)], outer)) inside++;
  }
  return inside * 2 > k;
}

export interface WaterBody {
  outer: Ring;
  holes: Ring[];
  /** Outer-ring area (the body's footprint) — the ranking metric. */
  area: number;
}

/**
 * Group every ring in the collection into bodies by containment depth.
 * A ring at even nesting depth (0, 2, …) is a water outline; the odd-depth
 * rings whose nearest container is that ring are its land holes.
 */
export function decomposeWaterBodies(water: WaterCollection): WaterBody[] {
  const rings: Ring[] = [];
  for (const f of water.features) {
    if (f.geometry.type !== 'Polygon') continue;
    for (const r of f.geometry.coordinates) if (r.length >= 4) rings.push(r);
  }
  const n = rings.length;
  if (n === 0) return [];
  const areas = rings.map(ringArea);
  const bboxes = rings.map(ringBBox);

  // Each ring's containers = larger rings that enclose it. A bbox subset test
  // cheaply rejects most pairs before the point-in-polygon vote.
  const containers: number[][] = rings.map(() => []);
  for (let i = 0; i < n; i++) {
    const bi = bboxes[i];
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      const bj = bboxes[j];
      if (bi[0] < bj[0] || bi[1] < bj[1] || bi[2] > bj[2] || bi[3] > bj[3]) continue;
      if (ringInside(rings[i], rings[j])) containers[i].push(j);
    }
  }
  const depth = containers.map((c) => c.length);
  // Immediate parent = the smallest container.
  const parent = rings.map((_, i) => {
    let best = -1;
    let bestArea = Infinity;
    for (const j of containers[i]) {
      if (areas[j] < bestArea) {
        bestArea = areas[j];
        best = j;
      }
    }
    return best;
  });

  const bodies: WaterBody[] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue; // odd depth = land hole, not a body outline
    const holes: Ring[] = [];
    for (let k = 0; k < n; k++) {
      if (parent[k] === i && depth[k] % 2 === 1) holes.push(rings[k]);
    }
    bodies.push({ outer: rings[i], holes, area: areas[i] });
  }
  return bodies;
}

/**
 * Keep only the largest water bodies, dropping the small clutter. Each kept
 * body is re-emitted as its own Polygon feature ([outer, ...holes]); the
 * renderers' global even-odd fill still hole-punches land islands correctly.
 * An empty/absent spec, or a collection with no bodies, returns the input.
 */
export function keepLargestWaterBodies(
  water: WaterCollection,
  spec: WaterFilterSpec,
): WaterCollection {
  if (spec.maxBodies == null && spec.minFracOfLargest == null && spec.minArea == null) {
    return water;
  }
  const bodies = decomposeWaterBodies(water);
  if (bodies.length === 0) return water;
  // Largest first; break exact-area ties by outer-ring anchor so maxBodies cuts
  // reproducibly regardless of ring discovery order.
  bodies.sort(
    (a, b) =>
      b.area - a.area ||
      a.outer[0][0] - b.outer[0][0] ||
      a.outer[0][1] - b.outer[0][1],
  );
  const largest = bodies[0].area;

  let kept = bodies;
  if (spec.minFracOfLargest != null) {
    kept = kept.filter((b) => b.area >= largest * spec.minFracOfLargest!);
  }
  if (spec.minArea != null) kept = kept.filter((b) => b.area >= spec.minArea!);
  if (spec.maxBodies != null) kept = kept.slice(0, spec.maxBodies);

  const features: WaterFeature[] = kept.map((b) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [b.outer, ...b.holes] },
  }));
  // Drop the source bbox: it described the unfiltered extent and would now
  // over-cover the kept geometry. The renderers frame from the transit network,
  // not from water.bbox, so it is unused downstream.
  return { type: 'FeatureCollection', features };
}
