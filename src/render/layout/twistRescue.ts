// Same-section twist rescue.
// Bundle-blocks lands every order-changing event at a junction, but a landed
// swap can sit at a node where both sides continue straight through: the node
// connectors then draw a visible X in the middle of an otherwise straight run.
// This pass migrates such a crossing along the shared stretch to the nearest
// node that can absorb it:
//   BRANCH  the two sides stop travelling together (they diverge), so the
//           crossing merges into the divergence fan;
//   TURN    a corner of at least 45 degrees, where the crossing hides in the
//           lane reshuffle of the fillet.
// A branch beats a turn at any distance; arc distance breaks ties within a
// kind, then the lower-id start edge.
//
// The crossing migrates at the granularity that keeps the drawing clean: a
// crossing BETWEEN two co-travel bundles moves the whole contiguous blocks
// (so no line is ever threaded into the middle of a bundle it does not belong
// to, a wedge), while a crossing WITHIN one bundle moves just those two lines
// (which stays inside the bundle, so it cannot wedge either). Migrating whole
// bundles never trades a wedge for a straight-run twist: the block still lands
// clean at the absorb site. Solo lines are singleton bundles, so an ordinary
// single-line twist behaves as the per-line version did. Migration swaps two
// ADJACENT contiguous blocks on every edge walked; a unit that is not a clean
// block on both sides of a node cannot migrate there and is left in place.
// Deterministic: sorted scans, sqrt arc lengths, a dot-product bend threshold
// (no trig), total tie-breaks.

import { envStr, envNum } from '../../env';
import { makeTwistTrace } from './debug/twistRescue.debug';
import { buildCorridors } from './bundleOrder';
import { buildLineCorridorSets, sharedCorridorCount, coTravelComponents } from './coTravel';
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

  // Global co-travel bundle id per line: lines that ride many of the same
  // corridors form one bundle. Empty traversals (unit-test layouts) yield
  // all-singleton bundles, so single-line twists behave exactly as before.
  const cs = buildCorridors(layout);
  const corridorSets = buildLineCorridorSets(layout, cs);
  const strength = sharedCorridorCount(corridorSets);
  const allLines = [...new Set(layout.edges.flatMap((e) => e.lines.map((l) => l.id)))].sort();
  const idRank = new Map(allLines.map((l, i) => [l, i]));
  const minEnv = envNum('OCTI_COTRAVEL_MIN');
  const coTravelMin = Number.isFinite(minEnv) ? minEnv : 3;
  const bundle = coTravelComponents(allLines, strength, (l) => idRank.get(l)!, coTravelMin);
  const bundleOf = (l: string): number => bundle.get(l) ?? -1 - (idRank.get(l) ?? 0);
  const bundleLines = new Map<number, Set<string>>();
  for (const l of allLines) {
    const b = bundleOf(l);
    let s = bundleLines.get(b);
    if (!s) bundleLines.set(b, (s = new Set()));
    s.add(l);
  }
  // the migration unit for a twisted pair: just the two lines when they share
  // a bundle (an intra-bundle crossing, safe to move alone), otherwise the two
  // whole bundles (an inter-bundle crossing, moved as blocks so nothing wedges)
  const unitFor = (u: string, v: string): [Set<string>, Set<string>] =>
    bundleOf(u) === bundleOf(v)
      ? [new Set([u]), new Set([v])]
      : [bundleLines.get(bundleOf(u))!, bundleLines.get(bundleOf(v))!];
  // lines sitting between two members of ONE bundle they are not in (a wedge)
  const wedgesIn = (order: string[]): number => {
    let n = 0;
    for (let i = 1; i + 1 < order.length; i++) {
      const a = bundleOf(order[i - 1]);
      const b = bundleOf(order[i + 1]);
      if (a === b && bundleOf(order[i]) !== a) n++;
    }
    return n;
  };

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

  // --- helpers over a UNIT (a set of line ids) on an edge's lineOrder ---
  const rangeOf = (e: LayoutEdge, U: Set<string>): [number, number] | null => {
    let lo = -1, hi = -1, count = 0;
    for (let i = 0; i < e.lineOrder.length; i++) {
      if (U.has(e.lineOrder[i])) { if (lo < 0) lo = i; hi = i; count++; }
    }
    if (lo < 0) return null;
    return hi - lo + 1 === count ? [lo, hi] : null;
  };
  const carriesBoth = (e: LayoutEdge, Uu: Set<string>, Uv: Set<string>): boolean =>
    rangeOf(e, Uu) !== null && rangeOf(e, Uv) !== null;
  const adjacent = (e: LayoutEdge, Uu: Set<string>, Uv: Set<string>): boolean => {
    const ra = rangeOf(e, Uu), rb = rangeOf(e, Uv);
    if (!ra || !rb) return false;
    return ra[1] + 1 === rb[0] || rb[1] + 1 === ra[0];
  };
  // sign of Uu-before-Uv on e, normalized so two edges at N agree (no crossing)
  // when their signs DIFFER, i.e. a twist reads as equal signs.
  const sAt = (e: LayoutEdge, N: string, Uu: Set<string>, Uv: Set<string>): number =>
    (e.to === N ? 1 : -1) * (rangeOf(e, Uu)![0] < rangeOf(e, Uv)![0] ? 1 : -1);
  // swap two ADJACENT contiguous unit-blocks, each keeping its internal order
  const swap = (e: LayoutEdge, Uu: Set<string>, Uv: Set<string>): void => {
    const ra = rangeOf(e, Uu)!, rb = rangeOf(e, Uv)!;
    const [first, second] = ra[0] < rb[0] ? [ra, rb] : [rb, ra];
    const firstBlock = e.lineOrder.slice(first[0], first[1] + 1);
    const secondBlock = e.lineOrder.slice(second[0], second[1] + 1);
    e.lineOrder.splice(first[0], second[1] - first[0] + 1, ...secondBlock, ...firstBlock);
  };
  const contsAt = (N: string, from: LayoutEdge, Uu: Set<string>, Uv: Set<string>): LayoutEdge[] =>
    (incident.get(N) ?? []).filter((e) => e !== from && carriesBoth(e, Uu, Uv));

  // Walk the Uu|Uv boundary out of `home` through eStart until an absorb site.
  const tryWalk = (home: string, eStart: LayoutEdge, Uu: Set<string>, Uv: Set<string>): Rescue | null => {
    let cur = eStart;
    let entry = home;
    let dist = 0;
    const swaps: LayoutEdge[] = [];
    const visited = new Set<string>([home]);
    for (let steps = 0; steps < MAX_WALK; steps++) {
      if (!adjacent(cur, Uu, Uv)) return null; // a third unit blocks the pass-through
      swaps.push(cur);
      dist += arcLen(cur);
      const far = cur.from === entry ? cur.to : cur.from;
      if (visited.has(far)) return null; // cycled back
      visited.add(far);
      const conts = contsAt(far, cur, Uu, Uv);
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

  // Fixpoint: a migration can UNBLOCK another pair, so scan until a full pass
  // applies nothing. Every applied migration removes one twist and creates
  // none (a branch target draws no crossing; a turn is absorbed; a block swap
  // threads no line), so the loop terminates.
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
              let [Uu, Uv] = unitFor(u, v);
              // when the bundles are not clean blocks on both sides (they
              // interleave here), the block swap cannot apply; fall back to
              // moving just the two lines, but only if that does not strand a
              // line inside a bundle (a wedge) - so a genuine bundle interleave
              // relocates without the SF-style threading.
              const fallback = !carriesBoth(e1, Uu, Uv) || !carriesBoth(e2, Uu, Uv);
              if (fallback) { Uu = new Set([u]); Uv = new Set([v]); }
              if (sAt(e1, N, Uu, Uv) !== sAt(e2, N, Uu, Uv)) continue; // orders agree: no twist
              // the pair must braid N via exactly this edge pair, straight
              if (contsAt(N, e1, Uu, Uv).length !== 1) continue;
              if (bentAtLeast45(e1, e2, N)) continue;
              const win = better(tryWalk(N, e1, Uu, Uv), tryWalk(N, e2, Uu, Uv));
              if (!win) { if (pass === 0) trace(N, u, v, null); continue; }
              if (fallback) {
                let delta = 0;
                for (const e of win.swaps) {
                  delta -= wedgesIn(e.lineOrder);
                  const iu = e.lineOrder.indexOf(u);
                  const iv = e.lineOrder.indexOf(v);
                  const test = [...e.lineOrder];
                  test[iu] = v; test[iv] = u;
                  delta += wedgesIn(test);
                }
                if (delta > 0) { if (pass === 0) trace(N, u, v, null); continue; }
              }
              for (const e of win.swaps) swap(e, Uu, Uv);
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
