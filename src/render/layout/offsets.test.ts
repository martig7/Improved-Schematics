import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCanonicalOffsets, offsetPolyline } from './offsets';
import { LINE_WIDTH, LINE_GAP } from '../constants';
import type { Layout, LayoutEdge, LineRef, Pixel } from './types';

const SPACING = LINE_WIDTH + LINE_GAP;

const ref = (id: string): LineRef => ({ id, label: id, color: '#000' });

function mkEdge(id: string, order: string[]): LayoutEdge {
  return {
    id,
    from: 'n1',
    to: 'n2',
    path: [],
    lines: order.map(ref),
    lineOrder: order,
    stops: new Map(),
  };
}

test('computeCanonicalOffsets separates co-running lines with colliding global offsets', () => {
  // A centers on e1 (offset 0), B centers on e2 (offset 0) — their canonical
  // edges differ, so both get the same global offset, yet they co-run on e3.
  // Undetected, both would draw at identical coordinates (one invisible).
  const layout: Layout = {
    cellSize: 10,
    nodes: new Map(),
    edges: [
      mkEdge('e1', ['X', 'A', 'Y']),
      mkEdge('e2', ['P', 'B', 'Q']),
      mkEdge('e3', ['A', 'B']),
    ],
    lineTraversals: new Map(),
  };
  const offsets = computeCanonicalOffsets(layout);
  const a = offsets.get('A')!;
  const b = offsets.get('B')!;
  assert.ok(Math.abs(a - b) >= SPACING * 0.9, `co-running lines still coincident: A=${a} B=${b}`);
});

test('computeCanonicalOffsets leaves non-colliding lines at their canonical slots', () => {
  // A and B share e1 as their canonical edge: distinct slots by construction,
  // and the de-collision pass must not move them.
  const layout: Layout = {
    cellSize: 10,
    nodes: new Map(),
    edges: [mkEdge('e1', ['A', 'B'])],
    lineTraversals: new Map(),
  };
  const offsets = computeCanonicalOffsets(layout);
  const spacing = Math.abs(offsets.get('A')! - offsets.get('B')!);
  assert.ok(spacing >= SPACING * 0.9, `expected one lane spacing, got ${spacing}`);
  assert.equal(offsets.get('A')! + offsets.get('B')!, 0); // symmetric around center
});

test('offsetPolyline with zero offset returns the input points', () => {
  const pts: Pixel[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const out = offsetPolyline(pts, 0);
  assert.deepEqual(out, pts);
});

test('offsetPolyline shifts a straight horizontal line perpendicularly', () => {
  const out = offsetPolyline(
    [
      [0, 0],
      [10, 0],
    ],
    4,
  );
  // perpendicular to +x is ±y; magnitude 4
  assert.ok(Math.abs(Math.abs(out[0][1]) - 4) < 1e-6);
  assert.ok(Math.abs(out[0][0]) < 1e-6); // x unchanged
});
