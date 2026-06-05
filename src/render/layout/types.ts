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
  stops: Map<string, EdgeStop>;
}

export interface Layout {
  cellSize: number;
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  lineTraversals: Map<string, TraversalStep[]>;
}

/** Walk result element from walkRouteVisits. */
export interface Visit {
  groupId: string;
  isStop: boolean;
}

/** A placed stop marker for a line at a node (used by renderStops/placeLabels). */
export interface StopMark {
  lineId: string;
  color: string;
  pos: Pixel;
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
