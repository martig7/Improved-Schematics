import type { Layout, LayoutEdge } from './types';
import { desiredOrdersAtNode, type IncidentEdge } from './nodePlanar';
import { inversions } from './crossings';

/** Exit direction of an edge's first segment leaving `node`, from its grid/pixel
 *  path. Points away from the node along the edge. */
function exitDir(edge: LayoutEdge, node: string): [number, number] {
  const pts = edge.path;
  if (pts.length < 2) return [1, 0];
  if (edge.from === node) {
    const dx = pts[1][0] - pts[0][0];
    const dy = pts[1][1] - pts[0][1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }
  const a = pts[pts.length - 1];
  const b = pts[pts.length - 2];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/** For a node, the pair of edges each through-line uses (second = null when the
 *  line terminates at the node). */
function lineEdgePairs(incident: LayoutEdge[]): Map<string, [string, string | null]> {
  const byLine = new Map<string, string[]>();
  for (const e of incident) {
    for (const l of e.lines) {
      if (!byLine.has(l.id)) byLine.set(l.id, []);
      byLine.get(l.id)!.push(e.id);
    }
  }
  const out = new Map<string, [string, string | null]>();
  for (const [l, eids] of byLine) out.set(l, [eids[0], eids[1] ?? null]);
  return out;
}

/** Does an incident edge have an interior bend far enough from `node` to absorb a
 *  swap clear of the marker window? Arc to the nearest interior vertex must clear
 *  CHAIN_ARC_LIMIT (24) + the swap half-window (6) ≈ 30px from the station end. */
const SWAP_CLEAR = 30;
function hasAbsorbingBend(edge: LayoutEdge, node: string): boolean {
  const pts = edge.path;
  if (pts.length < 3) return false; // straight edge, no interior bend
  // Walk arc length from the station end inward; an interior vertex past SWAP_CLEAR
  // (and not the far endpoint) can host the swap clear of the marker.
  const ordered = edge.from === node ? pts : [...pts].reverse();
  let acc = 0;
  for (let i = 1; i < ordered.length - 1; i++) {
    acc += Math.hypot(ordered[i][0] - ordered[i - 1][0], ordered[i][1] - ordered[i - 1][1]);
    if (acc >= SWAP_CLEAR) return true;
  }
  return false;
}

/** Minimal-intervention per-segment line ordering (spec 2026-06-13, revised after
 *  measurement). Keep untangle's stable per-edge order EVERYWHERE by default —
 *  byte-identical corridors to v0.2.45 — and ONLY planarize nodes that carry a
 *  station marker, relocating the within-bundle braid that would sit on the marker
 *  onto an adjacent bend. A station end only adopts the planar order when it both
 *  (a) actually differs from lineOrder (else it is a no-op) and (b) has an incident
 *  bend that can absorb the swap clear of the marker window — otherwise the node is
 *  left as-is (no regression; the crossing stays a single clean node crossing, which
 *  for separate bundles crossing is exactly what we want). Run AFTER untangleLineOrder.
 *  Keeps edge.lineOrder === orderFrom so computeCanonicalOffsets is unaffected. */
export function assignEndpointOrders(layout: Layout): void {
  // Station-marker nodes: a node carries a marker iff some incident edge flags a
  // stop at that node's end. edge.stops is derived (topo stopAt) from the same
  // re-homed support node as the rendered per-line dots, so this set == where dots
  // land. (renderGeographic supportToLayout; topo buildSupportGraph.)
  const stationNodes = new Set<string>();
  for (const e of layout.edges) {
    for (const stop of e.stops.values()) {
      if (stop.atFrom) stationNodes.add(e.from);
      if (stop.atTo) stationNodes.add(e.to);
    }
  }

  const incidentOf = new Map<string, LayoutEdge[]>();
  for (const e of layout.edges) {
    if (!incidentOf.has(e.from)) incidentOf.set(e.from, []);
    if (!incidentOf.has(e.to)) incidentOf.set(e.to, []);
    incidentOf.get(e.from)!.push(e);
    incidentOf.get(e.to)!.push(e);
  }

  const nonPlanar = new Set<string>();
  // nodeOrders[nodeId] = Map<edgeId, planar order in edge from->to frame> for the
  // station nodes we actually adopt. Absent entries fall back to lineOrder.
  const nodeOrders = new Map<string, Map<string, string[]>>();

  for (const [nodeId, incident] of [...incidentOf.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!stationNodes.has(nodeId)) continue; // only station markers get planarized
    const incEdges: IncidentEdge[] = incident.map((e) => ({
      id: e.id,
      nodeIsFrom: e.from === nodeId,
      dir: exitDir(e, nodeId),
      lines: e.lineOrder.filter((l) => e.lines.some((x) => x.id === l)),
    }));
    const lineEdges = lineEdgePairs(incident);
    const res = desiredOrdersAtNode(incEdges, lineEdges);
    if (!res.planar) nonPlanar.add(nodeId);

    // Gate per incident edge: adopt the planar order at this station end only when
    // it differs from lineOrder (a real reorder) AND a bend can absorb the swap
    // clear of the marker. Otherwise keep lineOrder (no manufactured stub knot).
    const adopt = new Map<string, string[]>();
    for (const e of incident) {
      const planar = res.orderAtNode.get(e.id);
      const seed = e.lineOrder.filter((l) => e.lines.some((x) => x.id === l));
      if (!planar) continue;
      if (inversions(seed, planar) === 0) continue; // no-op
      if (!hasAbsorbingBend(e, nodeId)) continue; // nowhere clear to put the swap
      adopt.set(e.id, planar);
    }
    if (adopt.size > 0) nodeOrders.set(nodeId, adopt);
  }

  for (const e of layout.edges) {
    const fromOrd = nodeOrders.get(e.from)?.get(e.id);
    const toOrd = nodeOrders.get(e.to)?.get(e.id);
    e.orderFrom = fromOrd ? [...fromOrd] : [...e.lineOrder];
    e.orderTo = toOrd ? [...toOrd] : [...e.lineOrder];
    // Keep lineOrder authoritative for offsets.ts = the from endpoint order.
    e.lineOrder = [...e.orderFrom];
  }

  layout.nonPlanarNodes = nonPlanar;
}
