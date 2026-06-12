// LOOM line-ordering optimization ("untangle"), ported from loom/optim:
// decide, per corridor, the lateral order of its lines so that line pairs
// cross and separate as little as possible at nodes. Replaces the
// position-blind barycenter pass (lineOrder.ts) as the final word on
// edge.lineOrder — that pass averages direction-relative indices and cannot
// even see crossings.
//
// Model (OptGraph): maximal runs of layout edges through degree-2 nodes with
// IDENTICAL line sets collapse into single opt edges, each holding ONE
// ordering — orderings only change at junctions and service boundaries.
// Score (OptGraphScorer): at each node, count
//   - same-segment crossings: line pairs shared by two incident edges whose
//     relative order flips across the node (rank inversions, orientation
//     normalized — continuing through a node MIRRORS the order),
//   - diff-segment crossings (deg > 2): lines of one edge fanning out to the
//     other edges in a rotational order that contradicts the edge's own
//     lateral order (inversions against the clockwise sweep),
//   - separations: line pairs adjacent on one edge but pulled > 1 apart on
//     the other.
// A pair only counts when the line actually CONNECTS through the node
// between the two edges — derived exactly from lineTraversals (LOOM's
// connOccurs). Optimizer (CombNoILPOptimizer chain): per connected
// component — trivial when max cardinality is 1, exhaustive when the
// solution space is < 500, else hill climbing over pair swaps (LOOM
// HillClimbOptimizer: apply the single best improving swap, repeat).

import type { Layout, LayoutEdge } from './types';

interface OptPart {
  edge: LayoutEdge;
  /** part is traversed against the opt edge's canonical from→to direction */
  rev: boolean;
}

interface OptEdge {
  id: number;
  from: string;
  to: string;
  parts: OptPart[];
  lines: string[]; // identical set across parts
  /** Y/dogbone rewrite: stacked siblings share the same parts (one physical
   *  trunk) and compose at write-back in stackIdx order (canonical from->to
   *  lateral frame). The side is locked by junction geometry. */
  stackGroup?: number;
  stackIdx?: number;
}

/** LOOM's shipped penalty defaults (LoomConfig.h / LoomMain.cpp). */
export interface UntanglePens {
  sameSegCrossPen: number;
  diffSegCrossPen: number;
  splitPen: number;
  inStatCrossPenSameSeg: number;
  inStatCrossPenDiffSeg: number;
  inStatSplitPen: number;
  /** NOT in LOOM: penalty per excess same-color boundary in an edge order.
   *  Same-color service families (express/local pairs: 1/2/3/4 all red)
   *  should ride adjacent — splitting a family is usually crossing-NEUTRAL,
   *  so the LOOM objectives alone break these ties arbitrarily (the 1
   *  stranded east of the blue trunk at 22 St). Raised in v0.2.29 (user
   *  rule: never break a bundle to thread a foreign line through it — the
   *  9 splitting the greens at Flatbush) — a family breakup now outweighs
   *  a corner crossing. */
  colorFragPen: number;
}

export const DEFAULT_UNTANGLE_PENS: UntanglePens = {
  sameSegCrossPen: 4,
  diffSegCrossPen: 1,
  splitPen: 3,
  inStatCrossPenSameSeg: 12,
  inStatCrossPenDiffSeg: 3,
  inStatSplitPen: 9,
  colorFragPen: 2.5,
};

const EXHAUSTIVE_SOL_SPACE = 500; // LOOM CombNoILPOptimizer threshold

/** Corner weighting for same-segment crossing penalties (user rule:
 *  crossings prefer corners; in-bundle crossings WITHOUT a bend are all but
 *  disallowed). `dot` is the dot product of the two unit tangents pointing
 *  AWAY from the node — continuing straight through means opposite tangents
 *  (dot -> -1, heavily punished); a 45° bend halves the base price; a 90°+
 *  corner makes the swap nearly free (the turn's own rotation absorbs the
 *  crossing, like the 2/3 cross on the real NYC map). */
export const cornerTurnFactor = (dot: number): number =>
  dot < -0.92 ? 6 : dot < -0.38 ? 0.5 : 0.15;

function inversions(a: number[]): number {
  let inv = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) inv++;
  }
  return inv;
}

export interface UntangleOpts {
  /** Nodes whose marker (mega-station box) visually covers the junction:
   *  crossings and separations there are hidden under the box, so they cost
   *  nothing (user rule) — the optimizer prefers moving unavoidable
   *  crossings inside boxes instead of exposing them on open track. */
  freeCrossNodes?: Set<string>;
}

export function untangleLineOrder(layout: Layout, opts: UntangleOpts = {}): void {
  const freeCross = opts.freeCrossNodes ?? new Set<string>();
  const edges = layout.edges.filter((e) => e.from !== e.to && e.lines.length > 0);
  if (edges.length === 0) return;

  const colorOf = new Map<string, string>();
  for (const e of edges) for (const l of e.lines) if (!colorOf.has(l.id)) colorOf.set(l.id, l.color);

  // ---- layout adjacency + degrees -------------------------------------------
  const incident = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    if (!incident.has(e.from)) incident.set(e.from, []);
    if (!incident.has(e.to)) incident.set(e.to, []);
    incident.get(e.from)!.push(e);
    incident.get(e.to)!.push(e);
  }
  const nodeDeg = (n: string) => incident.get(n)?.length ?? 0;
  const isStation = (n: string) => (layout.nodes.get(n)?.label ?? '') !== '';

  const sameLineSet = (a: LayoutEdge, b: LayoutEdge): boolean => {
    if (a.lines.length !== b.lines.length) return false;
    const s = new Set(a.lines.map((l) => l.id));
    return b.lines.every((l) => s.has(l.id));
  };

  // ---- opt graph: contract deg-2 same-line-set runs --------------------------
  const partOf = new Map<string, OptEdge>(); // layout edge id -> opt edge
  const optEdges: OptEdge[] = [];
  let seq = 0;
  for (const e of edges) {
    if (partOf.has(e.id)) continue;
    // grow a maximal chain from e in both directions
    const parts: OptPart[] = [{ edge: e, rev: false }];
    for (const dir of [0, 1] as const) {
      let nd = dir === 0 ? e.from : e.to;
      let cur = e;
      for (;;) {
        const adj = incident.get(nd) ?? [];
        if (adj.length !== 2) break;
        const next = adj[0] === cur ? adj[1] : adj[0];
        if (next === cur || partOf.has(next.id) || parts.some((p) => p.edge === next)) break;
        if (!sameLineSet(cur, next)) break;
        // orient: walking outward through nd
        const nextRev = dir === 0 ? next.to !== nd : next.from !== nd;
        if (dir === 0) parts.unshift({ edge: next, rev: nextRev });
        else parts.push({ edge: next, rev: nextRev });
        nd = next.from === nd ? next.to : next.from;
        cur = next;
      }
    }
    const first = parts[0];
    const last = parts[parts.length - 1];
    const oe: OptEdge = {
      id: seq++,
      from: first.rev ? first.edge.to : first.edge.from,
      to: last.rev ? last.edge.from : last.edge.to,
      parts,
      lines: e.lines.map((l) => l.id),
    };
    optEdges.push(oe);
    for (const p of parts) partOf.set(p.edge.id, oe);
  }

  const optAdj = new Map<string, OptEdge[]>();
  for (const oe of optEdges) {
    for (const nd of [oe.from, oe.to]) {
      if (!optAdj.has(nd)) optAdj.set(nd, []);
      optAdj.get(nd)!.push(oe);
    }
  }

  // ---- departure angle of an opt edge at a node (corridor scale) -------------
  const TANGENT_WALK = 20; // px; noise-scale tangents mirror orders (octi lesson)
  const angleAt = (oe: OptEdge, nd: string): number => {
    const part = oe.from === nd ? oe.parts[0] : oe.parts[oe.parts.length - 1];
    const e = part.edge;
    const pts = (oe.from === nd) !== part.rev ? e.path : [...e.path].reverse();
    let ref = pts.length > 1 ? pts[pts.length - 1] : pts[0];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc >= TANGENT_WALK) { ref = pts[i]; break; }
    }
    return Math.atan2(ref[1] - pts[0][1], ref[0] - pts[0][0]);
  };

  // ---- LOOM untangle rewrites: Y / dogbone trunk splits -----------------------
  // A deg-3 junction whose trunk line set is the DISJOINT UNION of its two
  // branch sets ("Y") couples the trunk's whole ordering to both branches.
  // Split the trunk into two STACKED parallel opt edges (one per branch
  // set); the lateral side is locked by the branches' angular order at the
  // junction (the diffSweep convention: the first-clockwise branch's lines
  // take the LOW normalized ranks). Branch-bound lines then pre-sort onto
  // the correct side of the trunk and the solution space decomposes. A
  // dogbone (trunk between two such junctions) splits via whichever end
  // matches first; incompatible far-end partitions surface as ordinary
  // scored crossings at the far node.
  let stackSeq = 0;
  const tryY = (nd: string): boolean => {
    const adj = optAdj.get(nd) ?? [];
    if (adj.length !== 3) return false;
    for (let t = 0; t < 3; t++) {
      const em = adj[t];
      if (em.from === em.to || em.stackGroup !== undefined) continue;
      if (em.lines.length < 2) continue;
      const [b1, b2] = adj.filter((x) => x !== em);
      const s1 = new Set(b1.lines);
      const s2 = new Set(b2.lines);
      if (s1.size === 0 || s2.size === 0) continue;
      if (em.lines.length !== s1.size + s2.size) continue;
      if (!em.lines.every((l) => (s1.has(l) ? !s2.has(l) : s2.has(l)))) continue;
      // angular lock: which branch comes first clockwise after the trunk
      const circ = [em, b1, b2]
        .map((oe) => ({ oe, ang: angleAt(oe, nd) }))
        .sort((a, b) => (b.ang - a.ang) || (a.oe.id - b.oe.id))
        .map((x) => x.oe);
      const i = circ.indexOf(em);
      const firstBranch = [...circ.slice(i + 1), ...circ.slice(0, i)][0];
      const lowLines = firstBranch === b1 ? b1.lines : b2.lines;
      const highLines = firstBranch === b1 ? b2.lines : b1.lines;
      // normalized-low ranks = chain indexes 0.. when the trunk LEAVES nd
      const lowIdx = em.from === nd ? 0 : 1;
      const group = stackSeq++;
      const mk = (lines: string[], idx: number): OptEdge => ({
        id: seq++,
        from: em.from,
        to: em.to,
        parts: em.parts,
        lines: [...lines],
        stackGroup: group,
        stackIdx: idx,
      });
      const em1 = mk(lowLines, lowIdx);
      const em2 = mk(highLines, 1 - lowIdx);
      optEdges.splice(optEdges.indexOf(em), 1, em1, em2);
      for (const n2 of new Set([em.from, em.to])) {
        const a = optAdj.get(n2)!;
        a.splice(a.indexOf(em), 1, em1, em2);
      }
      return true;
    }
    return false;
  };
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const nd of [...optAdj.keys()]) if (tryY(nd)) changed = true;
    if (!changed) break;
  }
  const nStacks = stackSeq;

  // ---- corner-aware crossing weights ----------------------------------------
  // Unit tangent of the opt edge's drawn course at node nd, pointing AWAY
  // from nd (taken from the underlying layout edge of the chain that
  // touches nd).
  const tangentAt = (oe: OptEdge, nd: string): [number, number] | null => {
    for (const cand of [oe.parts[0], oe.parts[oe.parts.length - 1]]) {
      const e = cand.edge;
      const path = e.path as unknown as Array<[number, number]>;
      if (!path || path.length < 2) continue;
      if (e.from === nd) {
        const dx = path[1][0] - path[0][0];
        const dy = path[1][1] - path[0][1];
        const len = Math.hypot(dx, dy) || 1;
        return [dx / len, dy / len];
      }
      if (e.to === nd) {
        const dx = path[path.length - 2][0] - path[path.length - 1][0];
        const dy = path[path.length - 2][1] - path[path.length - 1][1];
        const len = Math.hypot(dx, dy) || 1;
        return [dx / len, dy / len];
      }
    }
    return null;
  };
  const cornerCache = new Map<string, number>();
  const cornerFactor = (nd: string, a: OptEdge, b: OptEdge): number => {
    const key = nd + '|' + (a.id < b.id ? a.id + '.' + b.id : b.id + '.' + a.id);
    let f = cornerCache.get(key);
    if (f !== undefined) return f;
    const ta = tangentAt(a, nd);
    const tb = tangentAt(b, nd);
    f = !ta || !tb ? 1 : cornerTurnFactor(ta[0] * tb[0] + ta[1] * tb[1]);
    cornerCache.set(key, f);
    return f;
  };

  // ---- connOccurs from traversals --------------------------------------------
  // (line, node, optEdge pair) actually connected by service. Lines with no
  // traversal connect everywhere (LOOM default when no restrictions exist).
  // Post-rewrite a layout edge can host several STACKED opt edges — resolve
  // by line membership.
  const layoutById = new Map(edges.map((e) => [e.id, e]));
  const optByLayout = new Map<string, OptEdge[]>();
  for (const oe of optEdges) {
    for (const p of oe.parts) {
      if (!optByLayout.has(p.edge.id)) optByLayout.set(p.edge.id, []);
      optByLayout.get(p.edge.id)!.push(oe);
    }
  }
  const optFor = (layoutEdgeId: string, lineId: string): OptEdge | undefined => {
    const lst = optByLayout.get(layoutEdgeId);
    if (!lst) return undefined;
    if (lst.length === 1) return lst[0];
    return lst.find((oe) => oe.lines.includes(lineId)) ?? lst[0];
  };
  const connPairs = new Set<string>();
  const linesWithTrav = new Set<string>();
  const pairKey = (line: string, nd: string, a: number, b: number) =>
    `${line}|${nd}|${a < b ? a + '.' + b : b + '.' + a}`;
  for (const [lineId, steps] of layout.lineTraversals) {
    linesWithTrav.add(lineId);
    for (let i = 1; i < steps.length; i++) {
      const e1 = layoutById.get(steps[i - 1].edgeId);
      const e2 = layoutById.get(steps[i].edgeId);
      if (!e1 || !e2) continue;
      const n1 = steps[i - 1].reversed ? e1.from : e1.to;
      const o1 = optFor(e1.id, lineId);
      const o2 = optFor(e2.id, lineId);
      if (!o1 || !o2 || o1 === o2) continue;
      connPairs.add(pairKey(lineId, n1, o1.id, o2.id));
    }
  }
  const connOccurs = (line: string, nd: string, a: OptEdge, b: OptEdge): boolean =>
    !linesWithTrav.has(line) || connPairs.has(pairKey(line, nd, a.id, b.id));

  // ---- partner lines (LOOM OptGraph::partnerLines) ---------------------------
  // Lines riding IDENTICAL opt-edge sets always travel together: collapse
  // each group to its representative and optimize it as ONE slot — partners
  // can never profit from internal reordering, and as a block they are never
  // separated by a third line (the aesthetic ideal). The block expands in
  // place at write-back. Cardinality often drops to 1, which both shrinks the
  // solution space and decomposes components below.
  const partnerBlock = new Map<string, string[]>(); // representative -> members
  {
    const edgesOfLine = new Map<string, number[]>();
    for (const oe of optEdges) {
      for (const l of oe.lines) {
        if (!edgesOfLine.has(l)) edgesOfLine.set(l, []);
        edgesOfLine.get(l)!.push(oe.id);
      }
    }
    const bySig = new Map<string, string[]>();
    for (const [l, ids] of edgesOfLine) {
      const sig = ids.sort((a, b) => a - b).join('.');
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig)!.push(l);
    }
    const drop = new Set<string>();
    for (const members of bySig.values()) {
      if (members.length < 2) continue;
      members.sort();
      partnerBlock.set(members[0], members);
      for (const m of members.slice(1)) drop.add(m);
    }
    if (drop.size > 0) {
      for (const oe of optEdges) {
        if (oe.lines.some((l) => drop.has(l))) {
          oe.lines = oe.lines.filter((l) => !drop.has(l));
        }
      }
    }
  }

  // ---- circular edge order per node (departure angles, corridor scale) ------
  // Stacked Y-siblings share one physical course (equal angles): break the
  // tie by their lateral stack position at the node (normalized-low side
  // first), so third-edge sweeps read them as the laterally ordered pair
  // they are drawn as.
  const stackTie = (a: OptEdge, b: OptEdge, nd: string): number => {
    if (a.stackGroup === undefined || a.stackGroup !== b.stackGroup) return 0;
    const aLow = a.from === nd ? a.stackIdx! : 1 - a.stackIdx!;
    const bLow = b.from === nd ? b.stackIdx! : 1 - b.stackIdx!;
    return aLow - bLow;
  };
  const circOrder = new Map<string, OptEdge[]>();
  for (const [nd, adj] of optAdj) {
    const entries = adj.map((oe) => ({ oe, ang: angleAt(oe, nd) }));
    entries.sort((a, b) => (b.ang - a.ang) || stackTie(a.oe, b.oe, nd) || (a.oe.id - b.oe.id));
    circOrder.set(nd, entries.map((x) => x.oe));
  }
  const clockwEdges = (ea: OptEdge, nd: string): OptEdge[] => {
    const circ = circOrder.get(nd) ?? [];
    const i = circ.indexOf(ea);
    if (i < 0) return circ.filter((x) => x !== ea);
    return [...circ.slice(i + 1), ...circ.slice(0, i)];
  };

  // ---- scorer (OptGraphScorer port) ------------------------------------------
  type Cfg = Map<number, string[]>; // opt edge id -> line order (canonical dir)
  const maxDeg = Math.max(...[...incident.values()].map((a) => a.length));
  const pens = DEFAULT_UNTANGLE_PENS;
  const inStatCrossPenDegTwo =
    maxDeg * Math.max(pens.sameSegCrossPen, pens.diffSegCrossPen, pens.inStatCrossPenSameSeg, pens.inStatCrossPenDiffSeg);
  const inStatSplitPenDegTwo = maxDeg * Math.max(pens.splitPen, pens.inStatSplitPen);

  const crossPenSameSeg = (nd: string): number => {
    if (freeCross.has(nd)) return 0;
    const deg = nodeDeg(nd);
    if (deg === 1) return 0;
    if (isStation(nd)) {
      if (deg === 2) return inStatCrossPenDegTwo;
      return pens.inStatCrossPenSameSeg * deg;
    }
    return pens.sameSegCrossPen * deg;
  };
  const crossPenDiffSeg = (nd: string): number => {
    if (freeCross.has(nd)) return 0;
    const deg = nodeDeg(nd);
    if (deg === 1) return 0;
    if (isStation(nd)) return pens.inStatCrossPenDiffSeg * deg;
    return pens.diffSegCrossPen * deg;
  };
  const sepPen = (nd: string): number => {
    if (freeCross.has(nd)) return 0;
    const deg = nodeDeg(nd);
    if (deg === 1) return 0;
    if (isStation(nd)) {
      if (deg === 2) return inStatSplitPenDegTwo;
      return pens.inStatSplitPen * deg;
    }
    return pens.splitPen * deg;
  };

  /** same-seg crossings + separations for the ordered pair (ea, eb) at nd. */
  const crossSepsPair = (
    nd: string,
    ea: OptEdge,
    eb: OptEdge,
    cfg: Cfg,
  ): { cross: number; seps: number } => {
    const revA = ea.from !== nd;
    const revB = eb.from !== nd;
    const rev = !(revA !== revB);
    const cea = cfg.get(ea.id)!;
    const ceb = cfg.get(eb.id)!;
    const rank = new Map<string, number>();
    for (let i = 0; i < cea.length; i++) rank.set(cea[i], rev ? cea.length - 1 - i : i);

    const relCross: number[] = [];
    const relSep: number[] = [];
    for (const line of ceb) {
      const r = rank.get(line);
      if (r === undefined || !connOccurs(line, nd, ea, eb)) {
        relSep.push(Number.MAX_SAFE_INTEGER);
        continue;
      }
      relCross.push(r);
      relSep.push(r);
    }
    let seps = 0;
    for (let i = 1; i < relSep.length; i++) {
      const a = relSep[i - 1];
      const b = relSep[i];
      if (a === Number.MAX_SAFE_INTEGER || b === Number.MAX_SAFE_INTEGER) continue;
      if (Math.abs(b - a) > 1) seps++;
    }
    return { cross: inversions(relCross), seps };
  };

  /** diff-seg sweep inversions for ea at nd (clockwise over the other edges). */
  const diffSweep = (nd: string, ea: OptEdge, cfg: Cfg): number => {
    const revA = ea.from !== nd;
    const cea = cfg.get(ea.id)!;
    const rank = new Map<string, number>();
    for (let i = 0; i < cea.length; i++) rank.set(cea[i], revA ? cea.length - 1 - i : i);

    const rel: number[] = [];
    for (const eb of clockwEdges(ea, nd)) {
      const ceb = cfg.get(eb.id)!;
      const revB = eb.from !== nd;
      for (let i = 0; i < ceb.length; i++) {
        const line = ceb[!revB ? ceb.length - 1 - i : i];
        const r = rank.get(line);
        if (r === undefined) continue;
        if (!connOccurs(line, nd, ea, eb)) continue;
        rel.push(r);
      }
    }
    return inversions(rel);
  };

  const nodeScore = (nd: string, cfg: Cfg): number => {
    const adj = optAdj.get(nd) ?? [];
    if (adj.length < 2) return 0;
    let sameDouble = 0; // raw count (feeds the diff-seg correction)
    let sameWeighted = 0; // corner-discounted (feeds the score)
    let seps = 0;
    for (const ea of adj) {
      for (const eb of adj) {
        if (ea === eb) continue;
        const r = crossSepsPair(nd, ea, eb, cfg);
        sameDouble += r.cross;
        sameWeighted += r.cross * cornerFactor(nd, ea, eb);
        seps += r.seps;
      }
    }
    let diff = 0;
    if (adj.length > 2) {
      for (const ea of adj) diff += diffSweep(nd, ea, cfg);
      diff -= sameDouble;
      if (diff < 0) diff = 0;
    }
    return (sameWeighted / 2) * crossPenSameSeg(nd) + diff * crossPenDiffSeg(nd) + seps * sepPen(nd);
  };

  /** Same-color family fragmentation of an edge order: adjacent different-
   *  color boundaries beyond the minimum (distinct colors - 1); zero when
   *  every color forms one contiguous block. Operates on partner-block
   *  representatives — blocks expand contiguously at write-back. */
  const colorFrag = (order: string[]): number => {
    if (order.length < 3) return 0;
    let boundaries = 0;
    const distinct = new Set<string>();
    let prev = '';
    for (let i = 0; i < order.length; i++) {
      const c = colorOf.get(order[i]) ?? '';
      distinct.add(c);
      if (i > 0 && c !== prev) boundaries++;
      prev = c;
    }
    return boundaries - (distinct.size - 1);
  };

  const edgeScore = (oe: OptEdge, cfg: Cfg): number =>
    nodeScore(oe.from, cfg) + nodeScore(oe.to, cfg) +
    pens.colorFragPen * colorFrag(cfg.get(oe.id)!);

  // ---- initial config from current lineOrder ---------------------------------
  const cfg: Cfg = new Map();
  for (const oe of optEdges) {
    const first = oe.parts[0];
    const cur = first.rev ? [...first.edge.lineOrder].reverse() : [...first.edge.lineOrder];
    // ensure exact membership (lineOrder may predate edits)
    const set = new Set(oe.lines);
    const order = cur.filter((l) => set.has(l));
    for (const l of oe.lines) if (!order.includes(l)) order.push(l);
    cfg.set(oe.id, order);
  }

  const DBG =
    typeof process !== 'undefined' &&
    !!(process as { env?: Record<string, string> }).env?.OCTI_DEBUG;
  const tally = (): { same: number; diff: number; seps: number; frag: number } => {
    let same = 0;
    let diff = 0;
    let seps = 0;
    let frag = 0;
    for (const oe of optEdges) frag += colorFrag(cfg.get(oe.id)!);
    for (const nd of optAdj.keys()) {
      const adj = optAdj.get(nd) ?? [];
      if (adj.length < 2) continue;
      let sameDouble = 0;
      for (const ea of adj) {
        for (const eb of adj) {
          if (ea === eb) continue;
          const r = crossSepsPair(nd, ea, eb, cfg);
          sameDouble += r.cross;
          seps += r.seps;
        }
      }
      if (adj.length > 2) {
        let d = 0;
        for (const ea of adj) d += diffSweep(nd, ea, cfg);
        diff += Math.max(0, d - sameDouble);
      }
      same += sameDouble / 2;
    }
    return { same, diff, seps, frag };
  };
  if (DBG) {
    const t = tally();
    console.error(
      `[untangle] optEdges=${optEdges.length} (${nStacks} Y-splits) seed: ` +
      `sameSegCross=${t.same} diffSegCross=${t.diff} seps=${t.seps} colorFrag=${t.frag}`,
    );
  }

  // ---- connected components (LOOM splitSingleLineEdgs, semantically) ---------
  // A cardinality-1 edge has no ordering variables, so it cannot couple its
  // two endpoints — components form over MULTI-line edges only. This is
  // LOOM's single-line edge cut without the graph surgery: the network
  // decomposes into many small components, most of which fall under the
  // exhaustive-solver threshold (global optima instead of one big hill
  // climb). Card-1 edges keep their trivial ordering and still contribute
  // their fixed marks to neighbours' node scores via optAdj.
  const compOf = new Map<number, number>();
  let nComps = 0;
  for (const oe of optEdges) {
    if (oe.lines.length < 2 || compOf.has(oe.id)) continue;
    const comp = nComps++;
    const stack = [oe];
    compOf.set(oe.id, comp);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nd of [cur.from, cur.to]) {
        for (const nb of optAdj.get(nd) ?? []) {
          if (nb.lines.length < 2) continue;
          if (!compOf.has(nb.id)) {
            compOf.set(nb.id, comp);
            stack.push(nb);
          }
        }
      }
    }
  }
  const comps: OptEdge[][] = Array.from({ length: nComps }, () => []);
  for (const oe of optEdges) {
    const c = compOf.get(oe.id);
    if (c !== undefined) comps[c].push(oe);
  }

  const factorial = (n: number): number => {
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
  };
  const permutations = (arr: string[]): string[][] => {
    if (arr.length <= 1) return [arr.slice()];
    const out: string[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
  };

  let nExhaustive = 0;
  let nHillClimb = 0;
  for (const comp of comps) {
    const multi = comp.filter((oe) => oe.lines.length > 1);
    if (multi.length === 0) continue;

    const compNodes = new Set<string>();
    for (const oe of comp) {
      compNodes.add(oe.from);
      compNodes.add(oe.to);
    }
    const compScore = (): number => {
      let s = 0;
      for (const nd of compNodes) s += nodeScore(nd, cfg);
      for (const oe of multi) s += pens.colorFragPen * colorFrag(cfg.get(oe.id)!);
      return s;
    };

    let solSpace = 1;
    for (const oe of multi) {
      solSpace *= factorial(oe.lines.length);
      if (solSpace >= EXHAUSTIVE_SOL_SPACE) break;
    }

    if (solSpace < EXHAUSTIVE_SOL_SPACE) {
      // exhaustive (LOOM ExhaustiveOptimizer)
      nExhaustive++;
      const perms = multi.map((oe) => permutations(cfg.get(oe.id)!));
      const idx = new Array(multi.length).fill(0);
      let best = compScore();
      const bestCfg = multi.map((oe) => cfg.get(oe.id)!.slice());
      for (;;) {
        // advance odometer
        let k = 0;
        while (k < idx.length) {
          idx[k]++;
          if (idx[k] < perms[k].length) break;
          idx[k] = 0;
          k++;
        }
        if (k === idx.length) break;
        for (let i = 0; i < multi.length; i++) cfg.set(multi[i].id, perms[i][idx[i]]);
        const s = compScore();
        if (s < best) {
          best = s;
          for (let i = 0; i < multi.length; i++) bestCfg[i] = perms[i][idx[i]].slice();
        }
      }
      for (let i = 0; i < multi.length; i++) cfg.set(multi[i].id, bestCfg[i]);
    } else {
      // hill climbing (LOOM HillClimbOptimizer): best improving pair swap,
      // PLUS insertion moves (take line out, reinsert at k) — a line
      // stranded on the wrong side of another family can rarely cross it by
      // pairwise swaps (each intermediate state scores worse), but a single
      // insertion jumps it over in one move.
      nHillClimb++;
      const hillClimb = () => {
        for (;;) {
          let bestChange = 0;
          let bestEdge: OptEdge | null = null;
          let bestOrder: string[] | null = null;
          for (const oe of multi) {
            const order = cfg.get(oe.id)!;
            const oldScore = edgeScore(oe, cfg);
            for (let p1 = 0; p1 < order.length; p1++) {
              for (let p2 = p1 + 1; p2 < order.length; p2++) {
                [order[p1], order[p2]] = [order[p2], order[p1]];
                const s = edgeScore(oe, cfg);
                if (oldScore - s > bestChange) {
                  bestChange = oldScore - s;
                  bestEdge = oe;
                  bestOrder = order.slice();
                }
                [order[p1], order[p2]] = [order[p2], order[p1]];
              }
            }
            for (let p1 = 0; p1 < order.length; p1++) {
              for (let p2 = 0; p2 < order.length; p2++) {
                if (p2 === p1 || p2 === p1 + 1) continue; // no-op insertions
                const trial = order.slice();
                const [ln] = trial.splice(p1, 1);
                trial.splice(p2 > p1 ? p2 - 1 : p2, 0, ln);
                cfg.set(oe.id, trial);
                const s = edgeScore(oe, cfg);
                if (oldScore - s > bestChange) {
                  bestChange = oldScore - s;
                  bestEdge = oe;
                  bestOrder = trial;
                }
              }
            }
            cfg.set(oe.id, order);
          }
          if (!bestEdge || !bestOrder) break;
          cfg.set(bestEdge.id, bestOrder);
        }
      };
      // Two-basin search: grouping a color family usually needs the SAME
      // rotation applied across several edges at once — each single-edge
      // step pays same-seg crossings against still-unfixed neighbours, so
      // pair/insertion moves never reach the grouped state from the
      // barycenter seed. Restart the climb from a family-sorted seed
      // (families by mean slot, stable within family): in that basin a
      // family only splits when crossings genuinely pay for it. Keep
      // whichever basin scores better on the full component objective.
      const famSortOf = (order: string[]): string[] => {
        const famMean = new Map<string, { sum: number; n: number }>();
        order.forEach((l, i) => {
          const c = colorOf.get(l) ?? '';
          const f = famMean.get(c) ?? { sum: 0, n: 0 };
          f.sum += i;
          f.n++;
          famMean.set(c, f);
        });
        const pos = new Map(order.map((l, i) => [l, i]));
        return order.slice().sort((a, b) => {
          const ca = colorOf.get(a) ?? '';
          const cb = colorOf.get(b) ?? '';
          if (ca !== cb) {
            const fa = famMean.get(ca)!;
            const fb = famMean.get(cb)!;
            return fa.sum / fa.n - fb.sum / fb.n;
          }
          return pos.get(a)! - pos.get(b)!;
        });
      };
      hillClimb();
      const scoreA = compScore();
      const snapA = new Map(multi.map((oe) => [oe.id, cfg.get(oe.id)!.slice()]));
      for (const oe of multi) cfg.set(oe.id, famSortOf(cfg.get(oe.id)!));
      hillClimb();
      const scoreB = compScore();
      const keptFamilyBasin = scoreB <= scoreA;
      if (!keptFamilyBasin) for (const [id, ord] of snapA) cfg.set(id, ord);
      if (DBG) {
        const lbls = [...compNodes].map((n) => layout.nodes.get(n)?.label).filter(Boolean);
        let f = 0;
        for (const oe of multi) f += colorFrag(cfg.get(oe.id)!);
        console.error(
          `[untangle] hill comp: ${multi.length} multi-edges, basins ${scoreA.toFixed(1)}/${scoreB.toFixed(1)} ` +
          `kept=${keptFamilyBasin ? 'family' : 'barycenter'}, frag=${f}, ` +
          `stations: ${lbls.slice(0, 6).join(', ')}${lbls.length > 6 ? '…' : ''}`,
        );
      }
    }
  }

  // ---- write back (partner blocks expand in place; stacks compose) -----------
  const expand = (order: string[]): string[] => {
    const out: string[] = [];
    for (const l of order) {
      const block = partnerBlock.get(l);
      if (block) out.push(...block);
      else out.push(l);
    }
    return out;
  };
  const stackMembers = new Map<number, OptEdge[]>();
  for (const oe of optEdges) {
    if (oe.stackGroup === undefined) continue;
    if (!stackMembers.has(oe.stackGroup)) stackMembers.set(oe.stackGroup, []);
    stackMembers.get(oe.stackGroup)!.push(oe);
  }
  for (const oe of optEdges) {
    if (oe.stackGroup !== undefined) continue; // composed below
    const expanded = expand(cfg.get(oe.id)!);
    for (const part of oe.parts) {
      part.edge.lineOrder = part.rev ? [...expanded].reverse() : [...expanded];
    }
  }
  for (const sibs of stackMembers.values()) {
    sibs.sort((a, b) => a.stackIdx! - b.stackIdx!);
    const chainOrder = sibs.flatMap((s) => expand(cfg.get(s.id)!));
    for (const part of sibs[0].parts) {
      part.edge.lineOrder = part.rev ? [...chainOrder].reverse() : [...chainOrder];
    }
  }

  if (DBG) {
    const t = tally();
    console.error(
      `[untangle] comps=${nComps} (${nExhaustive} exhaustive, ${nHillClimb} hill) ` +
      `partners=${partnerBlock.size} final: sameSegCross=${t.same} diffSegCross=${t.diff} seps=${t.seps} colorFrag=${t.frag}`,
    );
  }
}
