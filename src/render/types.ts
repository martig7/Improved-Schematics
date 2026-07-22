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
  /** Neighborhood-label size multiplier on the base area-label font. Normalized
   *  across modes (the base is in base-2700 units, rescaled per canvas), so one
   *  value looks the same geographic and smoothed. Draw-time only. Default 1. */
  neighborhoodFontScale?: number;
  /** Virtual zoom for area labels: shows the tiers the basemap shows at that zoom
   *  (its per-tier zoom bands). Lower = fewer, bigger areas. Draw-time only. */
  neighborhoodZoom?: number;
  /** Area-label collision padding in the basemap's textPadding units; larger
   *  spaces labels further apart (stronger declutter). Draw-time only. */
  neighborhoodPad?: number;
  /** Which station design (marker style) to draw. Resolved via
   *  render/stationDesigns.ts getStationDesign; unknown/undefined → Classic.
   *  Draw-time only — never changes the layout and is excluded from the cache
   *  fingerprint. Smoothed/topo modes only for now. */
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
  /** Drawn line/marker chrome scale (the Line-size control), ≥0, default 1.
   *  Multiplies LINE_WIDTH / LINE_GAP / MARK_R0 and everything derived (stroke
   *  widths, station dots, casings, capsule geometry, marker seating), so the
   *  whole schematic's ink thins or thickens together. Smaller = thinner lines
   *  and smaller markers, which declutters a dense core at any zoom. Baked:
   *  marker sizes feed the seating solver, so this is part of the layout and the
   *  cache fingerprint. */
  lineScale?: number;
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
  /** Smoothed mode only: PERCENTAGE-of-maximum-warp mode (0–1). When set, the
   *  box warp is granted as this linear fraction of the map's full measured
   *  demand (survival plus full aesthetics): 0 = identity, 1 = the whole
   *  demanded warp, and boxGrowth's fixed cap is bypassed (boxExpand still
   *  sets the aesthetic ceiling inside the maximum). Absent = legacy cap
   *  semantics, so saved maps replay unchanged. */
  boxPct?: number;
  /** Smoothed mode only: DECLUTTER warp grant, 0–1 (default 0). Un-pinches
   *  genuinely overlapping stations (the contraction pinch-relief and
   *  capsule-pair survival oracles) so a dense core is renderable. Maps to a
   *  GENTLE per-axis canvas-growth cap (0 = identity, 1 = the two-dial ceiling,
   *  a mild un-pinch — NOT the full ~5x solved contraction saturation), so it
   *  reads as a taste dial and the draw handles whatever pinches remain. Gates
   *  the contraction and capsule oracles on > 0. Supersedes boxPct when set.
   *  Bakes into the layout (fingerprint). */
  declutterWarp?: number;
  /** Smoothed mode only: AESTHETIC warp grant, 0–1 (default 0). Density-emphasis
   *  magnification (steepest-ascent watershed) giving crowded cores extra room
   *  for emphasis. Maps to the same gentle per-axis growth cap as declutter
   *  (0 = off, 1 = the two-dial ceiling), kept mild so magnifying an off-center
   *  core does not visibly shove the surrounding field. Gates the density oracle
   *  on > 0. Supersedes boxPct when set. Bakes into the layout (fingerprint). */
  aestheticWarp?: number;
  /** Smoothed mode only: CROP aspect ratio numerator/denominator (the two W:H
   *  boxes). Used with cropBbox to shape the sub-canvas: the longer side keeps
   *  the base canvas size and the shorter side is derived from this ratio, so a
   *  cropped region magnifies to fill the canvas. Only meaningful when cropBbox
   *  is set. Bakes into the layout (fingerprint). */
  cropAspectW?: number;
  cropAspectH?: number;
  /** Smoothed mode only: CROP region as a GEOGRAPHIC bbox [lng0, lat0, lng1, lat1].
   *  When set, the layout is recomputed on just the sub-network inside this box
   *  (plus a one-stop ring), reframed and magnified into the aspect-shaped canvas
   *  so the region gets more room. Absent = no crop (the full square). Stored in
   *  geographic space so it survives layout changes; the panel converts to/from
   *  pixels via the projection. Bakes into the layout (fingerprint). */
  cropBbox?: [number, number, number, number];
  /** Smoothed mode only (BETA): build one graph node per member STATION of a
   *  multi-station complex (platforms at their real coordinates) instead of one
   *  node per station group. Parallel trunks through a complex stay
   *  distinct corridors, and the capsule placer joins the platforms back into
   *  one marker via stopNodes. Off (default) keeps the classic group-center
   *  nodes. Bakes into the layout, so it's in the cache fingerprint and toggling
   *  regenerates. Default false. */
  stationSplit?: boolean;
  /** Landmass style for the geography backdrop (smoothed mode). Draw-time only.
   *  Never changes the layout, is excluded from the cache fingerprint, and
   *  toggling it just repaints. 'faithful' (default) draws the
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
  mode: 'geographic',
  dark: false,
  theme: DEFAULT_THEME,
};
