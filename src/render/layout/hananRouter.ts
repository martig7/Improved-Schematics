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
// Bends that happen RIGHT after leaving the start node (n one step from start)
// or RIGHT before arriving at the goal (e.to === goalKey) get this multiplier
// on top of the base bend cost. A line that leaves a station diagonally then
// immediately snaps to a contradictory direction looks like a mini-loop at the
// station endpoint — visually identical to the "loop" complaint but smaller.
// Multiplying station-adjacent bends pushes the router to commit to one
// direction for ≥1 extra grid edge before turning. Composes with the cardinal-
// entry constraint to produce a clean ~2-edge approach corridor at each end.
const STATION_ADJACENT_BEND_K = 4.0;
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
// Extra multiplier on the disagreement cost for the FIRST edge leaving the
// start. A path should originate in a direction that genuinely advances
// toward the goal; an exit edge that goes sideways or backwards is much more
// disruptive to read than a mid-path detour, so it pays more.
const EXIT_DIRECTION_K = 4.0;
// Cost penalty when the first/last grid segment of the routed path doesn't
// match the direction recorded by a previously-routed edge of the same line
// at the shared station. Each transit edge is routed independently, so
// without this term the two edges of a line meeting at a pass-through
// station can leave that station in different directions, creating a
// visible kink. Routing line edges in traversal order and applying this
// cost makes consecutive edges agree on direction at shared stations.
const LINE_CONTINUITY_K = 5.0;

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
  /** lineId → ordered edgeIds along that line's traversal. When supplied,
   *  edges are routed line-by-line in traversal order; the direction each
   *  edge ends up using at each station is recorded and applied as a soft
   *  preference to the next edge of the same line at the shared station.
   *  Result: consecutive edges of a line agree on direction at intermediate
   *  stations, eliminating spurious kinks at pass-through points. */
  lineEdgeOrder?: Map<string, string[]>,
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

  // Order edges so that consecutive edges of the same line are routed back-
  // to-back. The first edge of each line has no continuity constraint; every
  // subsequent edge of the line inherits the previous edge's direction at
  // the shared station as a preference. Lines with the most edges are
  // processed first so they "claim" directions at busy stations before
  // shorter lines.
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const orderedEdges: RouteableEdge[] = [];
  const seenEdgeIds = new Set<string>();
  if (lineEdgeOrder) {
    const lineIds = [...lineEdgeOrder.keys()].sort((a, b) => {
      const la = lineEdgeOrder.get(a)?.length ?? 0;
      const lb = lineEdgeOrder.get(b)?.length ?? 0;
      return lb - la;
    });
    for (const lid of lineIds) {
      for (const eid of lineEdgeOrder.get(lid) ?? []) {
        if (seenEdgeIds.has(eid)) continue;
        const e = edgeById.get(eid);
        if (!e) continue;
        orderedEdges.push(e);
        seenEdgeIds.add(eid);
      }
    }
  }
  // Append any edges not covered by lineEdgeOrder, in the original importance
  // order (line count desc, length desc).
  const leftover = edges.filter((e) => !seenEdgeIds.has(e.id));
  leftover.sort((a, b) => {
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
  orderedEdges.push(...leftover);

  // Per-(line, station) direction state. After each edge is routed, we record
  // the direction OF its first grid segment at the from-end, and the direction
  // OF its last grid segment at the to-end, under every line on the edge.
  // The next edge of the same line at that station can then look up the
  // direction and prefer to leave/arrive in the same direction (continuity).
  const lineDirAtStation = new Map<string, number>(); // 'lineId|stationId' -> dir

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

    // Line-continuity lookups: take the FIRST recorded direction across this
    // edge's lines at each station endpoint. Multiple lines can share a
    // station with different preferred directions; we use one (the first
    // available) as a soft preference, which is enough to nudge the router
    // when the alternative is similar-cost.
    let preferredFirstDir: number | undefined;
    let preferredLastDir: number | undefined;
    for (const lid of tEdge.lineIds) {
      if (preferredFirstDir === undefined) {
        const d = lineDirAtStation.get(lid + '|' + tEdge.from);
        if (d !== undefined) preferredFirstDir = d;
      }
      if (preferredLastDir === undefined) {
        const d = lineDirAtStation.get(lid + '|' + tEdge.to);
        if (d !== undefined) preferredLastDir = d;
      }
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
        // Bends at station-adjacent nodes (one step from start, or just before
        // the goal) get a multiplier so the line commits to one direction for
        // at least one extra grid edge before turning.
        if (prevDir >= 0) {
          const steps = turnSteps(prevDir, e.dir);
          let bend = steps * BEND_TURN_K * med;
          if (steps > 0 && (prev === startKey || e.to === goalKey)) {
            bend *= STATION_ADJACENT_BEND_K;
          }
          w += bend;
        }

        // Direction-disagreement cost: penalize edges that point away from the
        // goal. The exit edge (first edge leaving start, prev === null) pays
        // the multiplied EXIT_DIRECTION_K — a path should originate in a
        // direction that genuinely advances toward the goal, otherwise the
        // line visibly "leaves the wrong way" out of the station. Mid-path
        // edges pay the base K (still discourages detours into wrong-direction
        // shared corridors).
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
            const k = prev === null ? EXIT_DIRECTION_K : DIRECTION_DISAGREEMENT_K;
            w += (1 - alignment) * k * e.len;
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

        // Line-continuity preference: penalize first/last edge directions
        // that don't match the direction recorded by a previously-routed edge
        // of the same line at the shared station.
        if (prev === null && preferredFirstDir !== undefined && e.dir !== preferredFirstDir) {
          w += LINE_CONTINUITY_K * e.len;
        }
        if (e.to === goalKey && preferredLastDir !== undefined && e.dir !== preferredLastDir) {
          w += LINE_CONTINUITY_K * e.len;
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

    // Record per-(line, station) direction state from this edge for the
    // next edge of the same line to inherit. We only set the entry if not
    // already present — earlier-routed edges of the line claimed it first.
    const firstDir = dirOfEdge(grid, res.path[0], res.path[1]);
    const lastDir = dirOfEdge(grid, res.path[res.path.length - 2], res.path[res.path.length - 1]);
    if (firstDir >= 0) {
      for (const lid of tEdge.lineIds) {
        const k = lid + '|' + tEdge.from;
        if (!lineDirAtStation.has(k)) lineDirAtStation.set(k, firstDir);
      }
    }
    if (lastDir >= 0) {
      for (const lid of tEdge.lineIds) {
        const k = lid + '|' + tEdge.to;
        if (!lineDirAtStation.has(k)) lineDirAtStation.set(k, lastDir);
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
