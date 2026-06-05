/**
 * Geographic → SVG projection.
 *
 * Uses an equirectangular projection with a cos(latitude) correction on the
 * x-axis so that shapes keep a correct aspect ratio at city scale (raw lng/lat
 * would stretch the map vertically away from the equator). Water polygons and
 * route lines share a single Projection instance so they always align.
 */

import type { Coordinate, BoundingBox } from '../types/core';

export interface Projection {
  /** Project a geographic coordinate to SVG pixel space. */
  toSVG(coord: Coordinate): [number, number];
  width: number;
  height: number;
}

/**
 * Build a projection that fits `bounds` into a `width`×`height` viewport with
 * fractional `padding` on each side, preserving aspect ratio and centering.
 */
export function createProjection(
  bounds: BoundingBox,
  width: number,
  height: number,
  padding = 0.06,
): Projection {
  const [minLng, minLat, maxLng, maxLat] = bounds;

  // Longitude compression factor at the center latitude.
  const centerLat = (minLat + maxLat) / 2;
  const k = Math.cos((centerLat * Math.PI) / 180) || 1;

  // Projected-space extents (px = lng * k, py = lat).
  const pMinX = minLng * k;
  const pMaxX = maxLng * k;
  const pW = pMaxX - pMinX || 1e-9;
  const pH = maxLat - minLat || 1e-9;

  const availW = width * (1 - 2 * padding);
  const availH = height * (1 - 2 * padding);
  const scale = Math.min(availW / pW, availH / pH);

  // Center the projected content in the viewport.
  const offsetX = (width - pW * scale) / 2;
  const offsetY = (height - pH * scale) / 2;

  return {
    width,
    height,
    toSVG([lng, lat]: Coordinate): [number, number] {
      const x = offsetX + (lng * k - pMinX) * scale;
      // Flip Y: geographic north (max lat) is at the top (small y).
      const y = height - (offsetY + (lat - minLat) * scale);
      return [x, y];
    },
  };
}

/** Compute the bounding box covering all coordinates in the given polylines. */
export function computeBounds(lines: { points: Coordinate[] }[]): BoundingBox | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const line of lines) {
    for (const [lng, lat] of line.points) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }

  if (!isFinite(minLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

/** Expand a bounding box by a fractional margin on every side. */
export function padBounds(bounds: BoundingBox, margin: number): BoundingBox {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const dx = (maxLng - minLng) * margin;
  const dy = (maxLat - minLat) * margin;
  return [minLng - dx, minLat - dy, maxLng + dx, maxLat + dy];
}
