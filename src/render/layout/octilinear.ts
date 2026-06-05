// Octilinear grid layout: snap station-group nodes onto a grid, then route edges
// as octilinear paths. Ported from the game (dev/reference/snapStations.js,
// findFreeCell.js, orderEdgesByImportance.js, rebuildLayoutFromCells.js,
// octilinearLayout.js).

import type { TransitGraph, GraphEdge, Layout, LayoutNode, LayoutEdge, Cell } from './types';
import { STEP_SIZE } from '../constants';
import { cellKey, cellKeyOf, edgeKey, routeEdge } from './grid';

/** Find `want`, else the nearest unused cell by expanding ring search. */
export function findFreeCell(want: Cell, nodeId: string, used: Map<string, string>): Cell {
  const wantKey = cellKeyOf(want);
  if (!used.has(wantKey)) {
    used.set(wantKey, nodeId);
    return want;
  }
  for (let ring = 1; ring < 100; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cell: Cell = [want[0] + dx, want[1] + dy];
        const k = cellKeyOf(cell);
        if (!used.has(k)) {
          used.set(k, nodeId);
          return cell;
        }
      }
    }
  }
  used.set(wantKey, nodeId);
  return want;
}

/** Order edges most-important first: more lines, then longer geographic span. */
export function orderEdgesByImportance(graph: TransitGraph): GraphEdge[] {
  return [...graph.edges].sort((a, b) => {
    const d = b.lines.length - a.lines.length;
    if (d !== 0) return d;
    const af = graph.nodes.get(a.from)!;
    const at = graph.nodes.get(a.to)!;
    const bf = graph.nodes.get(b.from)!;
    const bt = graph.nodes.get(b.to)!;
    return (
      Math.hypot(af.pos[0] - at.pos[0], af.pos[1] - at.pos[1]) -
      Math.hypot(bf.pos[0] - bt.pos[0], bf.pos[1] - bt.pos[1])
    );
  });
}

/** Assign each node a unique integer grid cell from its projected position. */
export function snapStations(graph: TransitGraph): Map<string, Cell> {
  const result = new Map<string, Cell>();
  if (graph.nodes.size === 0) return result;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes.values()) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
  }

  const lengths: number[] = [];
  for (const e of graph.edges) {
    const a = graph.nodes.get(e.from)!.pos;
    const b = graph.nodes.get(e.to)!.pos;
    lengths.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  lengths.sort((p, q) => p - q);
  const median = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 1;
  const cellSize = Math.max(1, median / STEP_SIZE);

  const wanted = new Map<string, Cell>();
  for (const [id, n] of graph.nodes) {
    wanted.set(id, [
      Math.round((n.pos[0] - minX) / cellSize),
      Math.round((n.pos[1] - minY) / cellSize),
    ]);
  }

  // Place higher-degree nodes first (they anchor the layout); tiebreak by id.
  const order = [...graph.nodes.keys()].sort((a, b) => {
    const da = graph.adj.get(a)?.length ?? 0;
    const db = graph.adj.get(b)?.length ?? 0;
    if (db !== da) return db - da;
    return a.localeCompare(b);
  });

  const used = new Map<string, string>();
  for (const id of order) {
    result.set(id, findFreeCell(wanted.get(id)!, id, used));
  }
  return result;
}

/** Route every edge as an octilinear path between snapped node cells. */
export function rebuildLayoutFromCells(graph: TransitGraph, cells: Map<string, Cell>): Layout {
  const occupied = new Set<string>();
  for (const cell of cells.values()) occupied.add(cellKey(cell));

  const nodes = new Map<string, LayoutNode>();
  for (const [id, cell] of cells) {
    const gn = graph.nodes.get(id)!;
    nodes.set(id, { id, cell, label: gn.label, lngLat: gn.lngLat });
  }

  const sharedSegs = new Map<string, Set<string>>();
  const edges: LayoutEdge[] = [];
  for (const edge of orderEdgesByImportance(graph)) {
    const fromCell = cells.get(edge.from)!;
    const toCell = cells.get(edge.to)!;
    const lineIds = new Set(edge.lines.map((l) => l.id));
    const path = routeEdge(fromCell, toCell, lineIds, occupied, sharedSegs);
    for (let i = 0; i < path.length - 1; i++) {
      const k = edgeKey(path[i], path[i + 1]);
      let seg = sharedSegs.get(k);
      if (!seg) {
        seg = new Set();
        sharedSegs.set(k, seg);
      }
      for (const id of lineIds) seg.add(id);
    }
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      path,
      lines: edge.lines,
      lineOrder: edge.lines.map((l) => l.id),
      stops: edge.stops,
    });
  }

  return { cellSize: STEP_SIZE, nodes, edges, lineTraversals: graph.lineTraversals };
}

export function octilinearLayout(graph: TransitGraph): Layout {
  return rebuildLayoutFromCells(graph, snapStations(graph));
}
