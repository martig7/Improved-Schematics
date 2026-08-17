// Shared graph/layout types for the octilinear schematic engine.
// Framework-free so the dev harness can exercise them without the game.

import type { Coordinate } from '../../types/core';

export type Cell = [number, number];   // grid coordinates (col, row)
export type Pixel = [number, number];  // projected meters/pixels

/** Interchange node input to buildTransitGraph (grouped stations). */
export interface StationGroup {
  id: string;            // trackGroupId
  name: string;
  center: Coordinate;    // [lng, lat]
  stationIds: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  pos: Pixel;
  lngLat: Coordinate;
}

export interface LineRef {
  id: string;
  label: string;
  color: string;
  /** Route text color (hex) for the bullet, when the game provides one. Used by
   *  the 'solid' dot style; falls back to an auto-contrast ink when absent. */
  textColor?: string;
}

export interface EdgeStop {
  atFrom: boolean;
  atTo: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  lines: LineRef[];
  stops: Map<string, EdgeStop>; // lineId -> stop flags
  /** Geographic polyline (unprojected) from `from` to `to`, following the real
   *  track course between the two station groups. Present only when
   *  buildTransitGraph is given the track set; absent edges render straight. */
  geo?: Coordinate[];
}

export interface TraversalStep {
  edgeId: string;
  reversed: boolean;
}

export interface TransitGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  adj: Map<string, string[]>; // nodeId -> edgeIds
  lineTraversals: Map<string, TraversalStep[]>; // lineId -> ordered edge steps
  /** Per (lineId|groupId): the 1-based station number along the line, from the
   *  raw route stop order at intake. */
  numberByGroup: Map<string, number>;
  /** route id -> the id of the LINE it is drawn as. Routes sharing a bullet and
   *  an edge set collapse onto one drawn line, so this is not the identity. Lets
   *  a per-route display setting name the line it actually affects. OPTIONAL:
   *  absent in graphs built before the field existed; callers then treat each
   *  route as its own line. */
  canonLineId?: Map<string, string>;
}

export interface LayoutNode {
  id: string;
  cell: Cell;
  label: string;
  lngLat: Coordinate;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  path: Cell[]; // octilinear grid path
  lines: LineRef[];
  lineOrder: string[]; // ordered line ids (mutated by orderLines)
  stops: Map<string, EdgeStop>;
}

export interface Layout {
  cellSize: number;
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  lineTraversals: Map<string, TraversalStep[]>;
  /** Per (lineId|nodeId): the station number to render at that node, resolved
   *  from the intake numbers via the support graph's per-group stop-node map. */
  nodeSeq?: Map<string, number>;
  /** route id -> the id of the LINE it is drawn as (carried over from the
   *  transit graph). Lets a per-route display setting name the line it actually
   *  affects. OPTIONAL: absent on layouts built before the field existed;
   *  callers then treat each route as its own line. */
  canonLineId?: Map<string, string>;
}

/** Walk result element from walkRouteVisits. */
export interface Visit {
  groupId: string;
  isStop: boolean;
  /** Service break: the leg AFTER this visit was suppressed (loop-closure
   *  deadhead). No edge may be painted between this visit and the next. */
  breakAfter?: boolean;
}

/** A placed stop marker for a line at a node (used by renderStops/placeLabels). */
export interface StopMark {
  lineId: string;
  color: string;
  /** Support node where this line's stop is flagged. It can differ from the
   *  station group's marker node after platform splitting or rehoming. */
  flagNode?: string;
  /** Route text color (hex) for the bullet, when the game provides one. Used by
   *  the 'solid' dot style; falls back to auto-contrast ink when absent. */
  textColor?: string;
  /** Station number: 1-based index of this stop along its line, when derivable.
   *  Used by the numbered ("Tokyu") design. */
  seq?: number;
  pos: Pixel;
  /** Line display name (route bullet) printed inside the stop dot. */
  name?: string;
  /** Chain position within the station's marker (dots-on-lanes model):
   *  dots sorted by this index form the capsule spine. */
  chain?: number;
  /** Rigid-row model (spec v2): synthetic corner vertex between this mark
   *  and the next in chain order. A pair boundary's derived elbow point. */
  cornerAfter?: Pixel;
  /** Rect seating inputs (design-agnostic, recorded in computeRibbonGeometry for
   *  interchange marks): the pre-solve lane position ("home", where the line passes
   *  the node) and its octilinear run-axis index (0=–, 1=/, 2=|, 3=\). Consumed by
   *  the rectangle ("Tokyu") capsule seating at paint time. */
  home?: Pixel;
  axis?: number;
  /** Exact unit tangent of the line at this stop (unquantized run direction).
   *  Consumed by tick-style station markers to strike strictly perpendicular to
   *  the line, where the octilinear `axis` would be off on a curved approach. */
  dir?: Pixel;
  /** The line ends at this stop (a single drawn lane is incident). A loop has
   *  two lanes at every stop, so none are termini. Tick markers cap it fully. */
  terminus?: boolean;
  /** Seat-ink occlusion depth (px) the seat solve recorded at commit: how
   *  deeply a higher-painted foreign strand covered this line at the chosen
   *  dot (0 = the mark sat on visible own ink). Consumed by the fanzone
   *  census to split intrusions into avoidable vs solver-certified. OPTIONAL:
   *  geometry serialized before it existed deserializes without it. */
  seatDirt?: number;
  /** Unit vector from the bundle's drawn centerline toward this line's lane, so
   *  a one-sided tick marker strikes toward the bundle's outer edge (away from
   *  the co-running lanes). Absent for a lane centered on its bundle (no side)
   *  or one that runs alone. */
  outward?: Pixel;
  /** Unit vector pointing OFF THE END of a terminus, away from the track the line
   *  arrives on, read from the drawn lane. `dir` cannot serve: a tangent is only
   *  defined up to sign, so it says which way the run lies but not which end this
   *  is. Set only on terminus marks, and only where the drawn lane is long enough
   *  to read a direction from. */
  end?: Pixel;
}

// ---- LOOM topo: support graph -------------------------------------------

/** A node in the support graph H. Pure geometry; identity by id. */
export interface SupportNode {
  id: string;
  pos: Pixel;
}

/** A merged corridor edge in H. `points[0]` is from.pos, `points.at(-1)` is
 *  to.pos; intermediate points carry the corridor's bend geometry. */
export interface SupportEdge {
  id: string;
  from: string;
  to: string;
  points: Pixel[];
  lineIds: Set<string>;
}

/** A station placed onto the support graph by insertStations. */
export interface SupportStation {
  id: string;        // station-group id
  label: string;
  lngLat: Coordinate;
  nodeId: string;    // support node it was placed at
  /** True (warped, projected) pixel position of the group center. */
  truePos?: Pixel;
  /** Lines that stop at this group (for per-group marker separation). */
  stopLines?: Set<string>;
  /** Member stations in the group: > 1 renders as an interchange capsule,
   *  1 renders as a dot. */
  members?: number;
  /** Per line: the support node carrying this line's stop flag. Lines through
   *  one station can ride diverged corridors, so flags re-home per line. */
  stopNodes?: Map<string, string>;
}

/** Output of topo: corridors as single edges + stations re-inserted. */
export interface SupportGraph {
  nodes: Map<string, SupportNode>;
  edges: Map<string, SupportEdge>;
  adj: Map<string, string[]>;                    // nodeId -> edgeIds
  lineRefs: Map<string, LineRef>;                // lineId -> color/label
  lineTraversals: Map<string, TraversalStep[]>;  // lines over support edges
  stations: Map<string, SupportStation>;         // stationGroupId -> placement
  /** Per (lineId|supportNodeId): the line stops at that node. */
  stopAt: Set<string>;
}

// ---- LOOM octi: schematized image ---------------------------------------

/** Result of octi: each support node mapped to a grid pixel, each support
 *  edge mapped to an octilinear pixel polyline. */
export interface Image {
  /** supportNodeId -> placed grid pixel. */
  placement: Map<string, Pixel>;
  /** supportEdgeId -> routed octilinear pixel polyline. */
  paths: Map<string, Pixel[]>;
  /** The base grid cell size actually used (after any stalling shrink). */
  cellSize: number;
}
