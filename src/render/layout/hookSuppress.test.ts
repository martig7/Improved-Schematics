import { test } from 'node:test';
import assert from 'node:assert';
import { suppressHooks } from './hookSuppress';
import type { Layout, LayoutNode, LayoutEdge, LineRef, TraversalStep, EdgeStop, Cell } from './types';

// --- synthetic Layout builders --------------------------------------------
// A folded three-node run: A -> s1 -> s2, with s1 an interior synthetic node.
// A and s2 are real stations; s1 is synthetic (interior).

function node(id: string, x: number, y: number): LayoutNode {
  return { id, cell: [x, y] as Cell, label: id, lngLat: [x / 1e5, y / 1e5] };
}

const L = (id: string): LineRef => ({ id, label: id, color: '#000000' });

interface EdgeSpec {
  id: string;
  from: string;
  to: string;
  lineIds: string[];
  // per-line stop flags at from/to (default no stops)
  stops?: Record<string, EdgeStop>;
}

function edge(spec: EdgeSpec): LayoutEdge {
  const lines = spec.lineIds.map(L);
  const stops = new Map<string, EdgeStop>();
  for (const [lid, s] of Object.entries(spec.stops ?? {})) stops.set(lid, s);
  return {
    id: spec.id,
    from: spec.from,
    to: spec.to,
    path: [] as Cell[], // populated below from node cells
    lines,
    lineOrder: lines.map((l) => l.id).sort(),
    stops,
  };
}

function makeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  traversals: Record<string, TraversalStep[]>,
): Layout {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  // give every edge a straight two-cell path from its endpoints (octi would
  // have a real polyline; the hook detector reads NODE cells, not edge paths).
  for (const e of edges) {
    const a = nodeMap.get(e.from)!;
    const b = nodeMap.get(e.to)!;
    e.path = [a.cell, b.cell];
  }
  return {
    cellSize: 1,
    nodes: nodeMap,
    edges,
    lineTraversals: new Map(Object.entries(traversals)),
  };
}

// The folded triangle: A -> s1 -> s2, s1 synthetic. Line "mag" traverses e0 then e1.
function triangleLayout(opts?: {
  stopAtS1?: boolean; // put a station stop for mag at interior s1
  extraLine?: boolean; // add a second line sharing the same hook
  straight?: boolean; // s1 collinear (no fold)
}): { layout: Layout; stations: Set<string> } {
  const A = node('A', 2244, 1980);
  // straight variant: s1 midway on the A->s2 chord (dot ~ +1, no fold)
  const s1 = opts?.straight ? node('s1', 2266, 2024) : node('s1', 2244, 2112);
  const s2 = node('s2', 2288, 2068);
  const lineIds = opts?.extraLine ? ['mag', 'grn'] : ['mag'];
  const e0Stops: Record<string, EdgeStop> = {};
  if (opts?.stopAtS1) e0Stops['mag'] = { atFrom: false, atTo: true }; // stop at s1 (e0.to)
  const e0 = edge({ id: 'e0', from: 'A', to: 's1', lineIds, stops: e0Stops });
  const e1 = edge({ id: 'e1', from: 's1', to: 's2', lineIds });
  const trav: Record<string, TraversalStep[]> = {
    mag: [{ edgeId: 'e0', reversed: false }, { edgeId: 'e1', reversed: false }],
  };
  if (opts?.extraLine) {
    trav['grn'] = [{ edgeId: 'e0', reversed: false }, { edgeId: 'e1', reversed: false }];
  }
  const layout = makeLayout([A, s1, s2], [e0, e1], trav);
  // A and s2 are real stations; s1 is synthetic.
  const stations = new Set(['A', 's2']);
  return { layout, stations };
}

// --- tests -----------------------------------------------------------------

test('suppressHooks: LON triangle splices — new A<->s2 edge, traversal rewritten, s1 edges drop the line', () => {
  const { layout } = triangleLayout();
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 1, 'one splice');

  // a new shortcut edge A<->s2 exists carrying mag
  const shortcut = layout.edges.find(
    (e) => (e.from === 'A' && e.to === 's2') || (e.from === 's2' && e.to === 'A'),
  );
  assert.ok(shortcut, 'shortcut edge A<->s2 created');
  assert.ok(
    shortcut!.lines.some((l) => l.id === 'mag'),
    'shortcut carries mag',
  );

  // e0 and e1 (the hook run) no longer carry mag, and being emptied, are gone
  const e0 = layout.edges.find((e) => e.id === 'e0');
  const e1 = layout.edges.find((e) => e.id === 'e1');
  assert.ok(!e0, 'e0 deleted (emptied)');
  assert.ok(!e1, 'e1 deleted (emptied)');

  // traversal now uses the single shortcut edge
  const trav = layout.lineTraversals.get('mag')!;
  assert.equal(trav.length, 1, 'traversal collapsed to one step');
  assert.equal(trav[0].edgeId, shortcut!.id);
});

test('suppressHooks: straight-through synthetic run (no fold) is untouched', () => {
  const { layout } = triangleLayout({ straight: true });
  const before = JSON.stringify(dumpEdges(layout));
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 0, 'no splice for straight run');
  assert.equal(JSON.stringify(dumpEdges(layout)), before, 'layout unchanged');
});

test('suppressHooks: run with a station stop at an interior node is untouched', () => {
  const { layout } = triangleLayout({ stopAtS1: true });
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 0, 'no splice when the line stops inside the run');
  assert.ok(layout.edges.find((e) => e.id === 'e0'), 'e0 kept');
  assert.ok(layout.edges.find((e) => e.id === 'e1'), 'e1 kept');
});

test('suppressHooks: two lines sharing the same hook get ONE shortcut edge', () => {
  const { layout } = triangleLayout({ extraLine: true });
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 2, 'two lines spliced');
  const shortcuts = layout.edges.filter(
    (e) => (e.from === 'A' && e.to === 's2') || (e.from === 's2' && e.to === 'A'),
  );
  assert.equal(shortcuts.length, 1, 'exactly one shortcut edge');
  const ids = shortcuts[0].lines.map((l) => l.id).sort();
  assert.deepEqual(ids, ['grn', 'mag'], 'shortcut carries both lines');
});

test('suppressHooks: A==E closed loop is untouched', () => {
  // A -> s1 -> A : the run returns to its own start. Interior s1 synthetic.
  const A = node('A', 2244, 1980);
  const s1 = node('s1', 2244, 2112);
  const e0 = edge({ id: 'e0', from: 'A', to: 's1', lineIds: ['mag'] });
  const e1 = edge({ id: 'e1', from: 's1', to: 'A', lineIds: ['mag'] });
  const layout = makeLayout(
    [A, s1],
    [e0, e1],
    { mag: [{ edgeId: 'e0', reversed: false }, { edgeId: 'e1', reversed: false }] },
  );
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 0, 'closed loop not spliced');
  assert.ok(layout.edges.find((e) => e.id === 'e0'));
  assert.ok(layout.edges.find((e) => e.id === 'e1'));
});

// Reversed-step fixture: same folded triangle geometry, but every edge is
// oriented BACKWARDS relative to travel. Here e0 goes s1->A and e1 goes s2->s1.
// The traversal reaches the hook via {reversed: true} steps, so the node sequence
// [to, from] must be used and stop flags must be read through the reversed
// orientation (stopAtTo = reversed ? atFrom : atTo).
function reversedTriangleLayout(opts?: { stopAtS1?: boolean }): {
  layout: Layout;
  stations: Set<string>;
} {
  const A = node('A', 2244, 1980);
  const s1 = node('s1', 2244, 2112);
  const s2 = node('s2', 2288, 2068);
  const e0Stops: Record<string, EdgeStop> = opts?.stopAtS1
    ? // interior stop at s1 = e0.from: only the REVERSED reading (atFrom) sees it
      { mag: { atFrom: true, atTo: false } }
    : // boundary stop at A = e0.to: reversed boundary reading is stop.atTo
      { mag: { atFrom: false, atTo: true } };
  const e0 = edge({ id: 'e0', from: 's1', to: 'A', lineIds: ['mag'], stops: e0Stops });
  const e1 = edge({ id: 'e1', from: 's2', to: 's1', lineIds: ['mag'] });
  const layout = makeLayout(
    [A, s1, s2],
    [e0, e1],
    { mag: [{ edgeId: 'e0', reversed: true }, { edgeId: 'e1', reversed: true }] },
  );
  return { layout, stations: new Set(['A', 's2']) };
}

test('suppressHooks: reversed-step hook splices — node sequence from [to,from], boundary stop carried', () => {
  const { layout } = reversedTriangleLayout();
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 1, 'reversed-step hook spliced');

  const shortcut = layout.edges.find((e) => e.id === 'hook:A:s2');
  assert.ok(shortcut, 'shortcut built A->s2 (travel order, not edge orientation)');
  assert.equal(shortcut!.from, 'A');
  assert.equal(shortcut!.to, 's2');

  const trav = layout.lineTraversals.get('mag')!;
  assert.equal(trav.length, 1, 'traversal collapsed to one step');
  assert.deepEqual(trav[0], { edgeId: 'hook:A:s2', reversed: false });

  // the boundary stop at A (read via the reversed orientation) rides along
  assert.deepEqual(shortcut!.stops.get('mag'), { atFrom: true, atTo: false });

  assert.ok(!layout.edges.find((e) => e.id === 'e0'), 'e0 deleted (emptied)');
  assert.ok(!layout.edges.find((e) => e.id === 'e1'), 'e1 deleted (emptied)');
});

test('suppressHooks: reversed-step run with an interior stop (reversed flag reading) is untouched', () => {
  const { layout } = reversedTriangleLayout({ stopAtS1: true });
  const res = suppressHooks(layout);
  assert.equal(res.spliced, 0, 'interior stop seen through reversed reading blocks the splice');
  assert.ok(layout.edges.find((e) => e.id === 'e0'), 'e0 kept');
  assert.ok(layout.edges.find((e) => e.id === 'e1'), 'e1 kept');
});

// Out-and-back fixture: a route that traverses its edges in BOTH
// directions, so a fold appears twice in one traversal. It shows up once
// outbound and once on the mirrored return. The splice of the outbound run
// must not corrupt the return run, which references the same edges.
function outAndBackLayout(): { layout: Layout; stations: Set<string> } {
  const A = node('A', 2244, 1980);
  const s1 = node('s1', 2244, 2112);
  const s2 = node('s2', 2288, 2068);
  const X = node('X', 2400, 2068);
  const e0 = edge({ id: 'e0', from: 'A', to: 's1', lineIds: ['mag'] });
  const e1 = edge({ id: 'e1', from: 's1', to: 's2', lineIds: ['mag'] });
  const e2 = edge({ id: 'e2', from: 's2', to: 'X', lineIds: ['mag'], stops: { mag: { atFrom: false, atTo: true } } });
  const layout = makeLayout(
    [A, s1, s2, X],
    [e0, e1, e2],
    {
      mag: [
        { edgeId: 'e0', reversed: false },
        { edgeId: 'e1', reversed: false },
        { edgeId: 'e2', reversed: false },
        { edgeId: 'e2', reversed: true },
        { edgeId: 'e1', reversed: true },
        { edgeId: 'e0', reversed: true },
      ],
    },
  );
  return { layout, stations: new Set(['A', 's2', 'X']) };
}

test('suppressHooks: out-and-back fold — BOTH directions spliced, no traversal step references a missing edge', () => {
  const { layout } = outAndBackLayout();
  suppressHooks(layout);

  const edgeIds = new Set(layout.edges.map((e) => e.id));
  const trav = layout.lineTraversals.get('mag')!;
  for (const s of trav) {
    assert.ok(edgeIds.has(s.edgeId), `traversal step references missing edge ${s.edgeId}`);
  }
  // consecutive steps must chain (share a node), with no graph-level breaks
  const eById = new Map(layout.edges.map((e) => [e.id, e]));
  for (let i = 0; i + 1 < trav.length; i++) {
    const a = eById.get(trav[i].edgeId)!;
    const b = eById.get(trav[i + 1].edgeId)!;
    const aEnd = trav[i].reversed ? a.from : a.to;
    const bStart = trav[i + 1].reversed ? b.to : b.from;
    assert.equal(aEnd, bStart, `steps ${i}->${i + 1} do not chain (${aEnd} != ${bStart})`);
  }
  // and every surviving edge's line list matches the traversal that uses it
  for (const e of layout.edges) {
    const used = trav.some((s) => s.edgeId === e.id);
    const carries = e.lines.some((l) => l.id === 'mag');
    assert.equal(carries, used, `edge ${e.id}: carries mag=${carries} but traversal uses it=${used}`);
  }
});

test('suppressHooks: deterministic — two structurally-equal inputs give deep-equal outputs', () => {
  const a = triangleLayout({ extraLine: true });
  const b = triangleLayout({ extraLine: true });
  suppressHooks(a.layout);
  suppressHooks(b.layout);
  assert.deepEqual(dumpEdges(a.layout), dumpEdges(b.layout));
  assert.deepEqual(
    [...a.layout.lineTraversals.entries()],
    [...b.layout.lineTraversals.entries()],
  );
});

// serialize edges in id order for stable comparison
function dumpEdges(layout: Layout): unknown {
  return [...layout.edges]
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      path: e.path,
      lines: e.lines.map((l) => l.id).sort(),
      stops: [...e.stops.entries()].sort(),
    }));
}
