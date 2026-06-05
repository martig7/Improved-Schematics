/** Decoded `ocean_depth_index.json` structure (the `.gz` once gunzipped). */
export interface OceanIndex {
  cs: number;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  /** [W, H] grid dimensions in cells. */
  grid: [number, number];
  /** Sparse water cells: each [col, row, ...depthIndices]; trailing ints ignored. */
  cells: number[][];
  depths?: unknown[];
  stats?: unknown;
}
