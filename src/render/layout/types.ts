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
  /** Per-segment line ordering (spec 2026-06-13): lateral order at the `from`
   *  endpoint. Undefined means "same as lineOrder" (no internal crossings). */
  orderFrom?: string[];
  /** Lateral order at the `to` endpoint. Undefined means "same as lineOrder". */
  orderTo?: string[];
  stops: Map<string, EdgeStop>;
}

export interface Layout {
  cellSize: number;
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  lineTraversals: Map<string, TraversalStep[]>;
  /** Nodes the planarity pass could not make crossing-free; rendered as the
   *  mega box (spec 2026-06-13 §5). Populated by assignEndpointOrders. */
  nonPlanarNodes?: Set<string>;
}

/** Walk result element from walkRouteVisits. */
export interface Visit {
  groupId: string;
  isStop: boolean;
  /** Service break: the leg AFTER this visit was suppressed (loop-closure
   *  deadhead) — no edge may be painted between this visit and the next. */
  breakAfter?: boolean;
}

/** A placed stop marker for a line at a node (used by renderStops/placeLabels). */
export interface StopMark {
  lineId: string;
  color: string;
  pos: Pixel;
  /** Line display name (route bullet) printed inside the stop dot. */
  name?: string;
  /** Chain position within the station's marker (dots-on-lanes model):
   *  dots sorted by this index form the capsule spine. */
  chain?: number;
  /** Rigid-row model (spec v2): synthetic corner vertex between this mark
   *  and the next in chain order — a pair boundary's derived elbow point. */
  cornerAfter?: Pixel;
  /** Rigid-row total fallback (spec v2 §3): no feasible row configuration —
   *  the station renders as the mega box instead of a spine capsule. */
  mega?: boolean;
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
   *  1 renders as a dot (the user-set capsule rule). */
  members?: number;
  /** Per line: the support node carrying this line's stop flag (lines through
   *  one station can ride diverged corridors — flags re-home per line). */
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
