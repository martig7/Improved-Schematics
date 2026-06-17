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
  // Quantize the ONE transcendental in the projection: cos is not correctly-
  // rounded across V8 builds, and this single scalar multiplies into every
  // projected x (toSVG below), so a 1-ULP cross-engine diff in it perturbs all
  // coordinates and the chaotic octi search amplifies it into a different
  // layout. Rounding to 1e-9 (far sub-pixel at 2700px) makes k — and thus the
  // whole projected coordinate field — bit-identical on every engine.
  const k = (Math.round(Math.cos((centerLat * Math.PI) / 180) * 1e9) / 1e9) || 1;

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

/** An axis-aligned rectangle in SVG pixel space. */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pixel-space bounding rect of an arbitrary set of geographic coords projected
 * through `proj`, clamped to the viewport. Returns null when `coords` is empty.
 *
 * Unlike `frameRect` (which projects only a bbox's 4 corners and so assumes an
 * axis-aligned projection), this projects EVERY point — correct under the
 * smoothed mode's non-axis-aligned density-warp projection, where the furthest
 * pixel can come from a non-corner vertex.
 */
export function projectedBounds(proj: Projection, coords: Coordinate[]): FrameRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    const [x, y] = proj.toSVG(c);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  // Clamp to the canvas so the frame never reaches outside the drawn SVG.
  minX = Math.max(0, minX);
  minY = Math.max(0, minY);
  maxX = Math.min(proj.width, maxX);
  maxY = Math.min(proj.height, maxY);
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * Project a geographic bbox through `proj` into an axis-aligned pixel rect,
 * clamped to the projection's viewport. This is the projected bbox WITHOUT the
 * projection's padding margin — used to frame fit-to-view and SVG export on a
 * specific extent (e.g. the demand bbox) rather than the whole padded canvas.
 */
export function frameRect(proj: Projection, bbox: BoundingBox): FrameRect {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return (
    projectedBounds(proj, [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
    ]) ?? { x: 0, y: 0, w: 0, h: 0 }
  );
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
