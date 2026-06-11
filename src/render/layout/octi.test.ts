import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianEdgeLength, octi, DEFAULT_OCTI_OPTIONS, cutSubCellFolds } from './octi';
import { OctiGridGraph, DEFAULT_PENALTIES } from './gridGraph';
import type { SupportGraph } from './types';

function chain(positions: Array<[number, number]>, lineId = 'L1'): SupportGraph {
  const nodes = new Map();
  positions.forEach((p, i) => nodes.set('n' + i, { id: 'n' + i, pos: p }));
  const edges = new Map();
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (let i = 0; i < positions.length - 1; i++) {
    const id = 'he' + i;
    edges.set(id, { id, from: 'n' + i, to: 'n' + (i + 1), points: [positions[i], positions[i + 1]], lineIds: new Set([lineId]) });
    adj.get('n' + i)!.push(id);
    adj.get('n' + (i + 1))!.push(id);
  }
  return {
    nodes,
    edges,
    adj,
    lineRefs: new Map([[lineId, { id: lineId, label: lineId, color: '#000' }]]),
    lineTraversals: new Map([[lineId, [...edges.keys()].map((edgeId) => ({ edgeId, reversed: false }))]]),
    stations: new Map(),
    stopAt: new Set(),
  };
}

test('medianEdgeLength returns the median support-edge length', () => {
  const h = chain([[0, 0], [10, 0], [40, 0]]); // lengths 10, 30
  assert.equal(medianEdgeLength(h), 20); // median of [10,30] = (10+30)/2
});

test('cutSubCellFolds excises a sub-cell terminal hook, keeping endpoints', () => {
  // course runs up past the terminus and hooks back: 12 Pl -> 10 St -> 1 Pl
  const pts: Array<[number, number]> = [[0, 0], [0, 12], [0, 24], [2, 12]];
  const out = cutSubCellFolds(pts, 22);
  assert.deepEqual(out[0], [0, 0], 'from endpoint preserved');
  assert.deepEqual(out[out.length - 1], [2, 12], 'to endpoint preserved');
  assert.ok(out.every((p) => p[1] <= 12 + 1e-9), `spike past the return point removed (got ${JSON.stringify(out)})`);
});

test('cutSubCellFolds keeps a real balloon loop (extent beyond one cell)', () => {
  const pts: Array<[number, number]> = [[0, 0], [0, 40], [40, 80], [80, 40], [40, 0], [4, 0]];
  const out = cutSubCellFolds(pts, 22);
  assert.deepEqual(out, pts, 'drawable loop untouched');
});

test('cutSubCellFolds leaves straight courses alone', () => {
  const pts: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [30, 0]];
  assert.deepEqual(cutSubCellFolds(pts, 22), pts);
});

test('grid graph: getNEdg/getDir agree and reverse edges resolve', () => {
  const g = new OctiGridGraph({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 10, DEFAULT_PENALTIES);
  const a = g.baseIdx(3, 3);
  for (let d = 0; d < 8; d++) {
    const b = g.neigh(a, d);
    assert.ok(b >= 0);
    assert.equal(g.getDir(a, b), d);
    const e = g.getNEdg(a, b);
    assert.ok(e >= 0);
    assert.equal(g.gridEdgeDir(e), d);
    const r = g.reverseGridEdge(e);
    const [rb, ra] = g.gridEdgeBases(r);
    assert.equal(rb, b);
    assert.equal(ra, a);
  }
});

test('grid graph: settling an edge closes turns and blocks the crossing diagonal', () => {
  const g = new OctiGridGraph({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 10, DEFAULT_PENALTIES);
  const a = g.baseIdx(3, 3);
  const b = g.neigh(a, 1); // NE diagonal
  g.settleEdg(a, b, 'ce1');
  assert.ok(g.isClosed(a));
  assert.ok(g.isClosed(b));
  // crossing diagonal between N-neighbour and E-neighbour must be blocked
  const na = g.neigh(a, 0);
  const nb = g.neigh(a, 2);
  const cross = g.getNEdg(na, nb);
  assert.ok(g.edgeCost(cross) >= 100_000);
  g.unSettleEdg('ce1', a, b);
  assert.ok(!g.isClosed(a));
  assert.ok(g.edgeCost(cross) < 100_000);
});

/** True when every consecutive segment of a pixel polyline is octilinear
 *  (horizontal, vertical, or 45°). */
function isOctilinear(path: [number, number][]): boolean {
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i][0] - path[i - 1][0]);
    const dy = Math.abs(path[i][1] - path[i - 1][1]);
    if (dx < 1e-6 && dy < 1e-6) continue;
    if (!(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6)) return false;
  }
  return true;
}

test('octi routes a 2-node axis graph as a straight octilinear run', () => {
  const h = chain([[0, 0], [30, 0]]);
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  assert.equal(img.paths.size, 1);
  const path = [...img.paths.values()][0];
  assert.ok(isOctilinear(path));
});

test('octi routes an off-axis graph octilinearly (L or 45+axis)', () => {
  const h = chain([[0, 0], [30, 10]]); // dx:dy = 3:1
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  const path = [...img.paths.values()][0];
  assert.ok(isOctilinear(path));
});

test('octi places every node within the displacement radius of its input', () => {
  const h = chain([[0, 0], [40, 0], [80, 0], [120, 0]]);
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  const dg = img.cellSize;
  for (const [id, node] of h.nodes) {
    const placed = img.placement.get(id);
    assert.ok(placed, 'node placed: ' + id);
    // LOOM maxGrDist = 3 grid cells (plus local-search moves of ±1 cell,
    // which the move penalty makes unattractive on a straight chain)
    assert.ok(Math.hypot(placed![0] - node.pos[0], placed![1] - node.pos[1]) <= 4 * dg + 1e-6);
  }
});

test('octi every routed path is octilinear and continuous', () => {
  const h = chain([[0, 0], [40, 5], [80, -5], [120, 10]]);
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  for (const e of h.edges.values()) {
    const path = img.paths.get(e.id)!;
    assert.ok(isOctilinear(path));
    // path endpoints sit on the placed nodes
    const pFrom = img.placement.get(e.from)!;
    const pTo = img.placement.get(e.to)!;
    assert.ok(Math.hypot(path[0][0] - pFrom[0], path[0][1] - pFrom[1]) < 1e-6);
    const last = path[path.length - 1];
    assert.ok(Math.hypot(last[0] - pTo[0], last[1] - pTo[1]) < 1e-6);
  }
});

test('octi keeps parallel corridors edge-disjoint (no shared grid edges)', () => {
  // two parallel horizontal lines two cells apart
  const h = chain([[0, 0], [60, 0], [120, 0]], 'L1');
  const extra = chain([[0, 25], [60, 25], [120, 25]], 'L2');
  // merge the two graphs
  for (const [id, n] of extra.nodes) h.nodes.set(id + 'b', { ...n, id: id + 'b' });
  for (const [id, e] of extra.edges) {
    const ne = { ...e, id: id + 'b', from: e.from + 'b', to: e.to + 'b' };
    h.edges.set(ne.id, ne);
  }
  h.adj.clear();
  for (const id of h.nodes.keys()) h.adj.set(id, []);
  for (const e of h.edges.values()) {
    h.adj.get(e.from)!.push(e.id);
    h.adj.get(e.to)!.push(e.id);
  }
  const img = octi(h, DEFAULT_OCTI_OPTIONS);
  // collect segments per edge; no two distinct support edges may share one
  const seen = new Map<string, string>();
  for (const [eid, path] of img.paths) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1].join(',');
      const b = path[i].join(',');
      const key = a < b ? a + '|' + b : b + '|' + a;
      const owner = seen.get(key);
      assert.ok(owner === undefined || owner === eid, `grid segment shared by ${owner} and ${eid}`);
      seen.set(key, eid);
    }
  }
});

test('geographicAffinity=1 keeps a curved input near its course', () => {
  const h = chain([[0, 0], [30, 20], [60, 0], [90, 20], [120, 0]]);
  const img = octi(h, { ...DEFAULT_OCTI_OPTIONS, geographicAffinity: 1 });
  const dg = img.cellSize;
  for (const e of h.edges.values()) {
    const path = img.paths.get(e.id)!;
    const mid = path[Math.floor(path.length / 2)];
    const courseMid = e.points[Math.floor(e.points.length / 2)];
    assert.ok(Math.hypot(mid[0] - courseMid[0], mid[1] - courseMid[1]) <= 3 * dg + 1e-6);
  }
});
