// Chain rails (invariant I3, chains spec sections 2.2 and 2.3): over a
// chain's interior, every line rides a rail derived from ONE shared seat
// ladder plus the anchor frames it enters and leaves with, so all lines
// touching the interior hold mutual pitch by construction and seat seams
// resolve as placed transitions instead of per-node jogs. Interior lane
// polylines are replaced in place; downstream machinery sees ordinary
// lanes. Per-line independent seats were tried first and falsified:
// lines entering through different feeders carry disagreeing frames, and
// independently-seated rails collide exactly like the frame mixes the
// sibling guard blocks elsewhere.

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

interface Run {
  lineId: string;
  steps: Array<{ edgeId: string; reversed: boolean }>;
  first: number; // traversal index of the first step
  /** Travel frame agrees with the chain's edge orientation. */
  aligned: boolean;
  /** CHAIN-frame end seats; undefined = no collinear bounding frame. */
  entrySeat: number | undefined;
  exitSeat: number | undefined;
  /** CHAIN-frame ladder seat, assigned after ordering. */
  ladderSeat: number;
}

/** Returns the number of (chain, line) rails built. */
export function buildChainRails(args: RailArgs): number {
  const { chains, edgeById, basePoly, laneOffsetOf, lineTraversals, segPath, suppressed, spacing } = args;
  void suppressed;
  let built = 0;
  const lineIds = [...lineTraversals.keys()].sort();

  const seatTravel = (edgeId: string, reversed: boolean, lineId: string): number | undefined => {
    const o = laneOffsetOf(edgeId, lineId);
    return o === undefined ? undefined : (reversed ? -o : o);
  };

  const endDirInto = (edgeId: string, node: string): Pixel | null => {
    const e = edgeById.get(edgeId);
    const base = basePoly(edgeId);
    if (!e || !base || base.length < 2) return null;
    const atStart = e.from === node;
    if (!atStart && e.to !== node) return null;
    const p = atStart ? base[0] : base[base.length - 1];
    const q = atStart ? base[1] : base[base.length - 2];
    const l = hyp(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };

  for (const chain of chains) {
    const interior = new Set(chain.edgeIds);
    // Chain orientation per interior edge (true = the chain runs the edge
    // from->to), so every participant's seats map into ONE lateral frame.
    const orientedForward = new Map<string, boolean>();
    {
      let entering: string | null = null;
      for (let k = 0; k < chain.edgeIds.length; k++) {
        const e = edgeById.get(chain.edgeIds[k]);
        if (!e) break;
        if (entering === null) {
          if (chain.edgeIds.length === 1) {
            orientedForward.set(e.id, true);
            break;
          }
          const n = edgeById.get(chain.edgeIds[k + 1]);
          if (!n) break;
          const shared = (e.to === n.from || e.to === n.to) ? e.to : e.from;
          orientedForward.set(e.id, shared === e.to);
          entering = shared;
        } else {
          const fwd = e.from === entering;
          orientedForward.set(e.id, fwd);
          entering = fwd ? e.to : e.from;
        }
      }
    }

    // Participants: maximal contiguous interior runs per line.
    const runs: Run[] = [];
    for (const lineId of lineIds) {
      const trav = lineTraversals.get(lineId)!;
      let i = 0;
      while (i < trav.length) {
        if (!interior.has(trav[i].edgeId) || !segPath.has(trav[i].edgeId + '|' + lineId)) { i++; continue; }
        let j = i;
        while (
          j + 1 < trav.length &&
          interior.has(trav[j + 1].edgeId) &&
          segPath.has(trav[j + 1].edgeId + '|' + lineId)
        ) j++;
        const steps = trav.slice(i, j + 1);
        const aligned = !steps[0].reversed === (orientedForward.get(steps[0].edgeId) ?? true);
        const toChain = (travelSeat: number | undefined): number | undefined =>
          travelSeat === undefined ? undefined : (aligned ? travelSeat : -travelSeat);
        const bound = (step: { edgeId: string; reversed: boolean } | undefined, refDir: Pixel, into: boolean): number | undefined => {
          if (!step) return undefined;
          const e = edgeById.get(step.edgeId);
          if (!e) return undefined;
          const nodeId = into ? (step.reversed ? e.from : e.to) : (step.reversed ? e.to : e.from);
          const d = endDirInto(step.edgeId, nodeId);
          if (!d) return undefined;
          const travelDir: Pixel = into ? [-d[0], -d[1]] : d;
          const dot = travelDir[0] * refDir[0] + travelDir[1] * refDir[1];
          if (dot < 0.7) return undefined;
          return toChain(seatTravel(step.edgeId, step.reversed, lineId));
        };
        const dirAt = (step: { edgeId: string; reversed: boolean }, atEnd: boolean): Pixel | null => {
          const base = basePoly(step.edgeId);
          if (!base || base.length < 2) return null;
          const pts = step.reversed ? [...base].reverse() : base;
          const p = atEnd ? pts[pts.length - 2] : pts[0];
          const q = atEnd ? pts[pts.length - 1] : pts[1];
          const l = hyp(q[0] - p[0], q[1] - p[1]) || 1;
          return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
        };
        const startDir = dirAt(steps[0], false);
        const endDir = dirAt(steps[steps.length - 1], true);
        runs.push({
          lineId,
          steps,
          first: i,
          aligned,
          entrySeat: startDir ? bound(i > 0 ? trav[i - 1] : undefined, startDir, true) : undefined,
          exitSeat: endDir ? bound(j + 1 < trav.length ? trav[j + 1] : undefined, endDir, false) : undefined,
          ladderSeat: 0,
        });
        i = j + 1;
      }
    }

    // The shared ladder (spec 2.3): order every framed participant by its
    // desired mean seat, assign pitch slots, and center the ladder where
    // it disturbs the desired seats least (lower median offset, which is
    // deterministic). Unframed runs keep their original lanes.
    const framed = runs.filter((r) => r.entrySeat !== undefined || r.exitSeat !== undefined);
    if (framed.length === 0) continue;
    const desired = (r: Run): number =>
      r.entrySeat !== undefined && r.exitSeat !== undefined
        ? (r.entrySeat + r.exitSeat) / 2
        : (r.entrySeat ?? r.exitSeat!);
    framed.sort((a, b) => (desired(a) - desired(b)) || (a.lineId < b.lineId ? -1 : 1));
    const centerK = (framed.length - 1) / 2;
    const offsets = framed
      .map((r, k) => desired(r) - (k - centerK) * spacing)
      .sort((a, b) => a - b);
    const c = offsets[Math.floor((offsets.length - 1) / 2)];
    framed.forEach((r, k) => { r.ladderSeat = (k - centerK) * spacing + c; });

    for (const r of framed) {
      if (buildRun(r)) built++;
    }

    function buildRun(run: Run): boolean {
      // travel-oriented centerline with per-step vertex index ranges
      const center: Pixel[] = [];
      const stepRange: Array<[number, number]> = [];
      for (const step of run.steps) {
        const base = basePoly(step.edgeId);
        if (!base || base.length < 2) return false;
        const pts = step.reversed ? [...base].reverse() : base;
        const start = center.length > 0 ? center.length - 1 : 0;
        for (const p of pts) {
          const last = center[center.length - 1];
          if (!last || hyp(p[0] - last[0], p[1] - last[1]) > 1e-9) center.push([p[0], p[1]]);
        }
        stepRange.push([start, center.length - 1]);
      }
      if (center.length < 2) return false;
      const arcs: number[] = [0];
      for (let k = 1; k < center.length; k++) {
        arcs.push(arcs[k - 1] + hyp(center[k][0] - center[k - 1][0], center[k][1] - center[k - 1][1]));
      }
      const total = arcs[arcs.length - 1];

      // travel-frame seats: the ladder mid is authoritative (snapping it
      // toward an end seat steals up to the snap threshold from adjacent
      // pitch and voids the ladder's guarantee); end seats bind only the
      // rail ENDS, for anchor continuity
      const sign = run.aligned ? 1 : -1;
      const mid = run.ladderSeat * sign;
      const entry = (run.entrySeat !== undefined ? run.entrySeat * sign : mid);
      const exit = (run.exitSeat !== undefined ? run.exitSeat * sign : mid);

      // interior junction balls inside the run
      const balls: Array<{ at: number; reach: number }> = [];
      for (let k = 0; k < stepRange.length - 1; k++) {
        const at = arcs[stepRange[k][1]];
        const eA = run.steps[k].edgeId;
        const eB = run.steps[k + 1].edgeId;
        const idx = chain.edgeIds.findIndex((id, n) =>
          (id === eA && chain.edgeIds[n + 1] === eB) || (id === eB && chain.edgeIds[n + 1] === eA));
        const reach = idx >= 0 ? chain.interiorNodes[idx]?.reach ?? 0 : 0;
        balls.push({ at, reach });
      }
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

      // Two ramps: entry->mid in the FIRST room, mid->exit in the LAST
      // room (one room serves both by splitting); with no room at all the
      // whole change rides across the lowest-reach junction as one ramp.
      interface Ramp { t0: number; t1: number; from: number; to: number }
      const ramps: Ramp[] = [];
      const wantA = Math.abs(mid - entry) > 1e-9 ? Math.max(Math.abs(mid - entry), spacing) : 0;
      const wantB = Math.abs(exit - mid) > 1e-9 ? Math.max(Math.abs(exit - mid), spacing) : 0;
      if (intervals.length === 0) {
        // every junction ball covers the run: split at the lowest-reach
        // junction so the ladder still holds through the middle, with the
        // two ramps riding across the turns' sweeps (the seat changes
        // hide inside them)
        let at = total / 2;
        let lowest = Infinity;
        for (const b of balls) if (b.reach < lowest) { lowest = b.reach; at = b.at; }
        intervals = [[0, at], [at, total]].filter(([s, t]) => t - s > 1e-6) as Array<[number, number]>;
      }
      {
        let firstIv = intervals[0];
        let lastIv = intervals[intervals.length - 1];
        if (intervals.length === 1 && wantA > 0 && wantB > 0) {
          const [s, t] = intervals[0];
          const m = (s + t) / 2;
          firstIv = [s, m];
          lastIv = [m, t];
        }
        if (wantA > 0) {
          const len = Math.min(wantA, firstIv[1] - firstIv[0]);
          const m = (firstIv[0] + firstIv[1]) / 2;
          ramps.push({ t0: Math.max(firstIv[0], m - len / 2), t1: Math.min(firstIv[1], m + len / 2), from: entry, to: mid });
        }
        if (wantB > 0) {
          const len = Math.min(wantB, lastIv[1] - lastIv[0]);
          const m = (lastIv[0] + lastIv[1]) / 2;
          ramps.push({ t0: Math.max(lastIv[0], m - len / 2), t1: Math.min(lastIv[1], m + len / 2), from: mid, to: exit });
        }
      }
      // degenerate rooms can produce zero-length ramps: widen minimally
      for (const rp of ramps) {
        if (rp.t1 - rp.t0 < 1e-6) {
          rp.t0 = Math.max(0, rp.t0 - spacing / 2);
          rp.t1 = Math.min(total, rp.t1 + spacing / 2);
        }
      }
      ramps.sort((a, b) => a.t0 - b.t0);

      const seatAt = (a: number): number => {
        let s = entry;
        for (const rp of ramps) {
          if (a <= rp.t0) return s;
          if (a >= rp.t1) { s = rp.to; continue; }
          return rp.from + ((rp.to - rp.from) * (a - rp.t0)) / (rp.t1 - rp.t0);
        }
        return s;
      };

      // insert ramp boundary vertices, then per-vertex offsets
      const boundaries = ramps.flatMap((rp) => [rp.t0, rp.t1]).filter((t) => t > 0.01 && t < total - 0.01);
      const withBounds: Pixel[] = [];
      const wArcs: number[] = [];
      let bi = 0;
      for (let k = 0; k < center.length; k++) {
        while (bi < boundaries.length && boundaries[bi] < arcs[k] - 0.01) {
          const tb = boundaries[bi++];
          if (tb <= (wArcs[wArcs.length - 1] ?? -1) + 0.01) continue;
          for (let m = 1; m < center.length; m++) {
            if (arcs[m] >= tb - 1e-9) {
              const seg = arcs[m] - arcs[m - 1] || 1;
              const t = Math.min(1, Math.max(0, (tb - arcs[m - 1]) / seg));
              withBounds.push([
                center[m - 1][0] + (center[m][0] - center[m - 1][0]) * t,
                center[m - 1][1] + (center[m][1] - center[m - 1][1]) * t,
              ]);
              wArcs.push(tb);
              break;
            }
          }
        }
        withBounds.push(center[k]);
        wArcs.push(arcs[k]);
      }
      const offs = wArcs.map((a) => seatAt(a));
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
        const step = run.steps[k];
        const lane = step.reversed ? [...slice].reverse() : slice;
        segPath.set(step.edgeId + '|' + run.lineId, lane);
      }
      return true;
    }
  }
  return built;
}
