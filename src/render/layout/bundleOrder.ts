// Bundle-blocks line ordering (spec 2026-07-04-bundle-blocks-rebuild):
// structural replacement for the LOOM untangle scorer. Corridors carry rigid
// recursive Blocks; the only order-changing events are bundle joins (binary
// side, one-hop pair-ownership lookahead), splits (free when exit-contiguous,
// else minimal planned crossings AT the split), and cycle-closure residuals
// (always at a junction — corridor interiors are deg-2 by construction, so
// every block boundary IS a junction). Same-corridor open-track reorders are
// unrepresentable. Deterministic: sorted iteration, quantized atan2 angular
// ranks, sqrt-only distances, total tie-breaks.
//
// Writes edge.lineOrder in place — drop-in alternative to untangleLineOrder,
// selected by OCTI_ORDER=blocks|loom at the renderGeographic call site.

import type { Layout, LayoutEdge } from './types';

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
 *  sets (the OptGraph contraction, minus any Y rewriting — joins are native
 *  here). Self-loops and line-less edges are excluded, like untangle. */
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
 *  lineTraversals (the same flow derivation as untangle's connOccurs). Only
 *  corridor ENDPOINT nodes appear — interiors are through nodes. */
export function classifyFlows(
  layout: Layout,
  cs: CorridorSet,
): Map<string, Map<string, LineFlow>> {
  const flows = new Map<string, Map<string, LineFlow>>();
  const at = (nd: string, line: string): LineFlow => {
    let m = flows.get(nd);
    if (!m) flows.set(nd, (m = new Map()));
    let f = m.get(line);
    if (!f) m.set(line, (f = { from: null, to: null }));
    return f;
  };
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const sortedTravs = [...layout.lineTraversals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [lineId, steps] of sortedTravs) {
    if (steps.length === 0) continue;
    const first = edgeById.get(steps[0].edgeId);
    if (first) {
      const startNode = steps[0].reversed ? first.to : first.from;
      const c = cs.byEdge.get(first.id);
      if (c && cs.atNode.has(startNode)) at(startNode, lineId).to = c.id;
    }
    for (let i = 1; i < steps.length; i++) {
      const e1 = edgeById.get(steps[i - 1].edgeId);
      const e2 = edgeById.get(steps[i].edgeId);
      if (!e1 || !e2) continue;
      const c1 = cs.byEdge.get(e1.id);
      const c2 = cs.byEdge.get(e2.id);
      if (!c1 || !c2 || c1 === c2) continue; // interior step within one corridor
      const nd = steps[i - 1].reversed ? e1.from : e1.to; // shared node
      at(nd, lineId).from = c1.id;
      at(nd, lineId).to = c2.id;
    }
    const last = edgeById.get(steps[steps.length - 1].edgeId);
    if (last) {
      const endNode = steps[steps.length - 1].reversed ? last.from : last.to;
      const c = cs.byEdge.get(last.id);
      if (c && cs.atNode.has(endNode)) at(endNode, lineId).from = c.id;
    }
  }
  return flows;
}
