// Chain rails (invariant I3, chains spec section 2.2): over a chain's
// interior, every line rides a rail derived from the ANCHOR frames it
// enters and leaves with, so all lines touching the interior share one
// frame family and seat seams resolve as placed transitions instead of
// per-node jogs fighting the neighbouring junctions' sweeps. Interior
// lane polylines are replaced in place; downstream machinery sees
// ordinary lanes.

import type { Pixel } from './layout/types';
import { offsetPolylineVar } from './layout/offsets';
import type { Chain } from './chains';

export interface RailArgs {
  chains: Chain[];
  edgeById: Map<string, { id: string; from: string; to: string }>;
  basePoly: (edgeId: string) => Pixel[] | undefined;
  /** slot+bias lateral offset of a line's lane on an edge, in the edge's
   *  from->to frame; undefined when the line has no lane there. */
  laneOffsetOf: (edgeId: string, lineId: string) => number | undefined;
  lineTraversals: Map<string, Array<{ edgeId: string; reversed: boolean }>>;
  /** edge.id|lineId lane polylines, interior entries REPLACED in place. */
  segPath: Map<string, Pixel[]>;
  suppressed: Set<string>;
  spacing: number;
}

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

/** Returns the number of (chain, line) rails built. */
export function buildChainRails(args: RailArgs): number {
  const { chains, edgeById, basePoly, laneOffsetOf, lineTraversals, segPath, suppressed, spacing } = args;
  let built = 0;
  const lineIds = [...lineTraversals.keys()].sort();
  for (const chain of chains) {
    const interior = new Set(chain.edgeIds);
    for (const lineId of lineIds) {
      const trav = lineTraversals.get(lineId)!;
      // maximal contiguous runs of interior steps with live lanes
      let i = 0;
      while (i < trav.length) {
        if (!interior.has(trav[i].edgeId) || !segPath.has(trav[i].edgeId + '|' + lineId)) { i++; continue; }
        let j = i;
        while (
          j + 1 < trav.length &&
          interior.has(trav[j + 1].edgeId) &&
          segPath.has(trav[j + 1].edgeId + '|' + lineId)
        ) j++;
        if (buildRun(chain, lineId, trav, i, j)) built++;
        i = j + 1;
      }
    }
  }
  return built;

  /** Travel-frame seat of the line on `edgeId` when traversed with
   *  `reversed`: a lane at +o in the edge's from->to frame sits at -o in
   *  the reversed travel frame. */
  function seatTravel(edgeId: string, reversed: boolean, lineId: string): number | undefined {
    const o = laneOffsetOf(edgeId, lineId);
    return o === undefined ? undefined : (reversed ? -o : o);
  }

  /** Direction of an edge's base at one of its ends, pointing INTO the
   *  edge; used to test whether a bounding edge continues the corridor. */
  function endDirInto(edgeId: string, node: string): Pixel | null {
    const e = edgeById.get(edgeId);
    const base = basePoly(edgeId);
    if (!e || !base || base.length < 2) return null;
    const atStart = e.from === node;
    if (!atStart && e.to !== node) return null;
    const p = atStart ? base[0] : base[base.length - 1];
    const q = atStart ? base[1] : base[base.length - 2];
    const l = hyp(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  }

  function buildRun(
    chain: Chain,
    lineId: string,
    trav: Array<{ edgeId: string; reversed: boolean }>,
    i: number,
    j: number,
  ): boolean {
    // travel-oriented centerline with per-step vertex index ranges
    const center: Pixel[] = [];
    const stepRange: Array<[number, number]> = [];
    for (let k = i; k <= j; k++) {
      const base = basePoly(trav[k].edgeId);
      if (!base || base.length < 2) return false;
      const pts = trav[k].reversed ? [...base].reverse() : base;
      const start = center.length > 0 ? center.length - 1 : 0;
      for (const p of pts) {
        const last = center[center.length - 1];
        if (!last || hyp(p[0] - last[0], p[1] - last[1]) > 1e-9) center.push([p[0], p[1]]);
        else if (center.length > 0 && stepRange.length > 0) { /* shared joint kept once */ }
      }
      stepRange.push([start, center.length - 1]);
    }
    if (center.length < 2) return false;
    // Bounding seats: from the adjacent traversal edges when they continue
    // the corridor (near-collinear with the run's end direction); a
    // bounding edge that turns away contributes no frame, and the line
    // rides the seat from its other end to the turn (ride-until-turn). A
    // run with neither frame keeps its original lanes.
    const runStartDir: Pixel = (() => {
      const l = hyp(center[1][0] - center[0][0], center[1][1] - center[0][1]) || 1;
      return [(center[1][0] - center[0][0]) / l, (center[1][1] - center[0][1]) / l];
    })();
    const kEnd = center.length - 1;
    const runEndDir: Pixel = (() => {
      const l = hyp(center[kEnd][0] - center[kEnd - 1][0], center[kEnd][1] - center[kEnd - 1][1]) || 1;
      return [(center[kEnd][0] - center[kEnd - 1][0]) / l, (center[kEnd][1] - center[kEnd - 1][1]) / l];
    })();
    const boundSeat = (step: { edgeId: string; reversed: boolean } | undefined, refDir: Pixel, into: boolean): number | undefined => {
      if (!step) return undefined;
      const e = edgeById.get(step.edgeId);
      if (!e) return undefined;
      // the node where the bounding edge meets the run: its travel END
      // when it precedes the run, its travel START when it follows
      const nodeId = into ? (step.reversed ? e.from : e.to) : (step.reversed ? e.to : e.from);
      const d = endDirInto(step.edgeId, nodeId);
      if (!d) return undefined;
      // travel direction through the junction: a preceding edge ARRIVES
      // along -d, a following edge DEPARTS along d; only a near-collinear
      // continuation contributes a frame (an edge that turns away meets
      // the run at a corner and its lateral frame is meaningless here)
      const travelDir: Pixel = into ? [-d[0], -d[1]] : d;
      const dot = travelDir[0] * refDir[0] + travelDir[1] * refDir[1];
      if (dot < 0.7) return undefined;
      return seatTravel(step.edgeId, step.reversed, lineId);
    };
    const prevStep = i > 0 ? trav[i - 1] : undefined;
    const nextStep = j + 1 < trav.length ? trav[j + 1] : undefined;
    let entry = boundSeat(prevStep, runStartDir, true);
    let exit = boundSeat(nextStep, runEndDir, false);
    if (entry === undefined && exit === undefined) return false;
    if (entry === undefined) entry = exit!;
    if (exit === undefined) exit = entry;
    // arclengths of vertices and of interior-node balls
    const arcs: number[] = [0];
    for (let k = 1; k < center.length; k++) {
      arcs.push(arcs[k - 1] + hyp(center[k][0] - center[k - 1][0], center[k][1] - center[k - 1][1]));
    }
    const total = arcs[arcs.length - 1];
    // interior junction balls at the step boundaries inside the run
    const balls: Array<{ at: number; reach: number }> = [];
    for (let k = 0; k < stepRange.length - 1; k++) {
      const at = arcs[stepRange[k][1]];
      const eA = trav[i + k].edgeId;
      const eB = trav[i + k + 1].edgeId;
      const idx = chain.edgeIds.findIndex((id, n) =>
        (id === eA && chain.edgeIds[n + 1] === eB) || (id === eB && chain.edgeIds[n + 1] === eA));
      const reach = idx >= 0 ? chain.interiorNodes[idx]?.reach ?? 0 : 0;
      balls.push({ at, reach });
    }
    // largest reach-free interval
    let intervals: Array<[number, number]> = [[0, total]];
    for (const b of balls) {
      const next: Array<[number, number]> = [];
      for (const [s, t] of intervals) {
        const lo = Math.max(s, b.at - b.reach);
        const hi = Math.min(t, b.at + b.reach);
        if (hi <= lo) { next.push([s, t]); continue; }
        if (lo > s) next.push([s, lo]);
        if (hi < t) next.push([hi, t]);
      }
      intervals = next;
    }
    const delta = exit - entry;
    let t0: number;
    let t1: number;
    if (Math.abs(delta) < 1e-9) {
      t0 = 0; t1 = 0;
    } else {
      const want = Math.max(Math.abs(delta), spacing);
      let best: [number, number] | null = null;
      for (const iv of intervals) {
        if (!best || iv[1] - iv[0] > best[1] - best[0]) best = iv;
      }
      if (best && best[1] - best[0] >= want) {
        const mid = (best[0] + best[1]) / 2;
        t0 = mid - want / 2;
        t1 = mid + want / 2;
      } else {
        // no room: ride the transition across the lowest-reach interior
        // junction (the seat change hides inside its turn's sweep); a
        // run with no interior junction centers on its middle
        let center0 = total / 2;
        let lowest = Infinity;
        for (const b of balls) {
          if (b.reach < lowest) { lowest = b.reach; center0 = b.at; }
        }
        t0 = Math.max(0, center0 - want / 2);
        t1 = Math.min(total, center0 + want / 2);
        if (t1 <= t0) { t0 = 0; t1 = total; }
      }
    }
    // insert transition boundary vertices, compute per-vertex offsets
    const withBounds: Pixel[] = [];
    const wArcs: number[] = [];
    const pushAt = (arc: number): void => {
      // interpolate the centerline point at `arc`
      for (let k = 1; k < center.length; k++) {
        if (arcs[k] >= arc - 1e-9) {
          const seg = arcs[k] - arcs[k - 1] || 1;
          const t = Math.min(1, Math.max(0, (arc - arcs[k - 1]) / seg));
          withBounds.push([
            center[k - 1][0] + (center[k][0] - center[k - 1][0]) * t,
            center[k - 1][1] + (center[k][1] - center[k - 1][1]) * t,
          ]);
          wArcs.push(arc);
          return;
        }
      }
    };
    for (let k = 0; k < center.length; k++) {
      for (const tb of [t0, t1]) {
        if (tb > (wArcs[wArcs.length - 1] ?? -1) + 0.01 && tb < arcs[k] - 0.01) pushAt(tb);
      }
      withBounds.push(center[k]);
      wArcs.push(arcs[k]);
    }
    const offs = wArcs.map((a) => {
      if (t1 <= t0) return entry!;
      if (a <= t0) return entry!;
      if (a >= t1) return exit!;
      return entry! + (delta * (a - t0)) / (t1 - t0);
    });
    const rail = offsetPolylineVar(withBounds, offs);
    // slice back per edge, restoring each edge's from->to orientation
    for (let k = 0; k < stepRange.length; k++) {
      const loArc = arcs[stepRange[k][0]];
      const hiArc = arcs[stepRange[k][1]];
      const slice: Pixel[] = [];
      for (let v = 0; v < rail.length; v++) {
        if (wArcs[v] >= loArc - 1e-9 && wArcs[v] <= hiArc + 1e-9) slice.push(rail[v]);
      }
      if (slice.length < 2) continue;
      const step = trav[i + k];
      const lane = step.reversed ? [...slice].reverse() : slice;
      segPath.set(step.edgeId + '|' + lineId, lane);
      void suppressed;
    }
    return true;
  }
}
