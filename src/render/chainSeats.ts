// Chain seat policy (invariant I3, chains spec sections 2.2 and 2.3,
// integration revised after three falsified geometry constructions):
// interior edges of a chain take their lane offsets from ONE shared seat
// ladder derived from the anchor frames, as a CONSTANT per (edge, line)
// at lane-build time. No rail geometry is constructed and no boundary is
// pinned: interior seams vanish because every interior edge shares the
// ladder frame, and the seams at the chain ends become ordinary jogs
// that the fan's existing machinery (zone-aware placement, forced-
// crossing steepening, absorption, endMoved discipline) already closes.
// Replacing interior lane geometry wholesale was falsified three ways:
// per-line seats collide across feeders, unpinned rail ends step at
// boundary bends, pinned ends fold under longitudinal drift.

import type { Pixel } from './layout/types';
import type { Chain } from './chains';

export interface ChainSeatArgs {
  chains: Chain[];
  edgeById: Map<string, { id: string; from: string; to: string }>;
  basePoly: (edgeId: string) => Pixel[] | undefined;
  /** Nominal slot+bias lateral offset of a line's lane on an edge, in the
   *  edge's from->to frame; undefined when the line has no lane there. */
  laneOffsetOf: (edgeId: string, lineId: string) => number | undefined;
  lineTraversals: Map<string, Array<{ edgeId: string; reversed: boolean }>>;
  spacing: number;
}

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

/** edge.id|lineId -> ladder-frame lateral offset (edge from->to frame)
 *  for every chain-interior lane of a framed participant. */
export function computeChainSeats(args: ChainSeatArgs): Map<string, number> {
  const { chains, edgeById, basePoly, laneOffsetOf, lineTraversals, spacing } = args;
  const out = new Map<string, number>();
  const lineIds = [...lineTraversals.keys()].sort();

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
    // from->to): one lateral frame for the whole chain.
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

    interface Run {
      lineId: string;
      edgeIds: string[];
      /** CHAIN-frame desired seat from the bounding frames. */
      desired: number;
      ladderSeat: number;
    }
    const runs: Run[] = [];
    for (const lineId of lineIds) {
      const trav = lineTraversals.get(lineId)!;
      let i = 0;
      while (i < trav.length) {
        if (!interior.has(trav[i].edgeId) || laneOffsetOf(trav[i].edgeId, lineId) === undefined) { i++; continue; }
        let j = i;
        while (
          j + 1 < trav.length &&
          interior.has(trav[j + 1].edgeId) &&
          laneOffsetOf(trav[j + 1].edgeId, lineId) !== undefined
        ) j++;
        const steps = trav.slice(i, j + 1);
        // travel direction at the run ends, from the base geometry
        const dirOf = (step: { edgeId: string; reversed: boolean }, atEnd: boolean): Pixel | null => {
          const base = basePoly(step.edgeId);
          if (!base || base.length < 2) return null;
          const pts = step.reversed ? [...base].reverse() : base;
          const p = atEnd ? pts[pts.length - 2] : pts[0];
          const q = atEnd ? pts[pts.length - 1] : pts[1];
          const l = hyp(q[0] - p[0], q[1] - p[1]) || 1;
          return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
        };
        // a bounding edge contributes its frame only when it continues
        // the corridor near-collinearly (a turning bound is a corner, and
        // its lateral frame is meaningless here)
        const boundSeat = (step: { edgeId: string; reversed: boolean } | undefined, refDir: Pixel | null, into: boolean): number | undefined => {
          if (!step || !refDir) return undefined;
          const e = edgeById.get(step.edgeId);
          if (!e) return undefined;
          const nodeId = into ? (step.reversed ? e.from : e.to) : (step.reversed ? e.to : e.from);
          const d = endDirInto(step.edgeId, nodeId);
          if (!d) return undefined;
          const travelDir: Pixel = into ? [-d[0], -d[1]] : d;
          const dot = travelDir[0] * refDir[0] + travelDir[1] * refDir[1];
          if (dot < 0.7) return undefined;
          const o = laneOffsetOf(step.edgeId, lineId);
          if (o === undefined) return undefined;
          const travelSeat = step.reversed ? -o : o;
          // travel frame -> chain frame via the run's first step alignment
          const aligned = !steps[0].reversed === (orientedForward.get(steps[0].edgeId) ?? true);
          return aligned ? travelSeat : -travelSeat;
        };
        const entry = boundSeat(i > 0 ? trav[i - 1] : undefined, dirOf(steps[0], false), true);
        const exit = boundSeat(j + 1 < trav.length ? trav[j + 1] : undefined, dirOf(steps[steps.length - 1], true), false);
        if (entry !== undefined || exit !== undefined) {
          runs.push({
            lineId,
            edgeIds: steps.map((s) => s.edgeId),
            desired: entry !== undefined && exit !== undefined ? (entry + exit) / 2 : (entry ?? exit!),
            ladderSeat: 0,
          });
        }
        i = j + 1;
      }
    }
    if (runs.length === 0) continue;

    // The shared ladder (spec 2.3): order by desired seat, pitch slots,
    // centered by the deterministic lower median.
    runs.sort((a, b) => (a.desired - b.desired) || (a.lineId < b.lineId ? -1 : 1));
    const centerK = (runs.length - 1) / 2;
    const offsets = runs
      .map((r, k) => r.desired - (k - centerK) * spacing)
      .sort((a, b) => a - b);
    const c = offsets[Math.floor((offsets.length - 1) / 2)];
    runs.forEach((r, k) => { r.ladderSeat = (k - centerK) * spacing + c; });

    for (const r of runs) {
      for (const edgeId of r.edgeIds) {
        const key = edgeId + '|' + r.lineId;
        if (out.has(key)) continue;
        const fwd = orientedForward.get(edgeId) ?? true;
        out.set(key, fwd ? r.ladderSeat : -r.ladderSeat);
      }
    }
  }
  return out;
}
