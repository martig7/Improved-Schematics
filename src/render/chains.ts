// Micro-edge chain detection (invariant I3, chains spec section 2.1): a
// chain is a maximal run of consecutive edges dominated by junction
// geometry, bounded by anchor edges that own their frames. Detection is
// purely theoretical (half widths and turn angles; it runs before any
// construction exists to measure) and deterministic (sorted iteration).

import type { Pixel } from './layout/types';

export interface ChainEdgeRef {
  id: string;
  from: string;
  to: string;
}

export interface Chain {
  /** Interior (dominated) edges in corridor order. */
  edgeIds: string[];
  /** Bounding anchor edge at each end; null at a terminus. */
  anchorA: string | null;
  anchorB: string | null;
  /** Total interior arc, px. */
  arc: number;
  /** Shared node between each consecutive interior edge pair, with its
   *  theoretical corner reach (rails place seat transitions outside
   *  these balls). */
  interiorNodes: Array<{ node: string; reach: number }>;
}

export interface ChainArgs {
  edges: ChainEdgeRef[];
  basePoly: (edgeId: string) => Pixel[] | undefined;
  /** Drawn lane count per edge (0 = undrawn, excluded). */
  laneCount: (edgeId: string) => number;
  spacing: number;
}

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export function detectChains(args: ChainArgs): Chain[] {
  const { edges, basePoly, laneCount, spacing } = args;
  interface Info {
    id: string; from: string; to: string;
    arc: number; endDir: Map<string, Pixel>; half: number;
  }
  const infos = new Map<string, Info>();
  const atNode = new Map<string, string[]>();
  for (const e of [...edges].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const n = laneCount(e.id);
    if (n <= 0) continue;
    const base = basePoly(e.id);
    if (!base || base.length < 2) continue;
    let arc = 0;
    for (let i = 1; i < base.length; i++) arc += hyp(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]);
    const lf = hyp(base[1][0] - base[0][0], base[1][1] - base[0][1]) || 1;
    const dirFrom: Pixel = [(base[1][0] - base[0][0]) / lf, (base[1][1] - base[0][1]) / lf];
    const k = base.length;
    const lt = hyp(base[k - 2][0] - base[k - 1][0], base[k - 2][1] - base[k - 1][1]) || 1;
    const dirTo: Pixel = [(base[k - 2][0] - base[k - 1][0]) / lt, (base[k - 2][1] - base[k - 1][1]) / lt];
    infos.set(e.id, {
      id: e.id, from: e.from, to: e.to, arc,
      endDir: new Map([[e.from, dirFrom], [e.to, dirTo]]),
      half: ((n - 1) / 2) * spacing,
    });
    for (const nd of [e.from, e.to]) {
      if (!atNode.has(nd)) atNode.set(nd, []);
      atNode.get(nd)!.push(e.id);
    }
  }
  // Theoretical reach at a node: max over incident drawn edge pairs that
  // form a GENUINE turn of (halfA + halfB + 2*spacing) / sin(turn), the
  // fan builder's corner formula. Near-collinear pairs construct no
  // corner sweep; letting their clamped denominator contribute would mark
  // every edge near a straight continuation as dominated (the same
  // over-reach the measured-zone census exists to avoid). Half an
  // octilinear step is the smallest genuine turn.
  const MIN_TURN_SIN = Math.sin(Math.PI / 8);
  const reachAt = new Map<string, number>();
  for (const [nd, ids] of atNode) {
    let best = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = infos.get(ids[i])!;
        const B = infos.get(ids[j])!;
        const da = A.endDir.get(nd)!;
        const db = B.endDir.get(nd)!;
        const den = Math.abs(da[0] * db[1] - da[1] * db[0]);
        if (den < MIN_TURN_SIN) continue;
        best = Math.max(best, (A.half + B.half + 2 * spacing) / Math.max(den, 0.5));
      }
    }
    reachAt.set(nd, best);
  }
  const dominated = (e: Info): boolean => e.arc < (reachAt.get(e.from) ?? 0) + (reachAt.get(e.to) ?? 0);
  // Chain walk: from every dominated edge not yet claimed, extend in both
  // directions through the most-collinear dominated continuation at each
  // node (a genuine turn or an anchor ends the interior).
  const claimed = new Set<string>();
  const chains: Chain[] = [];
  const continuation = (edgeId: string, nd: string): { next: string | null; anchor: string | null } => {
    const cur = infos.get(edgeId)!;
    const away = cur.endDir.get(nd)!;
    const inDir: Pixel = [-away[0], -away[1]];
    let best: { id: string; dot: number } | null = null;
    for (const cand of atNode.get(nd) ?? []) {
      if (cand === edgeId) continue;
      const ci = infos.get(cand)!;
      const out = ci.endDir.get(nd)!;
      const dot = inDir[0] * out[0] + inDir[1] * out[1];
      if (dot < 0.7) continue;
      if (!best || dot > best.dot || (dot === best.dot && cand < best.id)) best = { id: cand, dot };
    }
    if (!best) return { next: null, anchor: null };
    return dominated(infos.get(best.id)!)
      ? { next: best.id, anchor: null }
      : { next: null, anchor: best.id };
  };
  for (const id of [...infos.keys()].sort()) {
    const info = infos.get(id)!;
    if (claimed.has(id) || !dominated(info)) continue;
    const run: string[] = [id];
    claimed.add(id);
    let anchorA: string | null = null;
    let anchorB: string | null = null;
    let nd = info.from;
    let cur = id;
    for (;;) {
      const c = continuation(cur, nd);
      if (c.next === null) { anchorA = c.anchor; break; }
      if (claimed.has(c.next)) break;
      run.unshift(c.next);
      claimed.add(c.next);
      const ci = infos.get(c.next)!;
      nd = ci.from === nd ? ci.to : ci.from;
      cur = c.next;
    }
    nd = info.to;
    cur = id;
    for (;;) {
      const c = continuation(cur, nd);
      if (c.next === null) { anchorB = c.anchor; break; }
      if (claimed.has(c.next)) break;
      run.push(c.next);
      claimed.add(c.next);
      const ci = infos.get(c.next)!;
      nd = ci.from === nd ? ci.to : ci.from;
      cur = c.next;
    }
    const interiorNodes: Array<{ node: string; reach: number }> = [];
    for (let i = 1; i < run.length; i++) {
      const A = infos.get(run[i - 1])!;
      const B = infos.get(run[i])!;
      const shared = (A.from === B.from || A.from === B.to) ? A.from : A.to;
      interiorNodes.push({ node: shared, reach: reachAt.get(shared) ?? 0 });
    }
    chains.push({
      edgeIds: run,
      anchorA, anchorB,
      arc: run.reduce((s, eid) => s + infos.get(eid)!.arc, 0),
      interiorNodes,
    });
  }
  return chains;
}
