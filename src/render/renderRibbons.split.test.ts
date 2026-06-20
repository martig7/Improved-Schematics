// DRAWN-contiguity regression for the octilinear hub split.
//
// The graph-level contiguity checker (dev/check-contiguity.ts, afterSplit/
// finalLayout) walks layout-edge incidence and reports a line CONNECTED as long
// as its carrying edges share node endpoints. But renderRibbons runs a
// "jog-dominated sliver suppression" pass that can DELETE a line's drawn lane on
// a short, laterally-jogged edge. A split-hub spine edge is exactly that shape
// (short ~half cell, offset between the + and - bundles) — and it is the ONLY
// drawn segment carrying the through-line across the split. Suppress it and the
// rendered ribbon has a visible GAP even though the graph stays connected
// through the spine edge. The fix: never suppress a splitInternal edge's lane.
//
// This test builds the minimal layout that triggers the suppression on a
// splitInternal spine and asserts: with the fix the spine lane is KEPT and the
// through-line draws as one contiguous run; with the fix disabled
// (OCTI_NO_SPLIT_FIX=1, reproducing pre-fix behaviour) the spine lane is
// SUPPRESSED and the drawn ribbon breaks (present = [true, false, true]).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OCTI_SPLIT_CAPTURE = '1';

import { renderRibbons, __ribbonDrawn } from './renderOctilinear';
import type { Layout, LayoutEdge, LayoutNode, Pixel, Cell, TraversalStep } from './layout/types';

const LINE = 'L1', L2 = 'L2', L3 = 'L3', L4 = 'L4';
const refs: Record<string, { id: string; color: string; label: string }> = {
  [LINE]: { id: LINE, color: '#e2231a', label: 'L1' },
  [L2]: { id: L2, color: '#0000ff', label: 'L2' },
  [L3]: { id: L3, color: '#00aa00', label: 'L3' },
  [L4]: { id: L4, color: '#ffaa00', label: 'L4' },
};
const A = 'A', Bp = 'Bp', Bm = 'Bm', C = 'C';
const pos: Record<string, Pixel> = {
  [A]: [0, 0], [Bp]: [100, 0], [Bm]: [104, 8], [C]: [204, 8],
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
  // Fat bundle on the arms puts L1 at a nonzero slot; the splitInternal spine
  // carries only L1 (slot 0), so its lane ends jog laterally away from the arm
  // lane ends — the jog-dominated suppression test fires on the short spine.
  const edges: LayoutEdge[] = [
    mkEdge('eA', A, Bp, [L2, L3, L4, LINE]),
    mkEdge('spine', Bp, Bm, [LINE], true),
    mkEdge('eB', Bm, C, [LINE, L2, L3, L4]),
  ];
  const through: TraversalStep[] = [
    { edgeId: 'eA', reversed: false },
    { edgeId: 'spine', reversed: false },
    { edgeId: 'eB', reversed: false },
  ];
  const arm: TraversalStep[] = [
    { edgeId: 'eA', reversed: false },
    { edgeId: 'eB', reversed: false },
  ];
  const layout: Layout = {
    cellSize: 1,
    nodes: new Map([A, Bp, Bm, C].map((id) => [id, mkNode(id)])),
    edges,
    lineTraversals: new Map([[LINE, through], [L2, arm], [L3, arm], [L4, arm]]),
  };
  return { layout, nodePx };
}

function render(noFix: boolean): { present: boolean[]; suppressed: string[] } {
  if (noFix) process.env.OCTI_NO_SPLIT_FIX = '1'; else delete process.env.OCTI_NO_SPLIT_FIX;
  const { layout, nodePx } = buildLayout();
  renderRibbons({
    layout, nodePx, edgePolyline: (e) => e.path.map((c) => [c[0], c[1]] as Pixel),
    width: 300, height: 100, dark: false, showLabels: false,
  });
  delete process.env.OCTI_NO_SPLIT_FIX;
  const steps = __ribbonDrawn!.drawn[LINE];
  return { present: steps.map((s) => s.present), suppressed: [...__ribbonDrawn!.suppressed] };
}

test('hub-split spine lane is kept: through-line drawn ribbon stays contiguous', () => {
  const r = render(false);
  // every traversal step has a drawn lane -> one contiguous run, no interior gap
  assert.deepEqual(r.present, [true, true, true]);
  assert.ok(!r.suppressed.includes('spine|L1'), 'splitInternal spine lane must NOT be suppressed');
});

test('PROOF the check catches the bug: with the fix disabled the spine lane is suppressed and the ribbon breaks', () => {
  const r = render(true);
  // pre-fix behaviour: the short, jogged splitInternal spine is suppressed, so
  // the through-line loses its only segment across the split -> interior gap.
  assert.deepEqual(r.present, [true, false, true]);
  assert.ok(r.suppressed.includes('spine|L1'), 'pre-fix code suppresses the splitInternal spine lane (the drawn gap)');
});
