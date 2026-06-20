// DRAWN-contiguity regression for the hub-split SPINE CONNECTOR gap (NYC green).
//
// Distinct from renderRibbons.split.test.ts (which covers lane SUPPRESSION of a
// splitInternal spine). Here the spine lane is DRAWN and present — yet the
// rendered through-line still breaks into two dangling rounded-cap stubs in open
// space. Mechanism: the node-connector pass bridges a line's lateral lane jog
// across a node only when the two lane endpoints sit within spacing*8 (=44px).
// A splitInternal spine carries the through-line at a LARGE slot of the split
// bundle, and where the diagonal spine meets the axial arm the two slot-offset
// endpoints diverge by MORE than 44px (NYC green at hub h5: 45.7px). The
// connector is then skipped and the ribbon dead-ends on both sides of the spine
// — a visible open-space break the graph-level checks miss (the support graph
// stays connected through the spine).
//
// The fix: at a spine boundary the connector is built regardless of the
// spacing*8 cap. With the fix disabled (OCTI_NO_SPLIT_FIX=1, pre-fix behaviour)
// the connector is skipped and the through-line's drawn ink splits into extra
// runs with open-space free ends — proving the test catches the bug.
//
// Geometry mirrors the real NYC case (node positions copied from the failing
// layout): the NW-diagonal spine Bp->Bm meets the axial arm Bm->C. A wide bundle
// (the through-line plus fillers) puts the through-line at an outer slot so the
// diagonal/axial endpoint divergence at Bm exceeds the connector cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderRibbons } from './renderOctilinear';
import { LINE_WIDTH } from './constants';
import type { Layout, LayoutEdge, LayoutNode, Pixel, Cell, TraversalStep } from './layout/types';

const THROUGH = 'L1';
// Wide bundle: the through-line rides an outer slot, so at the diagonal→axial
// spine boundary its lane endpoints diverge by >44px (the connector cap).
const N_LINES = 16;
const FILL = Array.from({ length: N_LINES - 1 }, (_, i) => 'F' + (i + 2));
const ALL = [...FILL, THROUGH]; // L1 last -> outermost slot
const refs: Record<string, { id: string; color: string; label: string }> = {};
ALL.forEach((id) => (refs[id] = { id, color: '#00aa00', label: id }));

// Node positions copied from the real failing NYC layout (octi px): the green
// through-line breaks at the spine's far node Bm where the NW-diagonal spine
// meets the axial arm.
const A = 'A', Bp = 'Bp', Bm = 'Bm', C = 'C';
const pos: Record<string, Pixel> = {
  [A]: [1232, 1447],   // arm eA start (NW diagonal into Bp)
  [Bp]: [1194, 1485],  // spine near node (split leaf 0)
  [Bm]: [1162, 1452],  // spine far node (split leaf 1)
  [C]: [1162, 1485],   // arm eB end (axial, straight down from Bm)
};

function buildLayout(): { layout: Layout; nodePx: Map<string, Pixel> } {
  const nodePx = new Map<string, Pixel>(Object.entries(pos));
  const mkNode = (id: string): LayoutNode => ({
    id, cell: [pos[id][0], pos[id][1]] as Cell, label: id, lngLat: [0, 0],
  });
  const mkEdge = (id: string, from: string, to: string, order: string[], si = false): LayoutEdge => ({
    id, from, to,
    path: [pos[from], pos[to]].map((p) => [p[0], p[1]] as Cell),
    lines: order.map((l) => refs[l]),
    lineOrder: order,
    stops: new Map(),
    ...(si ? { splitInternal: true } : {}),
  });
  const edges: LayoutEdge[] = [
    mkEdge('eA', A, Bp, ALL),
    mkEdge('spine', Bp, Bm, ALL, true),
    mkEdge('eB', Bm, C, ALL),
  ];
  // every line runs the full A->spine->C course (a fat bundle whose outer slot
  // is the through-line under test); their lanes all cross the spine boundary.
  const through: TraversalStep[] = [
    { edgeId: 'eA', reversed: false },
    { edgeId: 'spine', reversed: false },
    { edgeId: 'eB', reversed: false },
  ];
  const layout: Layout = {
    cellSize: 1,
    nodes: new Map([A, Bp, Bm, C].map((id) => [id, mkNode(id)])),
    edges,
    lineTraversals: new Map([[THROUGH, through], ...FILL.map((f) => [f, through] as const)]),
  };
  return { layout, nodePx };
}

type Pt = [number, number];

// Count the through-line's OPEN free ends: endpoints of its drawn subpaths with
// no other drawn point of the SAME line within ~one line width. A contiguous
// ribbon has exactly 2 (its true route termini at A and C); each unbridged spine
// gap adds dangling rounded-cap stubs in open space.
function openFreeEnds(svg: string): number {
  const m = /<path d="([^"]*)"[^>]*data-line-id="L1"\/>/.exec(svg);
  if (!m) return -1;
  const subs: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (const t of m[1].match(/[MLQC][^MLQC]*/g) ?? []) {
    const cmd = t[0];
    const n = (t.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (cmd === 'M') { if (cur?.length) subs.push(cur); cur = [[n[0], n[1]]]; }
    else if (cmd === 'L') cur?.push([n[0], n[1]]);
    else if (cmd === 'Q') cur?.push([n[2], n[3]]);
    else if (cmd === 'C') cur?.push([n[4], n[5]]);
  }
  if (cur?.length) subs.push(cur);
  const all: Array<{ p: Pt; si: number; vi: number }> = [];
  subs.forEach((s, si) => s.forEach((p, vi) => all.push({ p, si, vi })));
  const COINC = LINE_WIDTH * 1.2;
  let open = 0;
  subs.forEach((s, si) => {
    for (const [vi, p] of [[0, s[0]], [s.length - 1, s[s.length - 1]]] as Array<[number, Pt]>) {
      const has = all.some((o) =>
        !(o.si === si && (o.vi === vi || Math.abs(o.vi - vi) === 1)) &&
        Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) <= COINC);
      if (!has) open++;
    }
  });
  return open;
}

function render(noFix: boolean): string {
  if (noFix) process.env.OCTI_NO_SPLIT_FIX = '1'; else delete process.env.OCTI_NO_SPLIT_FIX;
  const { layout, nodePx } = buildLayout();
  const svg = renderRibbons({
    layout, nodePx, edgePolyline: (e) => e.path.map((c) => [c[0], c[1]] as Pixel),
    width: 2700, height: 2700, dark: true, showLabels: false,
  });
  delete process.env.OCTI_NO_SPLIT_FIX;
  return svg;
}

test('hub-split spine connector: through-line ribbon stays contiguous (fix on)', () => {
  const open = openFreeEnds(render(false));
  // contiguous: only the two genuine route termini (A and C) are free ends; the
  // spine boundary is bridged, so no open-space dangling stubs.
  assert.equal(open, 2, 'fix: through-line has only its 2 true termini, no open-space break');
});

test('PROOF the check catches the bug: with the fix disabled the spine connector is skipped and the ribbon breaks', () => {
  const open = openFreeEnds(render(true));
  // pre-fix: the >44px lane jog at the spine boundary skips the connector, so
  // the through-line splits into extra runs with open-space dangling ends.
  assert.ok(open > 2, `pre-fix should leave extra open-space dangling stubs (got ${open})`);
});
