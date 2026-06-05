import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitHighRouteNodes } from './ghostNodes';
import type { TransitGraph, GraphEdge } from './types';

function makeHubGraph(centerId: string, routeIds: string[]): TransitGraph {
  // Central node with one neighbour per route; only the centre has many routes,
  // each neighbour has exactly one route. Exercises center-only splitting.
  const nodes = new Map();
  nodes.set(centerId, { id: centerId, label: centerId, pos: [0, 0], lngLat: [0, 0] });
  const edges: GraphEdge[] = [];
  const adj = new Map<string, string[]>();
  adj.set(centerId, []);
  routeIds.forEach((rid, i) => {
    const nid = 'n' + i;
    nodes.set(nid, {
      id: nid,
      label: nid,
      pos: [
        Math.cos((i * 2 * Math.PI) / routeIds.length) * 100,
        Math.sin((i * 2 * Math.PI) / routeIds.length) * 100,
      ],
      lngLat: [0, 0],
    });
    adj.set(nid, []);
    edges.push({
      id: 'e' + i,
      from: centerId,
      to: nid,
      lines: [{ id: rid, label: rid, color: '#000' }],
      stops: new Map([[rid, { atFrom: true, atTo: true }]]),
    });
  });
  for (const e of edges) {
    adj.get(e.from)!.push(e.id);
    adj.get(e.to)!.push(e.id);
  }
  const lineTraversals = new Map();
  edges.forEach((e, i) =>
    lineTraversals.set(routeIds[i], [{ edgeId: e.id, reversed: false }]),
  );
  return { nodes, edges, adj, lineTraversals };
}

test('a low-route station is not split', () => {
  const g = makeHubGraph('center', ['L1', 'L2']);
  const out = splitHighRouteNodes(g, { maxRoutesPerGhost: 4, ghostSpacing: 10 });
  assert.equal(out.graph.nodes.size, g.nodes.size);
  assert.equal(out.ghostConnectors.length, 0);
});

test('a high-route station splits into ghosts; ghost count = ceil(routes / max)', () => {
  const g = makeHubGraph('center', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  const out = splitHighRouteNodes(g, { maxRoutesPerGhost: 3, ghostSpacing: 10 });
  // 7 routes / 3 per ghost = ceil(7/3) = 3 ghosts
  const ghostIds = [...out.graph.nodes.keys()].filter((k) => k.startsWith('center__g'));
  assert.equal(ghostIds.length, 3);
  // Original center is removed.
  assert.ok(!out.graph.nodes.has('center'));
  // Two connector pairs between three siblings.
  assert.equal(out.ghostConnectors.length, 2);
});

test('every line traversal still resolves to a valid edge after splitting', () => {
  const g = makeHubGraph('center', ['L1', 'L2', 'L3', 'L4', 'L5']);
  const out = splitHighRouteNodes(g, { maxRoutesPerGhost: 2, ghostSpacing: 10 });
  const edgeIds = new Set(out.graph.edges.map((e) => e.id));
  for (const traversal of out.graph.lineTraversals.values()) {
    for (const step of traversal) {
      assert.ok(edgeIds.has(step.edgeId), `traversal references unknown edge ${step.edgeId}`);
    }
  }
});

test('each ghost holds at most maxRoutesPerGhost distinct routes', () => {
  const g = makeHubGraph('center', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']);
  const max = 3;
  const out = splitHighRouteNodes(g, { maxRoutesPerGhost: max, ghostSpacing: 10 });
  const ghostRoutes = new Map<string, Set<string>>();
  for (const e of out.graph.edges) {
    for (const nodeId of [e.from, e.to] as const) {
      if (!nodeId.startsWith('center__g')) continue;
      let s = ghostRoutes.get(nodeId);
      if (!s) {
        s = new Set();
        ghostRoutes.set(nodeId, s);
      }
      for (const l of e.lines) s.add(l.id);
    }
  }
  for (const [id, routes] of ghostRoutes) {
    assert.ok(routes.size <= max, `ghost ${id} has ${routes.size} routes (max ${max})`);
  }
});
