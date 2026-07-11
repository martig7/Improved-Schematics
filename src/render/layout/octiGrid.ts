// LOOM octi base grid geometry for the smoothed-view diagnostic overlay: a
// square grid of base nodes plus octilinear base-to-base adjacency. The real
// routing model (ports, sinks, bends, weights, A* over the extended grid) lives
// in gridGraph.ts; this builder carries only the node centres and neighbour
// links the overlay draws.
// Reference: Brosi & Bast 2024, §"Map Schematization".

import type { Pixel } from './types';

/** Grid-cell offset (col,row) per octilinear direction index, +row = up. */
const OFFSET: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

export interface OctiBaseNode {
  id: string;       // `b${col}_${row}`
  col: number;
  row: number;
  pos: Pixel;       // centre
}

/** Undirected octilinear adjacency between two base-node centres. */
export interface OctiGridEdge {
  from: string;     // base node id
  to: string;       // base node id
}

export interface OctiGrid {
  baseNodes: OctiBaseNode[];
  /** base node id -> base node. */
  baseById: Map<string, OctiBaseNode>;
  /** each octilinear base pair once (from the lower base id). */
  edges: OctiGridEdge[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function buildOctiGrid(bounds: Bounds, cellSize: number, padCells = 2): OctiGrid {
  const cols0 = Math.floor(bounds.minX / cellSize) - padCells;
  const cols1 = Math.ceil(bounds.maxX / cellSize) + padCells;
  const rows0 = Math.floor(bounds.minY / cellSize) - padCells;
  const rows1 = Math.ceil(bounds.maxY / cellSize) + padCells;

  const baseNodes: OctiBaseNode[] = [];
  const baseById = new Map<string, OctiBaseNode>();
  const baseAt = new Map<string, OctiBaseNode>(); // "col,row" -> base

  for (let col = cols0; col <= cols1; col++) {
    for (let row = rows0; row <= rows1; row++) {
      const id = 'b' + col + '_' + row;
      const node: OctiBaseNode = { id, col, row, pos: [col * cellSize, row * cellSize] };
      baseNodes.push(node);
      baseById.set(id, node);
      baseAt.set(col + ',' + row, node);
    }
  }

  const edges: OctiGridEdge[] = [];
  for (const node of baseNodes) {
    for (let d = 0; d < 8; d++) {
      const [ox, oy] = OFFSET[d];
      const nbr = baseAt.get(node.col + ox + ',' + (node.row + oy));
      if (!nbr) continue;
      // Emit each undirected pair once (from the lower base id).
      if (node.id < nbr.id) edges.push({ from: node.id, to: nbr.id });
    }
  }

  return { baseNodes, baseById, edges };
}
