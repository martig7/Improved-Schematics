// Ghost-node splitting for high-route station groups.
//
// Inspired by Bast/Brosi/Storandt section 2 (node splitting for high-degree
// nodes). When a station group has too many routes passing through it, the
// canonical-offset bundler fans them all into one wide pill. We split such
// nodes into multiple "ghost" station groups, each carrying a subset of the
// routes, positioned in a small cluster perpendicular to the dominant route
// direction. Each ghost gets its own narrower pill and the lanes fan across
// multiple pills instead of cramping into one.
//
// Pure transformation: builds a new TransitGraph from the input one. Downstream
// routing/bundling/rendering proceed unchanged.

import type {
  TransitGraph,
  GraphNode,
  GraphEdge,
  LineRef,
  EdgeStop,
  TraversalStep,
  Pixel,
} from './types';

export interface GhostNodeOptions {
  /** Maximum number of distinct routes one ghost may carry. */
  maxRoutesPerGhost: number;
  /** Spacing between adjacent ghosts of the same original station, in pixels. */
  ghostSpacing: number;
}

export interface GhostNodeResult {
  graph: TransitGraph;
  /** Pairs of (ghost a, ghost b) that share an original station — for the
   *  caller to draw thin "this is one station" connector bars. */
  ghostConnectors: Array<{ from: string; to: string; fromPos: Pixel; toPos: Pixel }>;
  /** originalStationId -> [ghost ids], in cluster order. Lets the caller
   *  merge sibling stop-marks/labels into a single pill so the cluster reads
   *  as one interchange visually. */
  ghostGroups: Map<string, string[]>;
}

/** Count distinct route IDs through each node (union over incident edges). */
function nodeRouteCounts(graph: TransitGraph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    for (const nodeId of [e.from, e.to] as const) {
      let s = out.get(nodeId);
      if (!s) {
        s = new Set<string>();
        out.set(nodeId, s);
      }
      for (const l of e.lines) s.add(l.id);
    }
  }
  return out;
}

/** Average outgoing direction from a node toward its neighbours (unit vector). */
function dominantDirection(graph: TransitGraph, nodeId: string): [number, number] {
  let dx = 0;
  let dy = 0;
  const node = graph.nodes.get(nodeId);
  if (!node) return [1, 0];
  for (const e of graph.edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    const otherId = e.from === nodeId ? e.to : e.from;
    const other = graph.nodes.get(otherId);
    if (!other) continue;
    const vx = other.pos[0] - node.pos[0];
    const vy = other.pos[1] - node.pos[1];
    const len = Math.hypot(vx, vy) || 1;
    dx += vx / len;
    dy += vy / len;
  }
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

export function splitHighRouteNodes(
  graph: TransitGraph,
  opts: GhostNodeOptions,
): GhostNodeResult {
  const counts = nodeRouteCounts(graph);

  // 1. Decide which nodes to split, and how their routes map to ghosts.
  const splitMap = new Map<string, GraphNode[]>();
  const lineToGhost = new Map<string, Map<string, string>>(); // oldNodeId → (lineId → ghostId)
  const ghostConnectors: GhostNodeResult['ghostConnectors'] = [];

  for (const [nodeId, routes] of counts) {
    if (routes.size <= opts.maxRoutesPerGhost) continue;
    const node = graph.nodes.get(nodeId);
    if (!node) continue;

    const k = Math.ceil(routes.size / opts.maxRoutesPerGhost);
    const sortedRoutes = [...routes].sort();

    // Spread the ghosts perpendicular to the dominant route direction.
    const [dx, dy] = dominantDirection(graph, nodeId);
    const px = -dy; // perpendicular
    const py = dx;

    const ghosts: GraphNode[] = [];
    const myMap = new Map<string, string>();
    const chunkSize = Math.ceil(sortedRoutes.length / k);
    for (let i = 0; i < k; i++) {
      const off = (i - (k - 1) / 2) * opts.ghostSpacing;
      const ghost: GraphNode = {
        id: nodeId + '__g' + i,
        // Only the first ghost shows the label to avoid duplicates next to each other.
        label: i === 0 ? node.label : '',
        pos: [node.pos[0] + px * off, node.pos[1] + py * off] as Pixel,
        lngLat: node.lngLat,
      };
      ghosts.push(ghost);
      for (const r of sortedRoutes.slice(i * chunkSize, (i + 1) * chunkSize)) {
        myMap.set(r, ghost.id);
      }
    }
    splitMap.set(nodeId, ghosts);
    lineToGhost.set(nodeId, myMap);

    // Record connectors between sibling ghosts so the caller can draw them.
    for (let i = 0; i < ghosts.length - 1; i++) {
      ghostConnectors.push({
        from: ghosts[i].id,
        to: ghosts[i + 1].id,
        fromPos: ghosts[i].pos,
        toPos: ghosts[i + 1].pos,
      });
    }
  }

  // Short-circuit: nothing to split → return the input graph unchanged.
  if (splitMap.size === 0) return { graph, ghostConnectors: [], ghostGroups: new Map() };

  // Build the original-station → ghost-ids index now that splitting is decided.
  const ghostGroups = new Map<string, string[]>();
  for (const [origId, ghosts] of splitMap) {
    ghostGroups.set(origId, ghosts.map((g) => g.id));
  }

  // 2. Build the new node map.
  const newNodes = new Map<string, GraphNode>();
  for (const [id, n] of graph.nodes) {
    if (splitMap.has(id)) continue;
    newNodes.set(id, n);
  }
  for (const ghosts of splitMap.values()) {
    for (const g of ghosts) newNodes.set(g.id, g);
  }

  // 3. Split each edge incident to a split node into one edge per (ghostFrom, ghostTo) group.
  //    edgeLineMap[oldEdgeId][lineId] = newEdgeId — so we can remap line traversals.
  const newEdges: GraphEdge[] = [];
  const edgeLineMap = new Map<string, Map<string, string>>();
  let edgeCounter = 0;

  for (const e of graph.edges) {
    const fromSplit = splitMap.has(e.from);
    const toSplit = splitMap.has(e.to);
    if (!fromSplit && !toSplit) {
      newEdges.push(e);
      continue;
    }
    interface Group {
      from: string;
      to: string;
      lines: LineRef[];
      stops: Map<string, EdgeStop>;
    }
    const groups = new Map<string, Group>();
    for (const l of e.lines) {
      const newFrom = fromSplit ? lineToGhost.get(e.from)!.get(l.id) ?? e.from : e.from;
      const newTo = toSplit ? lineToGhost.get(e.to)!.get(l.id) ?? e.to : e.to;
      const gk = newFrom + '|' + newTo;
      let g = groups.get(gk);
      if (!g) {
        g = { from: newFrom, to: newTo, lines: [], stops: new Map() };
        groups.set(gk, g);
      }
      g.lines.push(l);
      const stop = e.stops.get(l.id);
      if (stop) g.stops.set(l.id, stop);
    }
    const map = new Map<string, string>();
    for (const g of groups.values()) {
      const newE: GraphEdge = {
        id: 'e' + edgeCounter++ + '_s',
        from: g.from,
        to: g.to,
        lines: g.lines,
        stops: g.stops,
      };
      newEdges.push(newE);
      for (const l of g.lines) map.set(l.id, newE.id);
    }
    edgeLineMap.set(e.id, map);
  }

  // 4. Remap line traversals to point to the right split edge for each line.
  const newLineTraversals = new Map<string, TraversalStep[]>();
  for (const [lineId, steps] of graph.lineTraversals) {
    const out: TraversalStep[] = [];
    for (const step of steps) {
      const remap = edgeLineMap.get(step.edgeId);
      const newId = remap ? remap.get(lineId) ?? step.edgeId : step.edgeId;
      out.push({ edgeId: newId, reversed: step.reversed });
    }
    newLineTraversals.set(lineId, out);
  }

  // 5. Rebuild adjacency.
  const newAdj = new Map<string, string[]>();
  for (const id of newNodes.keys()) newAdj.set(id, []);
  for (const e of newEdges) {
    newAdj.get(e.from)?.push(e.id);
    newAdj.get(e.to)?.push(e.id);
  }

  return {
    graph: {
      nodes: newNodes,
      edges: newEdges,
      adj: newAdj,
      lineTraversals: newLineTraversals,
    },
    ghostConnectors,
    ghostGroups,
  };
}
