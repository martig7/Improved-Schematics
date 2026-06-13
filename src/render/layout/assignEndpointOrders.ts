import type { Layout, LayoutEdge } from './types';
import { desiredOrdersAtNode, type IncidentEdge } from './nodePlanar';

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

/** Compute planar endpoint orders for every edge. Run AFTER untangleLineOrder.
 *  Sets edge.orderFrom / edge.orderTo; keeps edge.lineOrder === orderFrom so
 *  computeCanonicalOffsets' global offsets are unchanged. Records non-planar
 *  nodes in layout.nonPlanarNodes. */
export function assignEndpointOrders(layout: Layout): void {
  const incidentOf = new Map<string, LayoutEdge[]>();
  for (const e of layout.edges) {
    if (!incidentOf.has(e.from)) incidentOf.set(e.from, []);
    if (!incidentOf.has(e.to)) incidentOf.set(e.to, []);
    incidentOf.get(e.from)!.push(e);
    incidentOf.get(e.to)!.push(e);
  }

  const nonPlanar = new Set<string>();
  // nodeOrders[nodeId] = Map<edgeId, desired order in edge from->to frame>
  const nodeOrders = new Map<string, Map<string, string[]>>();

  for (const [nodeId, incident] of [...incidentOf.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const incEdges: IncidentEdge[] = incident.map((e) => ({
      id: e.id,
      nodeIsFrom: e.from === nodeId,
      dir: exitDir(e, nodeId),
      // Drawn lines here in the edge's current lineOrder (the stable seed).
      lines: e.lineOrder.filter((l) => e.lines.some((x) => x.id === l)),
    }));
    const lineEdges = lineEdgePairs(incident);
    const res = desiredOrdersAtNode(incEdges, lineEdges);
    if (!res.planar) nonPlanar.add(nodeId);
    nodeOrders.set(nodeId, res.orderAtNode);
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
