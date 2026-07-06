// Bundle-blocks line ordering (spec bundle-blocks-rebuild).
// Structural replacement for the untangle scorer. Corridors carry rigid
// recursive Blocks; the only order-changing events are bundle joins (binary
// side, one-hop pair-ownership lookahead), splits (free when exit-contiguous,
// else minimal planned crossings AT the split), and cycle-closure residuals.
// Residuals always land at a junction. Corridor interiors are deg-2 by
// construction, so every block boundary IS a junction. Same-corridor
// open-track reorders are unrepresentable. Deterministic: sorted iteration,
// quantized atan2 angular ranks, sqrt-only distances, total tie-breaks.
//
// Writes edge.lineOrder in place, as a drop-in alternative to
// untangleLineOrder. Selected by OCTI_ORDER=blocks|loom at the
// renderGeographic call site.

import { makeBlocksTrace, debugBlocks } from './debug/bundleOrder.debug';
import type { Layout, LayoutEdge } from './types';
import {
  type Block,
  flattenBlock,
  mirrorBlock,
  joinBlocks,
  blockLines,
  reorderToGroups,
} from './blockAlgebra';

export interface CorridorPart {
  edge: LayoutEdge;
  /** edge points against the corridor's endA→endB direction */
  rev: boolean;
}

export interface Corridor {
  id: number;
  endA: string;
  endB: string;
  parts: CorridorPart[]; // ordered endA → endB
  lines: string[];       // sorted line ids (identical across parts)
}

export interface CorridorSet {
  corridors: Corridor[];
  byEdge: Map<string, Corridor>;    // layout edge id → corridor
  atNode: Map<string, Corridor[]>;  // endpoint node → incident corridors
}

const lineSetKey = (e: LayoutEdge): string => e.lines.map((l) => l.id).sort().join(' ');

/** Maximal runs of layout edges through degree-2 nodes with IDENTICAL line
 *  sets (the OptGraph contraction, minus any Y rewriting; joins are native
 *  here). Self-loops and line-less edges are excluded. */
export function buildCorridors(layout: Layout): CorridorSet {
  const edges = layout.edges
    .filter((e) => e.from !== e.to && e.lines.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const incident = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    for (const nd of [e.from, e.to]) {
      let a = incident.get(nd);
      if (!a) incident.set(nd, (a = []));
      a.push(e);
    }
  }
  const through = (nd: string): boolean => {
    const inc = incident.get(nd) ?? [];
    return inc.length === 2 && lineSetKey(inc[0]) === lineSetKey(inc[1]);
  };
  const otherEnd = (e: LayoutEdge, nd: string): string => (e.from === nd ? e.to : e.from);
  const used = new Set<string>();
  const corridors: Corridor[] = [];
  let seq = 0;
  for (const e of edges) {
    if (used.has(e.id)) continue;
    used.add(e.id);
    // grow outward from `e` through THROUGH nodes, one direction at a time;
    // each accumulated part is oriented AWAY from the node it was found at
    const walk = (startEdge: LayoutEdge, startNode: string): CorridorPart[] => {
      const acc: CorridorPart[] = [];
      let nd = startNode;
      let prev = startEdge;
      while (through(nd)) {
        const inc = incident.get(nd)!;
        const next = inc[0].id === prev.id ? inc[1] : inc[0];
        if (used.has(next.id)) break; // closed ring of identical edges
        used.add(next.id);
        acc.push({ edge: next, rev: next.to === nd }); // oriented AWAY from nd
        nd = otherEnd(next, nd);
        prev = next;
      }
      return acc;
    };
    const fwd = walk(e, e.to);      // continues past e.to, flowing endA→endB
    const bwdRaw = walk(e, e.from); // flows AWAY from e.from (wrong frame)
    // reverse the backward list and flip each rev so parts flow toward e
    const bwd = bwdRaw.reverse().map((p) => ({ edge: p.edge, rev: !p.rev }));
    const parts = [...bwd, { edge: e, rev: false }, ...fwd];
    const first = parts[0];
    const endA = first.rev ? first.edge.to : first.edge.from;
    const last = parts[parts.length - 1];
    const endB = last.rev ? last.edge.from : last.edge.to;
    corridors.push({ id: seq++, endA, endB, parts, lines: e.lines.map((l) => l.id).sort() });
  }
  const byEdge = new Map<string, Corridor>();
  for (const c of corridors) for (const p of c.parts) byEdge.set(p.edge.id, c);
  const atNode = new Map<string, Corridor[]>();
  for (const c of corridors) {
    for (const nd of [c.endA, c.endB]) {
      let a = atNode.get(nd);
      if (!a) atNode.set(nd, (a = []));
      a.push(c);
    }
  }
  return { corridors, byEdge, atNode };
}

export interface LineFlow {
  from: number | null; // corridor id the line arrives on (null = starts here)
  to: number | null;   // corridor id it leaves on (null = ends here)
}

/** Per junction node: each line's corridor→corridor transition, derived from
 *  lineTraversals. Only corridor ENDPOINT nodes appear; interiors are through
 *  nodes. */
export function classifyFlows(
  layout: Layout,
  cs: CorridorSet,
): Map<string, Map<string, LineFlow>> {
  const flows = new Map<string, Map<string, LineFlow>>();
  // FIRST-write-wins: game routes are ROUND TRIPS. The return leg revisits
  // every node with from/to swapped, and last-write-wins would make lines
  // look like they enter a corridor at BOTH ends, drawing a bundle wider
  // than the line count that weaves at every seam. The outbound leg defines
  // each line's direction consistently; later passes must not flip it.
  const at = (nd: string, line: string): LineFlow => {
    let m = flows.get(nd);
    if (!m) flows.set(nd, (m = new Map()));
    let f = m.get(line);
    if (!f) m.set(line, (f = { from: null, to: null }));
    return f;
  };
  const setFrom = (nd: string, line: string, corr: number): void => {
    const f = at(nd, line);
    if (f.from === null) f.from = corr;
  };
  const setTo = (nd: string, line: string, corr: number): void => {
    const f = at(nd, line);
    if (f.to === null) f.to = corr;
  };
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const sortedTravs = [...layout.lineTraversals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [lineId, steps] of sortedTravs) {
    if (steps.length === 0) continue;
    const first = edgeById.get(steps[0].edgeId);
    if (first) {
      const startNode = steps[0].reversed ? first.to : first.from;
      const c = cs.byEdge.get(first.id);
      if (c && cs.atNode.has(startNode)) setTo(startNode, lineId, c.id);
    }
    for (let i = 1; i < steps.length; i++) {
      const e1 = edgeById.get(steps[i - 1].edgeId);
      const e2 = edgeById.get(steps[i].edgeId);
      if (!e1 || !e2) continue;
      const c1 = cs.byEdge.get(e1.id);
      const c2 = cs.byEdge.get(e2.id);
      if (!c1 || !c2 || c1 === c2) continue; // interior step within one corridor
      const nd = steps[i - 1].reversed ? e1.from : e1.to; // shared node
      setFrom(nd, lineId, c1.id);
      setTo(nd, lineId, c2.id);
    }
    const last = edgeById.get(steps[steps.length - 1].edgeId);
    if (last) {
      const endNode = steps[steps.length - 1].reversed ? last.from : last.to;
      const c = cs.byEdge.get(last.id);
      if (c && cs.atNode.has(endNode)) setFrom(endNode, lineId, c.id);
    }
  }
  return flows;
}

// quantized atan2 angular rank (cross-V8): direction of `c` departing `nd`,
// sampled over ~12px of arc. Corridor-scale sampling is immune to seam
// micro-jogs.
const angleAt = (c: Corridor, nd: string): number => {
  const part = c.endA === nd ? c.parts[0] : c.parts[c.parts.length - 1];
  const path = part.edge.path;
  const pts = part.edge.from === nd ? path : [...path].reverse();
  let dx = pts[1][0] - pts[0][0];
  let dy = pts[1][1] - pts[0][1];
  let hi = 1;
  while (dx * dx + dy * dy < 12 * 12 && hi < pts.length - 1) {
    hi++;
    dx = pts[hi][0] - pts[0][0];
    dy = pts[hi][1] - pts[0][1];
  }
  return Math.round(Math.atan2(dy, dx) * 1e6) / 1e6;
};

// normalize to (-pi, pi], quantized. The wrap-safe frame for relative ranks
const normAngle = (a: number): number => {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return Math.round(a * 1e6) / 1e6;
};

// bearing of `c` departing `nd`, RELATIVE to the walker's facing direction.
// Absolute atan2 mis-ranks exits across the ±pi wrap, so every left/right
// decision at a junction ranks in this relative frame.
const relAngleAt = (c: Corridor, nd: string, facing: number): number =>
  normAngle(angleAt(c, nd) - facing);

// the direction a walker FACES leaving `nd` after arriving along `arrived`
// (angleAt points back along the corridor, so facing is its opposite)
const facingAfter = (arrived: Corridor, nd: string): number =>
  normAngle(angleAt(arrived, nd) + Math.PI);

/** Comparable exit key for a line: walk-relative angular rank of each
 *  successive exit corridor, bounded depth, with the facing carried hop to
 *  hop (structural destination grouping, spec §2.4). Walk-relative keys
 *  make the seed frame-invariant: absolute angles would encode the
 *  corridor's arbitrary endA/endB labeling into the order. */
const exitKeyOf = (
  line: string,
  nd: string,
  facing0: number,
  cs: CorridorSet,
  flows: Map<string, Map<string, LineFlow>>,
  depth: number,
): number[] => {
  const key: number[] = [];
  let node = nd;
  let facing = facing0;
  for (let d = 0; d < depth; d++) {
    const f = flows.get(node)?.get(line);
    const toId = f ? f.to : null;
    if (toId === null || toId === undefined) {
      key.push(Number.MAX_SAFE_INTEGER);
      break;
    }
    const to = cs.corridors[toId];
    key.push(relAngleAt(to, node, facing));
    const far = to.endA === node ? to.endB : to.endA;
    facing = facingAfter(to, far);
    node = far;
  }
  return key;
};

const cmpKeys = (a: number[], b: number[]): number => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : -Infinity;
    const y = i < b.length ? b[i] : -Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** The pipeline: assign a Block to every corridor, then write back. */
export function orderByBlocks(layout: Layout): void {
  const cs = buildCorridors(layout);
  if (cs.corridors.length === 0) return;
  const flows = classifyFlows(layout, cs);

  const blocks = new Map<number, Block>();
  let plannedSwaps = 0; // split-contiguity crossings (at junctions)
  let residualSwaps = 0; // cycle-closure disagreements (at junctions)

  // OCTI_BLOCKS_TRACE=<lineId>: log every derivation event touching a
  // corridor that carries the line (root seeds, slice handoffs, join sides,
  // back-edge disagreements), the blocks-mode analogue of OCTI_TRACE1. tlog
  // self-gates on the traced line; cinfo/lbl format the message strings the
  // call sites build.
  const { tlog, cinfo, lbl } = makeBlocksTrace(layout);

  // seed: flat order by walk-relative exit keys in the LINES' TRAVEL frame
  // (structural destination grouping, no colors, no barycenter), stored
  // mirrored into the corridor's canonical frame when travel opposes it.
  // Keying "toward endB" would bake the arbitrary endA/endB labeling into
  // the physical drawing, so a reversed corridor definition would flip the
  // map. Survives only where propagation never reaches (roots, isolated
  // corridors); majority entry-end decides the frame, ties fall to canonical.
  const seedBlock = (c: Corridor): Block => {
    const ls = [...c.lines];
    let enterA = 0;
    let enterB = 0;
    for (const l of ls) {
      if (flows.get(c.endA)?.get(l)?.to === c.id) enterA++;
      if (flows.get(c.endB)?.get(l)?.to === c.id) enterB++;
    }
    const travelAB = enterA >= enterB; // walk endA→endB
    const exitEnd = travelAB ? c.endB : c.endA;
    const facing0 = facingAfter(c, exitEnd); // travel direction through the exit
    const keys = new Map(ls.map((l) => [l, exitKeyOf(l, exitEnd, facing0, cs, flows, 4)]));
    ls.sort((a, b) => cmpKeys(keys.get(a)!, keys.get(b)!) || (a < b ? -1 : 1));
    return travelAB ? ls : ls.reverse(); // canonical storage frame
  };

  const bfsOrder = [...cs.corridors].sort(
    (a, b) => (b.lines.length - a.lines.length) || (a.id - b.id),
  );
  const visited = new Set<number>();

  /** Join side by pair-ownership lookahead (spec §2.1). The WALK reasons
   *  entirely in the travel frame (walking away from the join); the single
   *  travel→canonical conversion happens at the outer return so the
   *  deterministic fallback is frame-invariant too. An "a-first" verdict
   *  must describe the same PHYSICAL side regardless of which end of the
   *  joined corridor the join landed on. */
  const joinSideLookahead = (
    a: Block,
    b: Block,
    joined: Corridor,
    joinNode: string,
  ): boolean => {
    const bFirstTravel = joinSideLookaheadTravel(a, b, joined, joinNode);
    return joinNode === joined.endB ? !bFirstTravel : bFirstTravel;
  };

  const joinSideLookaheadTravel = (
    a: Block,
    b: Block,
    joined: Corridor,
    joinNode: string,
  ): boolean => {
    const aLines = blockLines(a);
    const bLines = blockLines(b);
    let node = joined.endA === joinNode ? joined.endB : joined.endA;
    let corridor = joined;
    for (let hops = 0; hops < 64; hops++) {
      const ndFlows = flows.get(node);
      if (!ndFlows) break;
      const exitOf = (l: string): number | null => {
        const f = ndFlows.get(l);
        if (!f) return null;
        return f.from === corridor.id ? f.to : null;
      };
      const aExits = new Set<number | null>();
      const bExits = new Set<number | null>();
      for (const l of aLines) aExits.add(exitOf(l));
      for (const l of bLines) bExits.add(exitOf(l));
      const union = new Set<number | null>([...aExits, ...bExits]);
      if (union.size > 1) {
        // rank exits RELATIVE to the walker's facing at the separation node
        // (wrap-safe); the walker arrived along `corridor`
        const facing = facingAfter(corridor, node);
        const rank = (s: Set<number | null>): number => {
          let m = Infinity;
          for (const gid of s) {
            if (gid === null) continue;
            const ang = relAngleAt(cs.corridors[gid], node, facing);
            if (ang < m) m = ang;
          }
          return m;
        };
        const ra = rank(aExits);
        const rb = rank(bExits);
        if (ra === rb) break; // tie (mixing split); fall to the a-first default
        return rb < ra; // TRAVEL-frame verdict; canonical conversion at the wrapper
      }
      const nextArr = [...union];
      const next = nextArr[0];
      if (next === null || next === undefined) break;
      corridor = cs.corridors[next];
      node = corridor.endA === node ? corridor.endB : corridor.endA;
    }
    return false; // deterministic fallback: a-first
  };

  const processJunction = (nd: string, from: Corridor, queue: Corridor[]): void => {
    const ndFlows = flows.get(nd);
    if (!ndFlows) return;
    const fromBlock = blocks.get(from.id);
    if (fromBlock === undefined) return;
    // from's flattened order reading INTO nd
    const atNd = from.endB === nd ? flattenBlock(fromBlock) : flattenBlock(mirrorBlock(fromBlock));
    // partition by exit corridor across nd (only lines that continue)
    const exits = new Map<number, string[]>();
    for (const l of atNd) {
      const f = ndFlows.get(l);
      if (!f) continue;
      const other = f.from === from.id ? f.to : f.to === from.id ? f.from : null;
      if (other === null || other === undefined) continue;
      let arr = exits.get(other);
      if (!arr) exits.set(other, (arr = []));
      arr.push(l);
    }
    if (exits.size === 0) return;

    // SPLIT-FIRST: contiguity plan over the continuing lines. Only when the
    // junction actually DERIVES something (some exit target unvisited). A
    // pure look-back at already-settled neighbours must not resort or count,
    // to avoid phantom planned-crossings.
    let ordered = atNd.filter((l) => {
      const f = ndFlows.get(l);
      if (!f) return false;
      const other = f.from === from.id ? f.to : f.to === from.id ? f.from : null;
      return other !== null && other !== undefined;
    });
    const anyUnvisited = [...exits.keys()].some((gid) => !visited.has(gid));
    if (exits.size >= 2 && anyUnvisited) {
      const groupOf = new Map<string, number>();
      for (const [gid, ls] of exits) for (const l of ls) groupOf.set(l, gid);
      // exits ranked RELATIVE to the walker's facing (wrap-safe)
      const facing = facingAfter(from, nd);
      const ranked = [...exits.keys()].sort(
        (x, y) => relAngleAt(cs.corridors[x], nd, facing) - relAngleAt(cs.corridors[y], nd, facing) || x - y,
      );
      const plan = reorderToGroups(ordered, groupOf, ranked);
      plannedSwaps += plan.swaps;
      ordered = plan.order;
    }

    // THEN JOIN/DERIVE: hand each exit its slice
    for (const [gid, ls] of [...exits.entries()].sort((a, b) => a[0] - b[0])) {
      const to = cs.corridors[gid];
      const lsSet = new Set(ls);
      const slice: Block = ordered.filter((l) => lsSet.has(l));
      // frame rule: `ordered`/`slice` are ALREADY in the node walking frame,
      // since atNd normalized the from side. Only the TO side remains: its
      // canonical frame reads endA→endB, so mirror exactly when the corridor
      // departs nd via its endB (canonical points INTO nd).
      const rev = to.endB === nd;
      const finalSlice: Block = rev ? mirrorBlock(slice) : slice;
      if (!visited.has(to.id)) {
        const existing = blocks.get(to.id);
        if (existing === undefined) {
          blocks.set(to.id, finalSlice);
          tlog(to, `SLICE from ${cinfo(from)} @ ${nd}"${lbl(nd)}" rev=${rev} -> [${flattenBlock(finalSlice).map((l) => l.slice(0, 8)).join(',')}]`);
        } else {
          // Overlap guard: a line already contributed to this block must
          // NEVER join again, because a duplicate slot draws a phantom lane.
          // Overlaps arise from round-trip flow artifacts and
          // partially-overlapping feeders; only genuinely NEW lines join,
          // and a fully-known slice is a pure consistency constraint
          // (disagreements count as residuals, same as a back-edge).
          const have = blockLines(existing);
          const newLines: Block = flattenBlock(finalSlice).filter((l) => !have.has(l));
          if (newLines.length === 0) {
            const haveOrder = flattenBlock(existing).filter((l) => lsSet.has(l));
            const want = flattenBlock(finalSlice);
            const rankW = new Map(want.map((l, i) => [l, i]));
            let inv = 0;
            for (let i = 0; i < haveOrder.length; i++) {
              for (let j = i + 1; j < haveOrder.length; j++) {
                const ri = rankW.get(haveOrder[i]);
                const rj = rankW.get(haveOrder[j]);
                if (ri !== undefined && rj !== undefined && ri > rj) inv++;
              }
            }
            residualSwaps += inv;
            if (inv > 0) tlog(to, `RE-DERIVE from ${cinfo(from)} @ ${nd}"${lbl(nd)}" inv=${inv} (constraint only, no join)`);
          } else {
            const sub: Block = newLines;
            const bFirst = joinSideLookahead(existing, sub, to, nd);
            blocks.set(to.id, joinBlocks(existing, sub, bFirst));
            tlog(to, `JOIN slice from ${cinfo(from)} @ ${nd}"${lbl(nd)}" bFirst=${bFirst} new=${newLines.length}/${flattenBlock(finalSlice).length} -> [${flattenBlock(blocks.get(to.id)!).map((l) => l.slice(0, 8)).join(',')}]`);
          }
        }
        const have = blockLines(blocks.get(to.id)!);
        if (to.lines.every((l) => have.has(l))) {
          visited.add(to.id);
          queue.push(to);
        }
      } else {
        // cycle back-edge: count the disagreement, leave blocks alone. The
        // flip draws across nd, which is a junction, allowed by construction.
        // BOTH sides compared in the NODE walking frame:
        // `slice` is node-frame by construction; `to`'s stored block reads
        // node-frame when flattened canonically at an endA departure and
        // mirrored at an endB departure.
        const b = blocks.get(to.id)!;
        const flat = to.endA === nd ? flattenBlock(b) : flattenBlock(mirrorBlock(b));
        const haveOrder = flat.filter((l) => lsSet.has(l));
        const want = flattenBlock(slice);
        const rankW = new Map(want.map((l, i) => [l, i]));
        let inv = 0;
        for (let i = 0; i < haveOrder.length; i++) {
          for (let j = i + 1; j < haveOrder.length; j++) {
            const ri = rankW.get(haveOrder[i]);
            const rj = rankW.get(haveOrder[j]);
            if (ri !== undefined && rj !== undefined && ri > rj) inv++;
          }
        }
        residualSwaps += inv;
        if (inv > 0) tlog(to, `BACKEDGE from ${cinfo(from)} @ ${nd}"${lbl(nd)}" inv=${inv} have=[${haveOrder.map((l) => l.slice(0, 8)).join(',')}] want=[${want.map((l) => l.slice(0, 8)).join(',')}]`);
      }
    }
  };

  // A corridor must not be force-seeded as a fresh root while it still has a
  // real, unvisited feeder waiting to join into it. Otherwise the seed wins
  // by accident (this corridor gets marked visited before the join arrives),
  // and the genuine feeder is later shunted into the cycle-residual branch
  // instead of the join path (pair-ownership theorem, spec §2.1). A corridor
  // only counts as "no upstream structure" (spec §2.4) when every line of
  // its own either starts there or arrives from an ALREADY-visited corridor.
  const hasPendingFeeder = (c: Corridor): boolean => {
    for (const nd of [c.endA, c.endB]) {
      const ndFlows = flows.get(nd);
      if (!ndFlows) continue;
      for (const l of c.lines) {
        const f = ndFlows.get(l);
        if (!f || f.to !== c.id) continue; // not an inbound edge of c at nd
        // f.from === c.id is a round-trip turnaround artifact (the return
        // leg re-enters the corridor it just left at the route origin);
        // a corridor is never its own feeder.
        if (f.from !== null && f.from !== undefined && f.from !== c.id && !visited.has(f.from)) return true;
      }
    }
    return false;
  };

  let remaining = bfsOrder.filter((c) => !visited.has(c.id));
  while (remaining.length > 0) {
    // prefer widest candidates with no pending feeder (genuine sources /
    // already-fed join targets); fall back to the widest overall only when
    // every remaining corridor is still mid-join (pure-cycle components,
    // where some seed must break the symmetry per spec §2.3).
    const root = remaining.find((c) => !hasPendingFeeder(c)) ?? remaining[0];
    blocks.set(root.id, seedBlock(root));
    tlog(root, `ROOT seed -> [${flattenBlock(blocks.get(root.id)!).map((l) => l.slice(0, 8)).join(',')}]`);
    visited.add(root.id);
    const queue: Corridor[] = [root];
    while (queue.length > 0) {
      const c = queue.shift()!;
      processJunction(c.endA, c, queue);
      processJunction(c.endB, c, queue);
    }
    remaining = remaining.filter((c) => !visited.has(c.id));
  }

  // write-back: flatten per corridor, mirror rev parts
  for (const c of cs.corridors) {
    const b = blocks.get(c.id) ?? seedBlock(c);
    const flat = flattenBlock(b);
    for (const p of c.parts) {
      p.edge.lineOrder = p.rev ? [...flat].reverse() : [...flat];
    }
  }

  debugBlocks(layout, cs, flows, plannedSwaps, residualSwaps);
}
