// Route every transit edge as a Dijkstra shortest path through a shared
// octilinear Hanan grid. Edges that share a real-world corridor naturally
// pick up the same grid edges; the downstream `computeCanonicalOffsets` then
// fans them into parallel ribbons.
//
// All cost terms are finite (paper's "constraint relaxation"): in particular,
// shared-segment conflicts are weighted, not infinite, so Dijkstra always
// returns a path when one exists. Edges with no path fall back to the
// existing per-edge `octilinearPath`.

import type { Pixel } from './types';
import { buildHananGrid, type HananGrid } from './hananGrid';
import { dijkstra } from './dijkstra';

export interface RouteableEdge {
  id: string;
  from: string;
  to: string;
  lineIds: Set<string>;
}

export interface HananRouterOptions {
  /** Base-grid cell size. Smaller = finer grid + less station displacement. */
  snapCell: number;
  /** Bounding-box padding for the grid (in pixels). */
  padding: number;
  /** Median edge length, used to scale bend/conflict/bonus weights. */
  medianEdgeLength: number;
  /** Per-edge Dijkstra expansion budget. Defaults to 80,000. */
  expansionBudget?: number;
}

// Cost-weight constants. Scaled by medianEdgeLength so different cities behave
// similarly. Tune after the visual checkpoint.
const BEND_TURN_K = 0.3;
const STATION_PENALTY_K = 2.0;
// Bundle bonus reduced so corridor-sharing doesn't override "go toward goal":
// the earlier (-1.5) made backwards detours through shared lanes cheaper than
// forward edges away from them, producing visible loops at stations.
const BUNDLE_BONUS_K = -0.4;
const CONFLICT_PENALTY_K = 3.0;
const DIAG_CROSS_PENALTY_K = 2.0;
// Penalty for taking an edge that disagrees with the geographic direction to
// the goal. Applied at every step; biggest impact at start nodes where the
// "leave direction" matters most. Weighted by edge length so longer wrong-way
// edges are penalized more.
const DIRECTION_DISAGREEMENT_K = 2.0;

/** Number of 45° steps between two octilinear direction indices (0..4). */
function turnSteps(prev: number, cur: number): number {
  const d = Math.abs(prev - cur) % 8;
  return Math.min(d, 8 - d);
}

const segKey = (u: string, v: string) => (u < v ? u + '|' + v : v + '|' + u);

/** Look up the direction of the grid edge (u → v), or -1 if absent. */
function dirOfEdge(grid: HananGrid, u: string, v: string): number {
  const adj = grid.adj.get(u);
  if (!adj) return -1;
  const e = adj.find((x) => x.to === v);
  return e ? e.dir : -1;
}

export interface HananRoutingResult {
  /** edgeId -> routed pixel polyline */
  paths: Map<string, Pixel[]>;
  /** station id -> snapped grid-node pixel position. The caller should render
   *  station markers and labels at these positions so they sit exactly where
   *  the routed paths start/end (otherwise the marker and path are offset). */
  snappedPositions: Map<string, Pixel>;
}

export function routeAllEdgesViaHanan(
  stationPositions: Map<string, Pixel>,
  edges: RouteableEdge[],
  opts: HananRouterOptions,
): HananRoutingResult {
  const grid = buildHananGrid(stationPositions, {
    snapCell: opts.snapCell,
    padding: opts.padding,
  });
  const med = opts.medianEdgeLength || 1;
  const budget = opts.expansionBudget ?? 80_000;

  // Shared-segment & diagonal-cross tracking, updated as we route each edge.
  const segLines = new Map<string, Set<string>>();
  // Per grid-node: which diagonal axes have been routed (axis 0 = dirs 1/5; axis 1 = dirs 3/7).
  const diagAxesAtNode = new Map<string, Set<number>>();

  // Order edges by importance: descending line count, then descending geographic length.
  const orderedEdges = [...edges].sort((a, b) => {
    const dl = b.lineIds.size - a.lineIds.size;
    if (dl !== 0) return dl;
    const pa1 = stationPositions.get(a.from)!;
    const pa2 = stationPositions.get(a.to)!;
    const pb1 = stationPositions.get(b.from)!;
    const pb2 = stationPositions.get(b.to)!;
    return (
      Math.hypot(pb1[0] - pb2[0], pb1[1] - pb2[1]) -
      Math.hypot(pa1[0] - pa2[0], pa1[1] - pa2[1])
    );
  });

  // Set of grid-node keys that ARE stations (pass-through penalty applies to others).
  const stationGridKeys = new Set(grid.stationNodeKeys.values());

  // Snapped grid positions per station — what the caller renders markers at.
  const snappedPositions = new Map<string, Pixel>();
  for (const [sid, gk] of grid.stationNodeKeys) {
    const p = grid.positions.get(gk);
    if (p) snappedPositions.set(sid, p);
  }

  const out = new Map<string, Pixel[]>();

  for (const tEdge of orderedEdges) {
    const startKey = grid.stationNodeKeys.get(tEdge.from);
    const goalKey = grid.stationNodeKeys.get(tEdge.to);
    const startSnap = startKey ? grid.positions.get(startKey) : undefined;
    const endSnap = goalKey ? grid.positions.get(goalKey) : undefined;

    if (!startKey || !goalKey || !startSnap || !endSnap) {
      // Grid construction lost this station — extremely unlikely; fall back
      // to real positions for a direct segment so the line is still continuous.
      const rf = stationPositions.get(tEdge.from)!;
      const rt = stationPositions.get(tEdge.to)!;
      out.set(tEdge.id, [rf, rt]);
      continue;
    }
    if (startKey === goalKey) {
      out.set(tEdge.id, [startSnap, endSnap]);
      continue;
    }

    const goalPos = grid.positions.get(goalKey)!;
    const heuristic = (k: string): number => {
      const p = grid.positions.get(k);
      if (!p) return 0;
      const dx = Math.abs(p[0] - goalPos[0]);
      const dy = Math.abs(p[1] - goalPos[1]);
      return Math.SQRT2 * Math.min(dx, dy) + Math.abs(dx - dy);
    };

    const neighbors = (n: string, prev: string | null) => {
      const adj = grid.adj.get(n) ?? [];
      const prevDir = prev === null ? -1 : dirOfEdge(grid, prev, n);
      const here = grid.positions.get(n);
      // Goal direction from the current node, as a unit vector. We compare
      // each candidate edge's direction against this to penalize "wrong-way"
      // leaves.
      let goalUx = 0;
      let goalUy = 0;
      if (here) {
        const gx = goalPos[0] - here[0];
        const gy = goalPos[1] - here[1];
        const gl = Math.hypot(gx, gy) || 1;
        goalUx = gx / gl;
        goalUy = gy / gl;
      }
      const result: { to: string; w: number }[] = [];
      for (const e of adj) {
        let w = e.len;

        // Bend cost: 0 for straight continuation, scaled by turn-step count.
        if (prevDir >= 0) {
          w += turnSteps(prevDir, e.dir) * BEND_TURN_K * med;
        }

        // Direction-disagreement cost: penalize edges that point away from the
        // goal. Most important at the start node (no prevDir to encourage a
        // sensible leave direction); still helps mid-path against detours into
        // wrong-direction shared corridors.
        if (here) {
          const nextPos = grid.positions.get(e.to);
          if (nextPos) {
            const edx = nextPos[0] - here[0];
            const edy = nextPos[1] - here[1];
            const eLen = Math.hypot(edx, edy) || 1;
            const alignment = (edx / eLen) * goalUx + (edy / eLen) * goalUy;
            // alignment in [-1, 1]: 1 = exactly toward goal, -1 = exactly away.
            // (1 - alignment) in [0, 2]. Scale by length so longer wrong-way
            // edges are penalized more.
            w += (1 - alignment) * DIRECTION_DISAGREEMENT_K * e.len;
          }
        }

        // Discourage routing through other stations (not the goal itself).
        if (e.to !== goalKey && stationGridKeys.has(e.to)) {
          w += STATION_PENALTY_K * med;
        }

        // Shared-segment term: bundle bonus for same lines, conflict penalty for different lines.
        const sk = segKey(n, e.to);
        const prior = segLines.get(sk);
        if (prior && prior.size > 0) {
          let same = 0;
          let diff = 0;
          for (const id of prior) {
            if (tEdge.lineIds.has(id)) same++;
            else diff++;
          }
          if (same > 0) w += BUNDLE_BONUS_K * e.len * Math.min(same, 3);
          if (diff > 0) w += CONFLICT_PENALTY_K * e.len * Math.min(diff, 3);
        }

        // Diagonal-cross penalty: discourage the "X" at a node where the other
        // diagonal axis is already routed.
        if (e.dir % 2 === 1) {
          const myAxis = e.dir === 1 || e.dir === 5 ? 0 : 1;
          const otherAxis = 1 - myAxis;
          const usedAxes = diagAxesAtNode.get(e.to);
          if (usedAxes && usedAxes.has(otherAxis)) {
            w += DIAG_CROSS_PENALTY_K * e.len;
          }
        }

        if (w < 0.01) w = 0.01;
        result.push({ to: e.to, w });
      }
      return result;
    };

    const res = dijkstra(startKey, goalKey, neighbors, heuristic, budget);

    if (!res || res.path.length < 2) {
      // Dijkstra failed — draw a straight segment between snapped positions
      // (still octilinear-friendly since both endpoints are on the grid).
      out.set(tEdge.id, [startSnap, endSnap]);
      continue;
    }

    // Record shared-segments + diagonal axes for future edges.
    for (let i = 1; i < res.path.length; i++) {
      const u = res.path[i - 1];
      const v = res.path[i];
      const sk = segKey(u, v);
      let s = segLines.get(sk);
      if (!s) {
        s = new Set();
        segLines.set(sk, s);
      }
      for (const id of tEdge.lineIds) s.add(id);

      const d = dirOfEdge(grid, u, v);
      if (d >= 0 && d % 2 === 1) {
        const axis = d === 1 || d === 5 ? 0 : 1;
        let axes = diagAxesAtNode.get(v);
        if (!axes) {
          axes = new Set();
          diagAxesAtNode.set(v, axes);
        }
        axes.add(axis);
      }
    }

    // The routed polyline is exactly the sequence of grid-node positions.
    // Stations are rendered at the snapped grid positions (the caller uses
    // `snappedPositions`), so paths and markers line up and every segment is
    // octilinear by construction — no bridge artefacts.
    const pixels: Pixel[] = res.path.map((k) => grid.positions.get(k)!);
    out.set(tEdge.id, pixels);
  }

  return { paths: out, snappedPositions };
}
