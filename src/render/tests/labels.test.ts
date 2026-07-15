import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap, bundleOrder, estimateTextWidth, placeLabels, renderLabel, segmentIntersectsBox, type Segment } from '../labels';
import { lineGraph } from '../layout/tests/_fixtures';
import type { Pixel, StopMark } from '../layout/types';
import type { Prim } from '../sceneIR';

test('renderLabel emits rotate() only when angle is nonzero', () => {
  const flat = renderLabel({ id: 'n', label: 'Foo' }, { x: 10, y: 20, anchor: 'start' }, [10, 20], true, false);
  assert.ok(!flat.includes('rotate('), 'flat label has no rotate, byte-identical to today');
  const rot = renderLabel({ id: 'n', label: 'Foo' }, { x: 10, y: 20, anchor: 'start', angle: -45 }, [10, 20], true, false);
  assert.ok(rot.includes('rotate(-45)'), 'rotated label carries the transform');
});

test('renderLabel pushes a text prim carrying the angle only when rotated', () => {
  const flat: Prim[] = [];
  renderLabel({ id: 'n', label: 'Foo' }, { x: 1, y: 2, anchor: 'start' }, [1, 2], true, false, flat);
  assert.equal((flat[0] as { angle?: number }).angle, undefined);
  const rot: Prim[] = [];
  renderLabel({ id: 'n', label: 'Foo' }, { x: 1, y: 2, anchor: 'start', angle: 90 }, [1, 2], true, false, rot);
  assert.equal((rot[0] as { angle?: number }).angle, 90);
});

test('estimateTextWidth scales with length', () => {
  assert.equal(estimateTextWidth('abcd'), 4 * 6);
});

test('boxesOverlap detects overlap and separation', () => {
  assert.ok(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(!boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }));
});

test('segmentIntersectsBox detects a crossing segment', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.ok(segmentIntersectsBox([-5, 5], [15, 5], box)); // passes through
  assert.ok(!segmentIntersectsBox([-5, -5], [-5, 15], box)); // entirely left
});

test('placeLabels assigns a placement per station and avoids label overlap', () => {
  const graph = lineGraph([
    [0, 0],
    [200, 0],
  ]);
  const nodePx = new Map<string, Pixel>([
    ['n0', [0, 0]],
    ['n1', [200, 0]],
  ]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L1', color: '#f00', pos: [0, 0] }]],
    ['n1', [{ lineId: 'L1', color: '#f00', pos: [200, 0] }]],
  ]);
  const placements = placeLabels(graph, nodePx, stops, []);
  assert.equal(placements.size, 2);
  assert.ok(placements.has('n0') && placements.has('n1'));
});

const ANGLES = new Set([0, 45, -45, -90]);

test('every placement uses only never-upside-down octilinear angles', () => {
  const graph = lineGraph([[0, 0], [200, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [200, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L1', color: '#f00', pos: [0, 0] }]],
    ['n1', [{ lineId: 'L1', color: '#f00', pos: [200, 0] }]],
  ]);
  for (const p of placeLabels(graph, nodePx, stops, []).values()) {
    assert.ok(ANGLES.has(p.angle ?? 0));
  }
});

test('a lone label with room stays flat (flat when it fits)', () => {
  const graph = lineGraph([[0, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n0', [{ lineId: 'L', color: '#000', pos: [0, 0] }]]]);
  assert.equal(placeLabels(graph, nodePx, stops, []).get('n0')!.angle ?? 0, 0);
});

test('placeLabels is deterministic (same input, same placements twice)', () => {
  const graph = lineGraph([[0, 0], [30, 0], [60, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [30, 0]], ['n2', [60, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['n1', [{ lineId: 'L', color: '#000', pos: [30, 0], seq: 1 }]],
    ['n2', [{ lineId: 'L', color: '#000', pos: [60, 0], seq: 2 }]],
  ]);
  const a = [...placeLabels(graph, nodePx, stops, []).entries()];
  const b = [...placeLabels(graph, nodePx, stops, []).entries()];
  assert.deepEqual(a, b);
});

// One node with a long label, walled in by a picket fence of vertical segments on
// both flanks. Every flat box (wide, horizontal) crosses pickets; only the narrow
// vertical channel just off the dot (where a -90 label sits) stays clear.
const walledIn = () => {
  const graph = { nodes: new Map([['n0', { id: 'n0', label: 'Very Long Station Name' }]]) };
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n0', [{ lineId: 'L', color: '#000', pos: [0, 0] as Pixel }]]]);
  const segs: Segment[] = [];
  for (const x of [20, 28, 36, 44, 52, 60]) {
    segs.push({ p1: [x, -60], p2: [x, 60] }, { p1: [-x, -60], p2: [-x, 60] });
  }
  return { graph, nodePx, stops, segs };
};

test('a horizontally boxed-in label rotates off flat', () => {
  const { graph, nodePx, stops, segs } = walledIn();
  const angle = placeLabels(graph, nodePx, stops, segs).get('n0')!.angle ?? 0;
  assert.notEqual(angle, 0);
});

test('OCTI_LABEL_NO_ROTATE=1 keeps every label flat even when boxed in', () => {
  process.env.OCTI_LABEL_NO_ROTATE = '1';
  try {
    const { graph, nodePx, stops, segs } = walledIn();
    assert.equal(placeLabels(graph, nodePx, stops, segs).get('n0')!.angle ?? 0, 0);
  } finally {
    delete process.env.OCTI_LABEL_NO_ROTATE;
  }
});

test('bundleOrder walks each line in seq order and chains predecessors', () => {
  const nodes = [
    { id: 'a', label: 'AAelong' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'CC' },
  ];
  const stops = new Map<string, StopMark[]>([
    ['a', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['b', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 1 }]],
    ['c', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 2 }]],
  ]);
  const { order, prevOnBundle } = bundleOrder(nodes, stops);
  assert.deepEqual(order.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(prevOnBundle.get('b'), 'a');
  assert.equal(prevOnBundle.get('c'), 'b');
  assert.equal(prevOnBundle.get('a'), undefined);
});

test('bundleOrder tails unsequenced nodes longest-label-first (today order)', () => {
  const nodes = [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'YYYY' },
  ];
  const stops = new Map<string, StopMark[]>(); // no seq/lineId anywhere
  const { order, prevOnBundle } = bundleOrder(nodes, stops);
  assert.deepEqual(order.map((n) => n.id), ['y', 'x']);
  assert.equal(prevOnBundle.size, 0);
});
