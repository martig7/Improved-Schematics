// Build a boolean water mask from the sparse `cells` list, plus a corner→geo
// mapper. Row 0 = south (verified: the Atlantic-south band holds far more water
// cells than the north), so latitude increases with row.

import type { OceanIndex } from './types';

export interface WaterGrid {
  /** length W*H, 1 = water; index r*W + c */
  mask: Uint8Array;
  W: number;
  H: number;
  /** Map a grid corner (cx∈[0,W], cy∈[0,H]) to [lng, lat]. */
  cornerToGeo(cx: number, cy: number): [number, number];
}

export function buildWaterMask(index: OceanIndex): WaterGrid {
  const [W, H] = index.grid;
  const [minLng, minLat, maxLng, maxLat] = index.bbox;
  const mask = new Uint8Array(W * H);
  for (const cell of index.cells) {
    const c = cell[0];
    const r = cell[1];
    if (c >= 0 && c < W && r >= 0 && r < H) mask[r * W + c] = 1;
  }
  const cornerToGeo = (cx: number, cy: number): [number, number] => [
    minLng + (cx / W) * (maxLng - minLng),
    minLat + (cy / H) * (maxLat - minLat),
  ];
  return { mask, W, H, cornerToGeo };
}
