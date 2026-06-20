// Regression: out-and-back spur removal, incl. the recursive hub-split spine
// retrace (the doubly-recursive STUB).
//
// After mergeCoincidentPaths, a through-line that the splitNode traversal stitch
// routed onto a DEEPER split leaf (h49 -> h49_sp-0 -> h49_sp-0_sp-1) can have its
// onward external arm reattached to a SHALLOWER leaf's merged corridor. The
// merged walk then reaches the deep leaf along the spine and immediately retraces
// it (edge fwd, edge rev) to rejoin the arm. That retrace draws a spine lane that
// dead-ends in open space at the deep leaf — the visible purple #60399E stub at
// uncapped London (h49). The leaf carries the line's rehomed stop flag, so
// flagAtFar is set and the plain spur-removal guard KEEPS the retrace, leaving the
// stub. removeOutAndBackSpurs must drop a retrace on a splitInternal (spine) edge
// REGARDLESS of flagAtFar (the split is virtual — one real station), while still
// preserving a genuine terminus retrace on a normal edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { removeOutAndBackSpurs } from './renderGeographic';
import type { Layout, LayoutEdge, LayoutNode, Cell, TraversalStep, EdgeStop } from './layout/types';

const ref = (id: string) => ({ id, color: '#60399E', label: id });

function mkNode(id: string): LayoutNode {
  return { id, cell: [0, 0] as Cell, label: id, lngLat: [0, 0] };
}
function mkEdge(
  id: string, from: string, to: string,
  opts: { si?: boolean; stops?: Map<string, EdgeStop> } = {},
): LayoutEdge {
  return {
    id, from, to,
    path: [[0, 0], [1, 1]] as Cell[],
    lines: [ref('L')],
    lineOrder: ['L'],
    stops: opts.stops ?? new Map(),
    ...(opts.si ? { splitInternal: true } : {}),
  };
}

function mkLayout(edges: LayoutEdge[], trav: TraversalStep[]): Layout {
  const nodeIds = new Set<string>();
  for (const e of edges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  return {
    cellSize: 1,
    nodes: new Map([...nodeIds].map((id) => [id, mkNode(id)])),
    edges,
    lineTraversals: new Map([['L', trav]]),
  };
}

test('spur removal: recursive split-spine retrace is dropped even with a stop flag at the deep leaf (the doubly-recursive STUB)', () => {
  // arm A -> shallow leaf -> spine0 -> mid leaf -> spine1 -> DEEP leaf, then the
  // onward arm is reattached at the MID leaf, so the walk retraces spine1.
  // The line stops at the deep leaf (rehomed flag) -> flagAtFar would KEEP it.
  const stops = new Map<string, EdgeStop>([['L', { atFrom: false, atTo: true }]]); // atTo = deep leaf
  const edges: LayoutEdge[] = [
    mkEdge('armIn', 'A', 'shallow'),
    mkEdge('spine0', 'shallow', 'mid', { si: true }),
    mkEdge('spine1', 'mid', 'deep', { si: true, stops }),
    mkEdge('armOut', 'mid', 'Z'),
  ];
  // shallow -> mid -> deep -> mid -> Z  (spine1 fwd then rev: the out-and-back)
  const trav: TraversalStep[] = [
    { edgeId: 'armIn', reversed: false },   // A -> shallow
    { edgeId: 'spine0', reversed: false },  // shallow -> mid
    { edgeId: 'spine1', reversed: false },  // mid -> deep
    { edgeId: 'spine1', reversed: true },   // deep -> mid  (retrace)
    { edgeId: 'armOut', reversed: false },  // mid -> Z
  ];
  const layout = mkLayout(edges, trav);
  removeOutAndBackSpurs(layout);
  const out = layout.lineTraversals.get('L')!.map((s) => s.edgeId + (s.reversed ? 'R' : ''));
  // the spine1 out-and-back must be gone; the walk stays contiguous A->shallow->mid->Z
  assert.deepEqual(out, ['armIn', 'spine0', 'armOut'], `spine retrace must be removed; got ${out.join(',')}`);
});

test('spur removal: a deeper (triply-recursive) spine retrace is also dropped (depth-agnostic)', () => {
  const stops = new Map<string, EdgeStop>([['L', { atFrom: false, atTo: true }]]);
  const edges: LayoutEdge[] = [
    mkEdge('armIn', 'A', 'L0'),
    mkEdge('s0', 'L0', 'L1', { si: true }),
    mkEdge('s1', 'L1', 'L2', { si: true }),
    mkEdge('s2', 'L2', 'L3', { si: true, stops }),
    mkEdge('armOut', 'L2', 'Z'),
  ];
  const trav: TraversalStep[] = [
    { edgeId: 'armIn', reversed: false },
    { edgeId: 's0', reversed: false },
    { edgeId: 's1', reversed: false },
    { edgeId: 's2', reversed: false }, // L2 -> L3
    { edgeId: 's2', reversed: true },  // L3 -> L2 (retrace at depth 3)
    { edgeId: 'armOut', reversed: false },
  ];
  const layout = mkLayout(edges, trav);
  removeOutAndBackSpurs(layout);
  const out = layout.lineTraversals.get('L')!.map((s) => s.edgeId);
  assert.deepEqual(out, ['armIn', 's0', 's1', 'armOut'], `deep spine retrace must be removed; got ${out.join(',')}`);
});

test('spur removal: a NORMAL-edge terminus retrace with a stop flag is KEPT (no regression)', () => {
  // A genuine terminus out-and-back on a non-split edge: the line truly ends at
  // the far node (flag set), so its retrace steps must survive.
  const stops = new Map<string, EdgeStop>([['L', { atFrom: false, atTo: true }]]);
  const edges: LayoutEdge[] = [
    mkEdge('armIn', 'A', 'B'),
    mkEdge('term', 'B', 'T', { stops }), // normal edge, line terminates at T
  ];
  const trav: TraversalStep[] = [
    { edgeId: 'armIn', reversed: false },
    { edgeId: 'term', reversed: false }, // B -> T
    { edgeId: 'term', reversed: true },  // T -> B (legit terminus retrace)
  ];
  const layout = mkLayout(edges, trav);
  removeOutAndBackSpurs(layout);
  const out = layout.lineTraversals.get('L')!.map((s) => s.edgeId + (s.reversed ? 'R' : ''));
  assert.deepEqual(out, ['armIn', 'term', 'termR'], `terminus retrace on a normal edge must be kept; got ${out.join(',')}`);
});

test('spur removal: a NORMAL-edge crossing spur without a stop flag is dropped (existing behaviour)', () => {
  const edges: LayoutEdge[] = [
    mkEdge('armIn', 'A', 'B'),
    mkEdge('cross', 'B', 'X'), // no stop flag -> mere crossing
    mkEdge('armOut', 'B', 'Z'),
  ];
  const trav: TraversalStep[] = [
    { edgeId: 'armIn', reversed: false },
    { edgeId: 'cross', reversed: false }, // B -> X
    { edgeId: 'cross', reversed: true },  // X -> B
    { edgeId: 'armOut', reversed: false },
  ];
  const layout = mkLayout(edges, trav);
  removeOutAndBackSpurs(layout);
  const out = layout.lineTraversals.get('L')!.map((s) => s.edgeId);
  assert.deepEqual(out, ['armIn', 'armOut'], `crossing spur must be removed; got ${out.join(',')}`);
});
