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
  /** Painted half width per edge (bias-free). Enables the cross-chain
   *  merge of overlapping-parallel interiors; absent = same-edge merges
   *  only. */
  halfWidthOf?: (edgeId: string) => number;
}

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface ChainSeatRun {
  lineId: string;
  edgeIds: string[];
  /** Chain-frame bounding seats; undefined when that bound contributed no frame. */
  entry?: number;
  exit?: number;
  desired: number;
  ladderSeat: number;
}

export interface ChainSeatConflict {
  /** edgeId|lineId that a later chain also tried to seat. */
  key: string;
  kept: number;
  keptChain: number;
  discarded: number;
}

export interface ChainSeatReport {
  chainIndex: number;
  anchorA: string | null;
  anchorB: string | null;
  edgeIds: string[];
  /** Ladder center (lower-median of the runs' implied centers). */
  c: number;
  runs: ChainSeatRun[];
  conflicts: ChainSeatConflict[];
}

export interface ChainSeatResult {
  /** edge.id|lineId -> ladder-frame lateral offset (edge from->to frame)
   *  for every chain-interior lane of a framed participant. */
  seats: Map<string, number>;
  /** One row per seated overlap component (a chain can hold several);
   *  recording-only. */
  report: ChainSeatReport[];
  /** Cross-chain parallel pairs found among covered interior edges;
   *  recording-only. */
  pairs: Array<{ eA: string; eB: string; d0: number; sign: number; needed: number }>;
}

export function computeChainSeats(args: ChainSeatArgs): ChainSeatResult {
  const { chains, edgeById, basePoly, laneOffsetOf, lineTraversals, spacing, halfWidthOf } = args;
  const out = new Map<string, number>();
  const keyOwner = new Map<string, number>();
  const report: ChainSeatReport[] = [];
  const lineIds = [...lineTraversals.keys()].sort();

  // Collected across chains for the cross-chain merge phase.
  interface RunRec { run: ChainSeatRun; chain: number }
  const allRuns: RunRec[] = [];
  const fwdOfChain: Array<Map<string, boolean>> = [];

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

  for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
    const chain = chains[chainIndex];
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

    const runs: ChainSeatRun[] = [];
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
            entry,
            exit,
            desired: entry !== undefined && exit !== undefined ? (entry + exit) / 2 : (entry ?? exit!),
            ladderSeat: 0,
          });
        }
        i = j + 1;
      }
    }
    if (runs.length === 0) continue;

    // Merge directional duplicates: a line traversing the same interior
    // span in both directions is ONE ladder participant, not two. Without
    // this a bidirectional service doubles the ladder's occupancy and the
    // pitch quantization drags every seat away from its anchor frame.
    // Genuinely distinct visits (different edge spans) stay separate.
    {
      const byKey = new Map<string, ChainSeatRun[]>();
      for (const r of runs) {
        const f = r.edgeIds.join('>');
        const b = [...r.edgeIds].reverse().join('>');
        const key = r.lineId + '|' + (f < b ? f : b);
        const list = byKey.get(key);
        if (list) list.push(r); else byKey.set(key, [r]);
      }
      if (byKey.size < runs.length) {
        runs.length = 0;
        for (const group of byKey.values()) {
          const first = group[0];
          const bounds: number[] = [];
          for (const g of group) {
            if (g.entry !== undefined) bounds.push(g.entry);
            if (g.exit !== undefined) bounds.push(g.exit);
          }
          first.desired = bounds.reduce((s, v) => s + v, 0) / bounds.length;
          runs.push(first);
        }
      }
    }

    fwdOfChain[chainIndex] = orientedForward;
    for (const r of runs) allRuns.push({ run: r, chain: chainIndex });
  }
  const crossPairs: ChainSeatResult['pairs'] = [];
  if (allRuns.length === 0) return { seats: out, report, pairs: crossPairs };

  // Union-find with 1D affine potentials over the +/-1 group: pot(i)
  // maps run i's chain-frame seat into its root's frame,
  // seatRoot = s*seat + t. Links come from shared edges (within or
  // across chains) and from overlapping-parallel interior edge pairs
  // across chains; merged groups ladder once in the shared frame, so
  // sub-clearance corridors come out at pitch instead of each chain
  // seating blind beside the other.
  const parent = allRuns.map((_, i) => i);
  const ps = allRuns.map(() => 1);
  const pt = allRuns.map(() => 0);
  const find = (i: number): { root: number; s: number; t: number } => {
    if (parent[i] === i) return { root: i, s: ps[i], t: pt[i] };
    const up = find(parent[i]);
    // compose: seatRoot = up.s*(seatParentFrame) + up.t with
    // seatParentFrame = ps[i]*seat + pt[i]
    parent[i] = up.root;
    ps[i] = up.s * ps[i];
    pt[i] = up.s * pt[i] + up.t;
    return { root: parent[i], s: ps[i], t: pt[i] };
  };
  /** Link with constraint: seat_i-frame equivalent of j's seat is
   *  ls*seat_j + lt (both in their own chain frames). */
  const union = (i: number, j: number, ls: number, lt: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri.root === rj.root) return;
    // seatRoot_i = ri.s*seat_i + ri.t; seat_i == ls*seat_j + lt;
    // seat_j = rj.s^-1*(seatRoot_j - rj.t) = rj.s*(seatRoot_j - rj.t)
    // => seatRoot_i = ri.s*ls*rj.s*seatRoot_j + ri.s*(lt - ls*rj.s*rj.t) + ri.t
    const S = ri.s * ls * rj.s;
    const T = ri.s * lt - S * rj.t + ri.t;
    parent[rj.root] = ri.root;
    ps[rj.root] = S;
    pt[rj.root] = T;
  };

  const runsOnEdge = new Map<string, number[]>();
  const chainsOnEdge = new Map<string, Set<number>>();
  for (let i = 0; i < allRuns.length; i++) {
    for (const edgeId of allRuns[i].run.edgeIds) {
      const list = runsOnEdge.get(edgeId);
      if (list) list.push(i); else runsOnEdge.set(edgeId, [i]);
      let set = chainsOnEdge.get(edgeId);
      if (!set) { set = new Set(); chainsOnEdge.set(edgeId, set); }
      set.add(allRuns[i].chain);
    }
  }
  // Shared-edge links: runs on one edge share lateral space. Same chain
  // shares the frame directly; across chains the edge frame mediates.
  const sgn = (chain: number, edgeId: string): number =>
    (fwdOfChain[chain].get(edgeId) ?? true) ? 1 : -1;
  for (const edgeId of [...runsOnEdge.keys()].sort()) {
    const idxs = runsOnEdge.get(edgeId)!;
    for (let k = 1; k < idxs.length; k++) {
      const i = idxs[0];
      const j = idxs[k];
      const ls = sgn(allRuns[i].chain, edgeId) * sgn(allRuns[j].chain, edgeId);
      union(i, j, ls, 0);
    }
  }
  // Overlapping-parallel links across chains: the joint-seating idea
  // scoped to chain interiors, WITHOUT the shared-hub gate (chain
  // interiors are short dominated micro-corridors, not unrelated close
  // streets). The sampled corridor detector cannot see these: micro
  // edges are shorter than its sustained-run floor and staggered
  // long-vs-short pairs defeat midpoint symmetry. Instead the SHORTER
  // edge's midpoint projects onto the LONGER edge's polyline; an
  // interior, parallel, sub-clearance projection is a pair, and its
  // signed offset is the frame transform.
  if (halfWidthOf) {
    interface EdgeInfo { id: string; pts: Pixel[]; arc: number; mid: Pixel; midDir: Pixel }
    const infos: EdgeInfo[] = [];
    for (const id of [...runsOnEdge.keys()].sort()) {
      const pts = basePoly(id);
      if (!pts || pts.length < 2) continue;
      let arc = 0;
      for (let k = 1; k < pts.length; k++) arc += hyp(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      // midpoint by arclength, with the local segment direction
      let acc = 0;
      let mid: Pixel = pts[0];
      let midDir: Pixel = [1, 0];
      for (let k = 1; k < pts.length; k++) {
        const segLen = hyp(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (acc + segLen >= arc / 2 && segLen > 0) {
          const t = (arc / 2 - acc) / segLen;
          mid = [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
          midDir = [(pts[k][0] - pts[k - 1][0]) / segLen, (pts[k][1] - pts[k - 1][1]) / segLen];
          break;
        }
        acc += segLen;
      }
      infos.push({ id, pts, arc, mid, midDir });
    }
    for (let a = 0; a < infos.length; a++) {
      for (let b = a + 1; b < infos.length; b++) {
        const chainsA = chainsOnEdge.get(infos[a].id)!;
        const chainsB = chainsOnEdge.get(infos[b].id)!;
        let cross = false;
        for (const c of chainsA) if (!chainsB.has(c)) { cross = true; break; }
        if (!cross) continue;
        // longer edge hosts the projection; tie broken by the sort order
        const [L, S] = infos[a].arc >= infos[b].arc ? [infos[a], infos[b]] : [infos[b], infos[a]];
        const thresh = halfWidthOf(L.id) + halfWidthOf(S.id) + spacing * 0.75;
        // nearest point on L for S's midpoint, tracking the local direction
        let best = Infinity;
        let bq: Pixel = L.pts[0];
        let bdir: Pixel = [1, 0];
        let bClamped = true;
        for (let k = 1; k < L.pts.length; k++) {
          const p0 = L.pts[k - 1];
          const p1 = L.pts[k];
          const vx = p1[0] - p0[0], vy = p1[1] - p0[1];
          const len2 = vx * vx + vy * vy;
          if (len2 === 0) continue;
          let t = ((S.mid[0] - p0[0]) * vx + (S.mid[1] - p0[1]) * vy) / len2;
          const clamped = t <= 0 || t >= 1;
          t = Math.min(1, Math.max(0, t));
          const q: Pixel = [p0[0] + vx * t, p0[1] + vy * t];
          const dist = hyp(S.mid[0] - q[0], S.mid[1] - q[1]);
          if (dist < best) {
            best = dist;
            bq = q;
            const l = Math.sqrt(len2);
            bdir = [vx / l, vy / l];
            bClamped = clamped && (k === 1 && t <= 0 || k === L.pts.length - 1 && t >= 1);
          }
        }
        // interior of L (not spilling past its ends), parallel, in the
        // sub-clearance band
        const endGap = Math.min(
          hyp(bq[0] - L.pts[0][0], bq[1] - L.pts[0][1]),
          hyp(bq[0] - L.pts[L.pts.length - 1][0], bq[1] - L.pts[L.pts.length - 1][1]),
        );
        if (bClamped || endGap < 2) continue;
        const dot = S.midDir[0] * bdir[0] + S.midDir[1] * bdir[1];
        if (Math.abs(dot) < 0.9) continue;
        if (best >= thresh) continue;
        const perpL: Pixel = [-bdir[1], bdir[0]];
        const d0 = (S.mid[0] - bq[0]) * perpL[0] + (S.mid[1] - bq[1]) * perpL[1];
        const sign = dot >= 0 ? 1 : -1;
        // frame transform with eA = L, eB = S
        const i = runsOnEdge.get(L.id)![0];
        const j = runsOnEdge.get(S.id)![0];
        if (allRuns[i].chain === allRuns[j].chain) continue;
        crossPairs.push({ eA: L.id, eB: S.id, d0, sign, needed: thresh });
        const sa = sgn(allRuns[i].chain, L.id);
        const sb = sgn(allRuns[j].chain, S.id);
        // edge frame of L: pos = sa*seat_i; S's lane pos = d0 + sign*sb*seat_j
        // seat_i equivalent = sa*(d0 + sign*sb*seat_j)
        union(i, j, sa * sign * sb, sa * d0);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < allRuns.length; i++) {
    const root = find(i).root;
    const list = groups.get(root);
    if (list) list.push(i); else groups.set(root, [i]);
  }

  for (const idxs of [...groups.values()]) {
    // Cohabitant gate: every lane on a covered edge must belong to a
    // ladder participant. A line without a qualifying frame bound keeps
    // slot+bias, and re-seating its neighbours around an unmoved lane
    // lands them sub-pitch beside it. Such a group stays unseated.
    {
      const linesOn = new Map<string, Set<string>>();
      for (const i of idxs) {
        for (const edgeId of allRuns[i].run.edgeIds) {
          let set = linesOn.get(edgeId);
          if (!set) { set = new Set(); linesOn.set(edgeId, set); }
          set.add(allRuns[i].run.lineId);
        }
      }
      let unsafe = false;
      for (const [edgeId, participants] of linesOn) {
        for (const lineId of lineIds) {
          if (!participants.has(lineId) && laneOffsetOf(edgeId, lineId) !== undefined) {
            unsafe = true;
            break;
          }
        }
        if (unsafe) break;
      }
      if (unsafe) continue;
    }

    // Ladder in the shared root frame (spec 2.3 ordering, pitch slots,
    // deterministic lower-median centering), then map each seat back to
    // its run's own chain frame.
    interface Part { i: number; d: number; s: number; t: number }
    const parts: Part[] = idxs.map((i) => {
      const p = find(i);
      return { i, d: p.s * allRuns[i].run.desired + p.t, s: p.s, t: p.t };
    });
    parts.sort((a, b) => (a.d - b.d) ||
      (allRuns[a.i].run.lineId < allRuns[b.i].run.lineId ? -1 :
        allRuns[a.i].run.lineId > allRuns[b.i].run.lineId ? 1 :
          a.i - b.i));
    const centerK = (parts.length - 1) / 2;
    const offsets = parts
      .map((p, k) => p.d - (k - centerK) * spacing)
      .sort((a, b) => a - b);
    const c = offsets[Math.floor((offsets.length - 1) / 2)];
    const conflicts: ChainSeatConflict[] = [];
    const groupRuns: ChainSeatRun[] = [];
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      const rootSeat = (k - centerK) * spacing + c;
      const r = allRuns[p.i].run;
      r.ladderSeat = p.s * (rootSeat - p.t);
      groupRuns.push(r);
      const chain = allRuns[p.i].chain;
      for (const edgeId of r.edgeIds) {
        const key = edgeId + '|' + r.lineId;
        const fwd = fwdOfChain[chain].get(edgeId) ?? true;
        const seat = fwd ? r.ladderSeat : -r.ladderSeat;
        if (out.has(key)) {
          conflicts.push({
            key,
            kept: out.get(key)!,
            keptChain: keyOwner.get(key) ?? -1,
            discarded: seat,
          });
          continue;
        }
        out.set(key, seat);
        keyOwner.set(key, chain);
      }
    }
    const covered = new Set<string>();
    for (const r of groupRuns) for (const edgeId of r.edgeIds) covered.add(edgeId);
    const firstChain = allRuns[parts[0].i].chain;
    report.push({
      chainIndex: firstChain,
      anchorA: chains[firstChain].anchorA,
      anchorB: chains[firstChain].anchorB,
      edgeIds: [...covered].sort(),
      c,
      runs: groupRuns,
      conflicts,
    });
  }
  return { seats: out, report, pairs: crossPairs };
}
