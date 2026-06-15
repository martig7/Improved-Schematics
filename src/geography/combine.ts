import type { Coordinate } from '../types/core';
import type { GeoPolyFeature } from './types';
import { featuresBbox } from './bbox';
import { traceRings } from '../water/marchingSquares';
import type { WaterGrid } from '../water/grid';

export interface CombineOptions {
  /** Bridge gap in meters: parks separated by ≤ this distance merge into one. */
  gapM: number;
  /** Cap on grid cells per axis (bounds the rasterization work). Default 1200. */
  maxGrid?: number;
}

/**
 * Combine extremely-close park fragments into single polygons via a raster
 * morphological close: rasterize each park's exterior into a boolean grid, dilate
 * then erode by k cells (which bridges gaps ≤ ~2k cells while leaving isolated
 * parks unchanged and filling small holes), then re-trace the merged outlines
 * back to [lng,lat]. Meant to run BEFORE the size filter so merged parks survive.
 */
export function combineCloseParks(features: GeoPolyFeature[], opts: CombineOptions): GeoPolyFeature[] {
  if (features.length === 0 || opts.gapM <= 0) return features;
  const bbox = featuresBbox(features);
  if (!bbox) return features;

  const [minLng, minLat, maxLng, maxLat] = bbox;
  const dLng = maxLng - minLng || 1e-9;
  const dLat = maxLat - minLat || 1e-9;
  const centerLat = (minLat + maxLat) / 2;
  const mPerLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const mPerLat = 111_320;
  const spanXm = dLng * mPerLng;
  const spanYm = dLat * mPerLat;
  const maxGrid = opts.maxGrid ?? 1200;
  const cellM = Math.max(opts.gapM / 4, Math.max(spanXm, spanYm) / maxGrid, 1);
  const W = Math.max(1, Math.ceil(spanXm / cellM));
  const H = Math.max(1, Math.ceil(spanYm / cellM));
  const k = Math.max(1, Math.ceil(opts.gapM / (2 * cellM)));

  const col = (lng: number): number => ((lng - minLng) / dLng) * W;
  const row = (lat: number): number => ((lat - minLat) / dLat) * H;
  const mask = new Uint8Array(W * H);
  for (const f of features) rasterizeRing(f.geometry.coordinates[0], mask, W, H, col, row);

  const closed = erode(dilate(mask, W, H, k), W, H, k);

  const cornerToGeo = (cx: number, cy: number): Coordinate => [minLng + (cx / W) * dLng, minLat + (cy / H) * dLat];
  const grid: WaterGrid = { mask: closed, W, H, cornerToGeo };
  return traceRings(grid).map((ring) => ({
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: [ring.map(([cx, cy]) => cornerToGeo(cx, cy))] },
  }));
}

/** Even-odd scanline fill of a polygon ring (exterior only) into the mask. */
function rasterizeRing(
  ring: Coordinate[],
  mask: Uint8Array,
  W: number,
  H: number,
  col: (lng: number) => number,
  row: (lat: number) => number,
): void {
  const n = ring.length;
  if (n < 3) return;
  const xs: number[] = new Array(n);
  const ys: number[] = new Array(n);
  let minR = Infinity;
  let maxR = -Infinity;
  for (let i = 0; i < n; i++) {
    xs[i] = col(ring[i][0]);
    ys[i] = row(ring[i][1]);
    if (ys[i] < minR) minR = ys[i];
    if (ys[i] > maxR) maxR = ys[i];
  }
  const r0 = Math.max(0, Math.floor(minR));
  const r1 = Math.min(H - 1, Math.ceil(maxR));
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5;
    const xints: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ys[i];
      const yj = ys[j];
      if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) {
        xints.push(xs[i] + ((yc - yi) / (yj - yi)) * (xs[j] - xs[i]));
      }
    }
    xints.sort((a, b) => a - b);
    for (let s = 0; s + 1 < xints.length; s += 2) {
      const cA = Math.max(0, Math.ceil(xints[s] - 0.5));
      const cB = Math.min(W - 1, Math.floor(xints[s + 1] - 0.5));
      for (let c = cA; c <= cB; c++) mask[r * W + c] = 1;
    }
  }
}

/** Box dilation by k (Chebyshev): stamp each set cell's (2k+1)² neighborhood. */
function dilate(mask: Uint8Array, W: number, H: number, k: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!mask[r * W + c]) continue;
      const r0 = Math.max(0, r - k);
      const r1 = Math.min(H - 1, r + k);
      const c0 = Math.max(0, c - k);
      const c1 = Math.min(W - 1, c + k);
      for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) out[rr * W + cc] = 1;
    }
  }
  return out;
}

/** Box erosion by k (Chebyshev): keep a set cell only if its full (2k+1)²
 *  neighborhood is set (out-of-bounds counts as unset, so borders erode). */
function erode(mask: Uint8Array, W: number, H: number, k: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!mask[r * W + c]) continue;
      if (r - k < 0 || r + k >= H || c - k < 0 || c + k >= W) continue;
      let all = true;
      for (let rr = r - k; rr <= r + k && all; rr++) {
        for (let cc = c - k; cc <= c + k; cc++) {
          if (!mask[rr * W + cc]) {
            all = false;
            break;
          }
        }
      }
      if (all) out[r * W + c] = 1;
    }
  }
  return out;
}
