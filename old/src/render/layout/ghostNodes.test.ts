import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitHighRouteNodes } from './ghostNodes';
import type { TransitGraph, GraphEdge, GraphNode, TraversalStep } from './types';

/** Star graph: one center + one neighbour per supplied angle (radians). Each
 *  edge carries one distinct line (so per-line bookkeeping is unambiguous). */
function makeStar(centerId: string, angles: number[]): TransitGraph {
  const nodes = new Map<string, GraphNode>();
  nodes.set(centerId, { id: centerId, label: centerId, pos: [0, 0], lngLat: [0, 0] });
  const edges: GraphEdge[] = [];
  const adj = new Map<string, string[]>();
  adj.set(centerId, []);
  const r = 100;
  angles.forEach((angle, i) => {
    const nid = 'n' + i;
    nodes.set(nid, {
      id: nid,
      label: nid,
      pos: [Math.cos(angle) * r, Math.sin(angle) * r],
      lngLat: [0, 0],
    });
    adj.set(nid, []);
    edges.push({
      id: 'e' + i,
      from: centerId,
      to: nid,
      lines: [{ id: 'L' + i, label: 'L' + i, color: '#000' }],
      stops: new Map([['L' + i, { atFrom: true, atTo: true }]]),
    });
  });
  for (const e of edges) {
    adj.get(e.from)!.push(e.id);
    adj.get(e.to)!.push(e.id);
  }
  const lineTraversals = new Map<string, TraversalStep[]>();
  edges.forEach((e, i) => lineTraversals.set('L' + i, [{ edgeId: e.id, reversed: false }]));
  return { nodes, edges, adj, lineTraversals };
}

test('a station with ≤4 incident edges is not split', () => {
  // 4 neighbours, one in each cardinal direction.
  const g = makeStar('c', [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 50 });
  assert.equal(out.ghostNodeIds.size, 0);
  assert.equal(out.graph.nodes.size, g.nodes.size);
  assert.equal(out.graph.edges.length, g.edges.length);
});

test('a high-degree station gets a ghost only for crowded direction buckets', () => {
  // 6 neighbours: 0°, 30°, 90°, 180°, 200°, 270° (math y-up).
  // Cardinal buckets (svg y-down: E=+x, S=+y, W=-x, N=-y) by closest dot:
  //   0°    (1, 0)      → E
  //   30°   (.87, .5)   → E (dot 0.87 > 0.5 toward S)
  //   90°   (0, 1)      → S
  //   180°  (-1, 0)     → W
  //   200°  (-.94, -.34)→ W
  //   270°  (0, -1)     → N
  // Bucket counts: E=2, S=1, W=2, N=1 → 2 ghosts (for E and W).
  const angles = [
    0,
    Math.PI / 6,
    Math.PI / 2,
    Math.PI,
    (Math.PI * 200) / 180,
    (3 * Math.PI) / 2,
  ];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 100 });
  assert.equal(out.ghostNodeIds.size, 2);
});

test('the original station is retained; each ghost has exactly one bundle edge to it', () => {
  const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, (Math.PI * 200) / 180, (3 * Math.PI) / 2];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 100 });
  assert.ok(out.graph.nodes.has('c'));
  for (const gid of out.ghostNodeIds) {
    const bundle = out.graph.edges.filter(
      (e) => (e.from === gid && e.to === 'c') || (e.from === 'c' && e.to === gid),
    );
    assert.equal(bundle.length, 1, `ghost ${gid} should have exactly one bundle edge`);
  }
});

test('a ghost sits at station + bucketDirection * ghostDistance', () => {
  // 5 neighbours where only the E bucket gets 2 members (at 0° and 30°). The
  // single ghost should be at (ghostDistance, 0) — i.e. east of the centre.
  const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 200 });
  assert.equal(out.ghostNodeIds.size, 1);
  const gid = [...out.ghostNodeIds][0];
  const ghost = out.graph.nodes.get(gid)!;
  assert.ok(Math.abs(ghost.pos[0] - 200) < 1e-6, `ghost x: ${ghost.pos[0]}`);
  assert.ok(Math.abs(ghost.pos[1] - 0) < 1e-6, `ghost y: ${ghost.pos[1]}`);
});

test('the bundle edge carries the union of lines from all bucket members', () => {
  // E bucket has 2 members (lines L0 at 0° and L1 at 30°).
  const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 100 });
  const gid = [...out.ghostNodeIds][0];
  const bundle = out.graph.edges.find(
    (e) => (e.from === gid && e.to === 'c') || (e.from === 'c' && e.to === gid),
  )!;
  const lineIds = new Set(bundle.lines.map((l) => l.id));
  assert.ok(lineIds.has('L0'), 'bundle should carry L0');
  assert.ok(lineIds.has('L1'), 'bundle should carry L1');
});

test('every line traversal still resolves to valid edges after splitting', () => {
  const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, (Math.PI * 200) / 180, (3 * Math.PI) / 2];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 100 });
  const edgeIds = new Set(out.graph.edges.map((e) => e.id));
  for (const [lid, traversal] of out.graph.lineTraversals) {
    for (const step of traversal) {
      assert.ok(
        edgeIds.has(step.edgeId),
        `line ${lid} references unknown edge ${step.edgeId}`,
      );
    }
  }
});

test('a bucketed line traverses bundle + outer (two steps) instead of one edge', () => {
  const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 100 });
  // L0 (at 0°) is in the E bucket → goes through ghost. Traversal length = 2.
  const trav = out.graph.lineTraversals.get('L0')!;
  assert.equal(trav.length, 2, `L0 should traverse 2 edges; got ${trav.length}`);
  // L2 (at 90°, alone in S bucket) is unchanged.
  const t2 = out.graph.lineTraversals.get('L2')!;
  assert.equal(t2.length, 1);
});

test('the original at-station stop is preserved on the bundle edge', () => {
  const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const g = makeStar('c', angles);
  const out = splitHighRouteNodes(g, { maxDirections: 4, ghostDistance: 100 });
  const gid = [...out.ghostNodeIds][0];
  const bundle = out.graph.edges.find(
    (e) => (e.from === gid && e.to === 'c') || (e.from === 'c' && e.to === gid),
  )!;
  // Bundle's station-end stop for L0 should be true (original e0 had atFrom=true at centre).
  const stationEnd = bundle.from === 'c' ? 'atFrom' : 'atTo';
  const s = bundle.stops.get('L0');
  assert.ok(s, 'bundle should have stop entry for L0');
  assert.equal(s![stationEnd], true);
});
