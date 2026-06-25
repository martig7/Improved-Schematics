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

/** GeoJSON water input — Polygon features whose first ring is the exterior and the rest are holes. */
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
export type RenderMode = 'geographic' | 'smoothed' | 'schematic';

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
  /** Diagnostic: overlay the Hanan routing grid underneath the routes
   *  (Smoothed mode only — that's the only renderer that uses one). */
  showGrid?: boolean;
  /** When true, geographic + smoothed modes run the LOOM topo merge so
   *  parallel corridors bundle in the graph. Default off until tuned. */
  useTopoMerge?: boolean;
  /** Which render mode to use. Defaults to 'geographic'. */
  mode: RenderMode;
  /** Smoothed mode only: density-warp strength (LOOM warp alpha). 0 disables
   *  the warp (geography stays faithful); higher magnifies dense cores more.
   *  Default 0.8. Ignored by the geographic/schematic renderers. */
  warpAlpha?: number;
  /** Smoothed mode only: how strongly octi keeps each line on its true
   *  geographic course (LOOM geographic-affinity / enfGeoPen). Higher = more
   *  realistic courses; 0 = freely octilinear. Default 0.05. */
  geographicAffinity?: number;
  /** Smoothed mode only: box-warp strength — the LOCAL dense-core expansion
   *  factor (densityBoxWarp `expand`, ≥1). Higher gives crowded interchanges more
   *  rectilinear room (declutters dense hubs) at the cost of geographic
   *  faithfulness near them. Default 4. Pairs with boxGrowth (below) so the
   *  expanded cores grow the map rather than compress the surround. */
  boxExpand?: number;
  /** Smoothed mode only: how much the box warp may grow the overall map (≥1; the
   *  densityBoxWarp `growthCap`). Raised alongside boxExpand so stronger core
   *  expansion adds room instead of crushing the far field. Default 1.2. */
  boxGrowth?: number;
  /** Smoothed mode only: the box-warp density CUTOFF (densityBoxWarp `frac`, 0–1) —
   *  a cell counts as "dense" (and joins a warp box) when its smoothed density is at
   *  least this fraction of the peak. Lower = looser cutoff → more/larger boxes
   *  (broader warping); higher = only the densest cores → fewer/smaller boxes.
   *  Default 0.4. */
  boxFrac?: number;
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
  stationRadius: 2.5,
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
  mode: 'geographic',
  dark: false,
  theme: DEFAULT_THEME,
};
