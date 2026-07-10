// Same-section twist rescue.
// Bundle-blocks lands every order-changing event at a junction, but a landed
// swap can sit at a node where both lines continue straight through: the node
// connectors then draw a visible X in the middle of an otherwise straight
// run. This pass migrates such a crossing along the pair's co-bundled stretch
// to the nearest node that can absorb it:
//   BRANCH  the pair stops travelling together (one line leaves or ends), so
//           the swap merges into the divergence fan;
//   TURN    a corner of at least 45 degrees, where the crossing hides in the
//           lane reshuffle of the fillet.
// A branch beats a turn at any distance; arc distance breaks ties within a
// kind, then the lower-id start edge. The crossing moves by swapping the pair
// on every edge walked, which is legal only while the pair is ADJACENT in
// each edge's order: an adjacent transposition changes no other pair's
// relative order anywhere, so the rescue cannot create crossings between
// other lines. A direction that loses adjacency, meets an ambiguous carrier
// fan, or cycles back fails; if both directions fail the twist stays put.
// Deterministic: sorted scans, sqrt arc lengths, a dot-product bend
// threshold (no trig), and total tie-breaks.

import { envStr } from '../../env';
import { makeTwistTrace } from './debug/twistRescue.debug';
import type { Layout, LayoutEdge } from './types';

const COS45 = Math.SQRT1_2;
const MAX_WALK = 64; // edges; a runaway-loop backstop far above any real stretch

interface Rescue {
  kind: 'branch' | 'turn';
  dist: number;
  swaps: LayoutEdge[];
  target: string;
}

export function rescueTwists(layout: Layout): void {
  if (envStr('OCTI_TWIST_RESCUE') === '0') return;
  const trace = makeTwistTrace();
  const edges = layout.edges.filter((e) => e.from !== e.to && e.lines.length > 0);
  const incident = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    for (const nd of [e.from, e.to]) {
      let a = incident.get(nd);
      if (!a) incident.set(nd, (a = []));
      a.push(e);
    }
  }
  for (const arr of incident.values()) arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const relSign = (e: LayoutEdge, u: string, v: string): number =>
    e.lineOrder.indexOf(u) < e.lineOrder.indexOf(v) ? 1 : -1;
  // The pair's order across a node, normalized to one handedness: two edges
  // meeting at N agree (no crossing) when their signs DIFFER, so a twist
  // reads as equal signs.
  const sAt = (e: LayoutEdge, N: string, u: string, v: string): number =>
    (e.to === N ? 1 : -1) * relSign(e, u, v);
  const adjacent = (e: LayoutEdge, u: string, v: string): boolean =>
    Math.abs(e.lineOrder.indexOf(u) - e.lineOrder.indexOf(v)) === 1;
  const swapPair = (e: LayoutEdge, u: string, v: string): void => {
    const iu = e.lineOrder.indexOf(u);
    const iv = e.lineOrder.indexOf(v);
    e.lineOrder[iu] = v;
    e.lineOrder[iv] = u;
  };
  const carriesBoth = (e: LayoutEdge, u: string, v: string): boolean =>
    e.lineOrder.includes(u) && e.lineOrder.includes(v);
  const contsAt = (N: string, from: LayoutEdge, u: string, v: string): LayoutEdge[] =>
    (incident.get(N) ?? []).filter((e) => e !== from && carriesBoth(e, u, v));
  // Unit direction of the first path step leaving N along e.
  const dirFrom = (e: LayoutEdge, N: string): [number, number] | null => {
    const p = e.path;
    if (!p || p.length < 2) return null;
    const a = e.from === N ? p[0] : p[p.length - 1];
    const b = e.from === N ? p[1] : p[p.length - 2];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return null;
    return [dx / len, dy / len];
  };
  // Bend between arriving along eIn and departing along eOut at N. cos(bend)
  // is minus the dot of the two leaving directions; bend >= 45deg absorbs.
  const bentAtLeast45 = (eIn: LayoutEdge, eOut: LayoutEdge, N: string): boolean => {
    const d1 = dirFrom(eIn, N);
    const d2 = dirFrom(eOut, N);
    if (!d1 || !d2) return false;
    return -(d1[0] * d2[0] + d1[1] * d2[1]) <= COS45 + 1e-9;
  };
  const arcLen = (e: LayoutEdge): number => {
    let s = 0;
    for (let k = 1; k < e.path.length; k++) {
      const dx = e.path[k][0] - e.path[k - 1][0];
      const dy = e.path[k][1] - e.path[k - 1][1];
      s += Math.sqrt(dx * dx + dy * dy);
    }
    return s;
  };

  // Walk the crossing out of `home` through eStart until an absorb site.
  const tryWalk = (home: string, eStart: LayoutEdge, u: string, v: string): Rescue | null => {
    let cur = eStart;
    let entry = home;
    let dist = 0;
    const swaps: LayoutEdge[] = [];
    const visited = new Set<string>([home]);
    for (let steps = 0; steps < MAX_WALK; steps++) {
      if (!adjacent(cur, u, v)) return null; // a line between the pair blocks the pass-through
      swaps.push(cur);
      dist += arcLen(cur);
      const far = cur.from === entry ? cur.to : cur.from;
      if (visited.has(far)) return null; // cycled back
      visited.add(far);
      const conts = contsAt(far, cur, u, v);
      if (conts.length === 0) return { kind: 'branch', dist, swaps, target: far };
      if (conts.length > 1) return null; // ambiguous carrier fan
      if (bentAtLeast45(cur, conts[0], far)) return { kind: 'turn', dist, swaps, target: far };
      cur = conts[0];
      entry = far;
    }
    return null;
  };
  const better = (p: Rescue | null, q: Rescue | null): Rescue | null => {
    if (!p) return q;
    if (!q) return p;
    if (p.kind !== q.kind) return p.kind === 'branch' ? p : q;
    if (p.dist !== q.dist) return p.dist < q.dist ? p : q;
    return p; // e1-side start wins the exact tie
  };

  // Fixpoint: a rescue can UNBLOCK another pair (moving one crossing out of
  // an edge restores adjacency for a pair it separated), so scan until a
  // full pass applies nothing. Every applied rescue removes one twist and
  // creates none (a branch target draws no pairwise crossing; a turn target
  // is absorbed by definition), so the loop terminates.
  const nodes = [...incident.keys()].sort();
  for (let pass = 0; pass < 16; pass++) {
    let applied = false;
    for (const N of nodes) {
      const inc = incident.get(N)!;
      for (let a = 0; a < inc.length; a++) {
        for (let b = a + 1; b < inc.length; b++) {
          const e1 = inc[a];
          const e2 = inc[b];
          const shared = e1.lineOrder.filter((id) => e2.lineOrder.includes(id)).sort();
          if (shared.length < 2) continue;
          for (let x = 0; x < shared.length; x++) {
            for (let y = x + 1; y < shared.length; y++) {
              const u = shared[x];
              const v = shared[y];
              if (sAt(e1, N, u, v) !== sAt(e2, N, u, v)) continue; // orders agree: no twist
              // the pair must travel N via exactly this edge pair, on a
              // straight-through node (a corner already absorbs its crossing)
              if (contsAt(N, e1, u, v).length !== 1) continue;
              if (bentAtLeast45(e1, e2, N)) continue;
              const win = better(tryWalk(N, e1, u, v), tryWalk(N, e2, u, v));
              if (!win) { if (pass === 0) trace(N, u, v, null); continue; }
              for (const e of win.swaps) swapPair(e, u, v);
              trace(N, u, v, win);
              applied = true;
            }
          }
        }
      }
    }
    if (!applied) break;
  }
}
