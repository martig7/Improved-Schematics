/**
 * Shared types for the schematic renderer.
 * Kept framework-free so they can be used both in-game and in the dev harness.
 */

import type { Coordinate, BoundingBox } from '../types/core';

/** A single route reduced to a geographic polyline ready for projection. */
export interface RouteLine {
  routeId: string;
  /** Sanitized hex color. */
  color: string;
  bullet?: string;
  /** Ordered geographic coordinates [lng, lat] along the route. */
  points: Coordinate[];
}

/** A station reduced to a labelled point. */
export interface StationPoint {
  id: string;
  name: string;
  coords: Coordinate;
}

/** GeoJSON water input. Polygon features whose first ring is the exterior and the rest are holes. */
export interface WaterFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: {
    type: 'Polygon';
    coordinates: Coordinate[][];
  };
}

export interface WaterCollection {
  type: 'FeatureCollection';
  bbox?: BoundingBox;
  features: WaterFeature[];
}

/** Which layout/render mode the panel is showing. */
export type RenderMode = 'geographic' | 'smoothed';

/** Color and sizing options for a rendered schematic. */
export interface SchematicTheme {
  land: string;
  water: string;
  /** Parks / green-space fill. */
  green: string;
  stationFill: string;
  stationStroke: string;
  /** Route line width in SVG units. */
  lineWidth: number;
  /** Station marker radius in SVG units. */
  stationRadius: number;
}

export interface SchematicOptions {
  width: number;
  height: number;
  /** Fractional padding inside the viewport (0.05 = 5% on each side). */
  padding: number;
  /** Override the framing bounds; defaults to the transit network's bounds. */
  bounds?: BoundingBox;
  showStations: boolean;
  showLabels: boolean;
  /** Draw neighborhood-name area labels from the harvested geography places.
   *  Draw-time only (repaint, no relayout). Default false. */
  showNeighborhoods?: boolean;
  /** How to render the fallback marker for an over-dense bundle that can't seat
   *  octilinearly (a "megabox"). 'box' = the opaque rounded rectangle (default),
   *  'curve' = a soft squircle blob of the same footprint. Draw-time only. It
   *  does not change the layout, so it's excluded from the cache fingerprint and
   *  toggling it just repaints. Default 'box'. */
  megaFallback?: 'box' | 'curve';
  /** Which station design (marker style) to draw. Resolved via
   *  render/stationDesigns.ts getStationDesign; unknown/undefined → Classic.
   *  Draw-time only — like megaFallback it never changes the layout and is
   *  excluded from the cache fingerprint. Smoothed/topo modes only for now. */
  stationDesign?: string;
  /** Diagnostic: overlay the Hanan routing grid underneath the routes.
   *  Smoothed mode only, since that's the only renderer that uses one. */
  showGrid?: boolean;
  /** When true, geographic + smoothed modes run the LOOM topo merge so
   *  parallel corridors bundle in the graph. Default off. */
  useTopoMerge?: boolean;
  /** Which render mode to use. Defaults to 'geographic'. */
  mode: RenderMode;
  /** Smoothed mode only: density-warp strength (LOOM warp alpha). 0 disables
   *  the warp, keeping geography faithful. Higher magnifies dense cores more.
   *  Default 0.8. Ignored by the geographic renderer. */
  warpAlpha?: number;
  /** Smoothed mode only: how strongly octi keeps each line on its true
   *  geographic course (LOOM geographic-affinity / enfGeoPen). Higher gives more
   *  realistic courses; 0 is freely octilinear. Default 0.05. */
  geographicAffinity?: number;
  /** Smoothed mode only: box-warp strength, the demand MULTIPLIER on top of
   *  each dense box's survival need (densityBoxWarp `userMult`, ≥0). At 1 each
   *  box expands by exactly what its edges need to clear the octi contraction
   *  threshold and no more. Higher adds aesthetic magnification (more rectilinear
   *  room, decluttering dense hubs) at the cost of geographic faithfulness near
   *  them. The demand formula clamps at >= 1 internally, so values below 1 only
   *  soften the aesthetic headroom and never revoke survival room. Default 1.
   *  Pairs with boxGrowth (below) so the expanded cores grow the map rather
   *  than compress the surround. */
  boxExpand?: number;
  /** Smoothed mode only: the MAX per-axis canvas growth the box warp may use to
   *  absorb its demanded expansion (≥1; densityBoxWarp `maxGrowth`). Demand
   *  beyond this cap shrinks back globally instead of growing the canvas
   *  further. Raise alongside boxExpand so stronger core expansion adds room
   *  instead of crushing the far field. Default 2. */
  boxGrowth?: number;
  /** Smoothed mode only: the box-warp density CUTOFF (densityBoxWarp `frac`, 0–1).
   *  A cell counts as "dense" (and joins a warp box) when its smoothed density is at
   *  least this fraction of the peak. Lower is a looser cutoff, giving more/larger
   *  boxes (broader warping); higher keeps only the densest cores, giving
   *  fewer/smaller boxes. Default 0.4. */
  boxFrac?: number;
  /** Smoothed mode only (BETA): build one graph node per member STATION of a
   *  multi-station complex (platforms at their real coordinates) instead of one
   *  node per station group. Parallel trunks through a complex stay
   *  distinct corridors, and the capsule placer joins the platforms back into
   *  one marker via stopNodes. Off (default) keeps the classic group-center
   *  nodes. Bakes into the layout, so it's in the cache fingerprint and toggling
   *  regenerates. Default false. */
  stationSplit?: boolean;
  /** Landmass style for the geography backdrop (smoothed mode). Draw-time only.
   *  Like megaFallback it never changes the layout, is excluded from the cache
   *  fingerprint, and toggling it just repaints. 'faithful' (default) draws the
   *  raw projected polygons; 'rounded' culls small features, simplifies each
   *  coastline to few segments and rounds every corner into soft blobs;
   *  'diagram' additionally snaps edges to the octilinear grid for a
   *  straight-edged schematic look. */
  landmass?: 'faithful' | 'rounded' | 'diagram';
  /** Landmass simplification strength, 0..1 (0 = subtle, 1 = full diagram
   *  blobs). Scales the wiggle-erase tolerance, corner radius and the
   *  small-feature cull floor together. Default 0.5. */
  landmassDetail?: number;
  /** Detail-area sub-render (set by cropSubgraph, never on a main render). The
   *  cropped geography's bbox is the drawn box's geographic preimage, the
   *  region the popout must show. Treat its four corners as CONTENT in the
   *  post-warp re-fit so the whole drawn region stays on-canvas. Otherwise a
   *  box with empty margins (no water crossing, no stations) projects past the
   *  content-fitted canvas and geoBboxFrame gets clamped, so the popout then
   *  shows a truncated, wrong-aspect region. Not for main renders: the city
   *  bbox has slack past the real polygons and would shrink the content fit. */
  detailCrop?: boolean;
  /** Render with a dark background/palette. */
  dark: boolean;
  theme: SchematicTheme;
}

export const DEFAULT_THEME: SchematicTheme = {
  land: '#f2eadb',
  water: '#a8d4e6',
  green: '#cfe6c3',
  stationFill: '#ffffff',
  stationStroke: '#444444',
  lineWidth: 4,
  // Geographic-mode station dot radius (px). The smoothed renderer sizes its
  // markers from the line width and never reads this.
  stationRadius: 3,
};

/** Dark-theme palette: land is distinctly lighter than the panel so the map area reads. */
export const DARK_THEME: SchematicTheme = {
  ...DEFAULT_THEME,
  land: '#2a2d34',
  water: '#24506b',
  green: '#33503b',
  stationFill: '#1b1b1f',
  stationStroke: '#cccccc',
};

export const DEFAULT_OPTIONS: SchematicOptions = {
  width: 800,
  height: 800,
  padding: 0.06,
  showStations: true,
  showLabels: false,
  megaFallback: 'box',
  mode: 'geographic',
  dark: false,
  theme: DEFAULT_THEME,
};
