// LOOM octi: the extended octilinear grid Γ'. Base square grid; each base node
// expands into 8 port nodes (one per octilinear direction) joined to the centre
// by sink edges and to each other by bend edges; ports link to the opposite
// port of the neighbour in their direction via grid edges.
// Reference: Brosi & Bast 2024, §"Map Schematization".

import type { Pixel } from './types';

export const DIRECTIONS = {
  E: 0, NE: 1, N: 2, NW: 3, W: 4, SW: 5, S: 6, SE: 7,
} as const;

/** Grid-cell offset (col,row) per direction index, +row = up. */
const OFFSET: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

// Base bend penalty indexed by turn-step distance (1..4) between two port
// directions. A bend edge joins the port facing the incoming neighbour to the
// port facing the outgoing neighbour, so the *interior* path angle through the
// node is steps·45°: steps=4 (opposite ports) is a straight pass-through
// (180°, free) and steps=1 is the sharpest 45° turn (most penalised). steps=0
// (same port, a U-turn) cannot occur between two distinct ports.
// The A-correction (= BEND_BASE[1] - BEND_BASE[3]) is subtracted from every
// grid edge so the per-node bend correction does not double-count along a
// path. It must stay BELOW the minimum grid-edge weight (1.0 for axis) so the
// corrected grid edge cost is non-negative — Dijkstra requires it.
// Tuning: 45° turns are bumped relative to gentle turns so the router prefers
// a single long straight run over a stair of cheap small bends. 0.95 - 0.05 =
// 0.9 keeps A < 1.0 for safety.
const BEND_BASE = [Infinity, 0.95, 0.6, 0.05, 0];
/** No-shortcut correction a = w_45 − w_135 (Bast 2020); added to every bend and
 *  subtracted from every grid edge so a sharp turn is never cheaper as a chain
 *  of gentler turns, without distorting the edge-length penalty. */
const A = BEND_BASE[1] - BEND_BASE[3];

/** Turn-step distance (0..4) between two octilinear direction indices. */
export function turnSteps(d1: number, d2: number): number {
  const d = Math.abs(d1 - d2) % 8;
  return Math.min(d, 8 - d);
}

/** Corrected bend weight for a path turning by `steps` 45° increments at a node
 *  (steps=4 → straight/cheapest, steps=1 → 45° hairpin/most expensive). */
export function bendWeight(steps: number): number {
  return BEND_BASE[Math.min(steps, 4)] + A;
}

/** No-shortcut correction constant, exported for grid-edge balancing. */
export const BEND_CORRECTION = A;

export interface OctiPort {
  id: string;       // `${baseId}:p${dir}`
  base: string;
  dir: number;
  pos: Pixel;
}

export interface OctiBaseNode {
  id: string;       // `b${col}_${row}`
  col: number;
  row: number;
  pos: Pixel;       // centre
  ports: OctiPort[];
}

export type OctiEdgeKind = 'sink' | 'bend' | 'grid';

export interface OctiEdge {
  from: string;
  to: string;
  w: number;
  kind: OctiEdgeKind;
  base: string;     // owning base node (sink/bend); for grid, the source base
  dir: number;      // grid edge direction; -1 for sink/bend
}

export interface OctiGrid {
  cellSize: number;
  baseNodes: OctiBaseNode[];
  /** base centre node id -> base node. */
  baseById: Map<string, OctiBaseNode>;
  /** node id (centre or port) -> position. */
  pos: Map<string, Pixel>;
  /** undirected edge list (each grid/bend/sink edge appears once per direction
   *  pair as needed; callers build adjacency). */
  edges: OctiEdge[];
  /** adjacency: node id -> outgoing OctiEdge[] (both directions populated). */
  adj: Map<string, OctiEdge[]>;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const PORT_OFFSET = 0.01; // ports sit a hair off the centre, along their dir.

// Base sink-edge cost (centre <-> port). Must exceed the most expensive bend so
// that a path can never "dip" port→sink→centre→sink→port to turn for free
// (which would bypass all bend penalties and make axis staircases beat
// diagonals). A real route touches exactly two sinks — one at each endpoint —
// so this only adds a constant and does not affect routing choices. Per-endpoint
// displacement is applied separately via the Dijkstra source/target costs.
const SINK_BASE = 2.0;

export function buildOctiGrid(bounds: Bounds, cellSize: number, padCells = 2): OctiGrid {
  const cols0 = Math.floor(bounds.minX / cellSize) - padCells;
  const cols1 = Math.ceil(bounds.maxX / cellSize) + padCells;
  const rows0 = Math.floor(bounds.minY / cellSize) - padCells;
  const rows1 = Math.ceil(bounds.maxY / cellSize) + padCells;

  const baseNodes: OctiBaseNode[] = [];
  const baseById = new Map<string, OctiBaseNode>();
  const pos = new Map<string, Pixel>();
  const baseAt = new Map<string, OctiBaseNode>(); // "col,row" -> base

  for (let col = cols0; col <= cols1; col++) {
    for (let row = rows0; row <= rows1; row++) {
      const id = 'b' + col + '_' + row;
      const centre: Pixel = [col * cellSize, row * cellSize];
      const ports: OctiPort[] = [];
      for (let d = 0; d < 8; d++) {
        const [ox, oy] = OFFSET[d];
        const len = Math.hypot(ox, oy);
        const port: OctiPort = {
          id: id + ':p' + d,
          base: id,
          dir: d,
          pos: [centre[0] + (ox / len) * cellSize * PORT_OFFSET, centre[1] + (oy / len) * cellSize * PORT_OFFSET],
        };
        ports.push(port);
        pos.set(port.id, port.pos);
      }
      const node: OctiBaseNode = { id, col, row, pos: centre, ports };
      pos.set(id, centre);
      baseNodes.push(node);
      baseById.set(id, node);
      baseAt.set(col + ',' + row, node);
    }
  }

  const edges: OctiEdge[] = [];
  const adj = new Map<string, OctiEdge[]>();
  const link = (from: string, to: string, w: number, kind: OctiEdgeKind, base: string, dir: number) => {
    const e: OctiEdge = { from, to, w, kind, base, dir };
    const back: OctiEdge = { from: to, to: from, w, kind, base, dir };
    edges.push(e);
    (adj.get(from) ?? adj.set(from, []).get(from)!).push(e);
    (adj.get(to) ?? adj.set(to, []).get(to)!).push(back);
  };

  for (const node of baseNodes) {
    // Sink edges: centre <-> each port. Carry a fixed transit cost so the centre
    // is only ever a path endpoint, never a free pass-through turn.
    for (const p of node.ports) link(node.id, p.id, SINK_BASE, 'sink', node.id, -1);
    // Bend edges: every unordered port pair.
    for (let i = 0; i < node.ports.length; i++) {
      for (let j = i + 1; j < node.ports.length; j++) {
        const steps = turnSteps(node.ports[i].dir, node.ports[j].dir);
        link(node.ports[i].id, node.ports[j].id, bendWeight(steps), 'bend', node.id, -1);
      }
    }
    // Grid edges: port d <-> opposite port of neighbour in direction d.
    for (const p of node.ports) {
      const [ox, oy] = OFFSET[p.dir];
      const nbr = baseAt.get(node.col + ox + ',' + (node.row + oy));
      if (!nbr) continue;
      const opp = (p.dir + 4) % 8;
      const nbrPort = nbr.ports[opp];
      // Only emit each grid edge once (from the lower base id).
      if (node.id < nbr.id) {
        // Axis edge length 1.0, diagonal 1.5 (slightly favour H/V). Subtract the
        // no-shortcut correction so the per-node bend `+A` doesn't accumulate
        // into a length-dependent penalty (which would bias toward short paths
        // and cluster stations). Stays ≥ 0 because A < 1.0.
        const w = (p.dir % 2 === 0 ? 1.0 : 1.5) - A;
        link(p.id, nbrPort.id, w, 'grid', node.id, p.dir);
      }
    }
  }

  return { cellSize, baseNodes, baseById, pos, edges, adj };
}
