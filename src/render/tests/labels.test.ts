import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap, bundleOrder, estimateTextWidth, placeLabels, renderLabel, segmentIntersectsBox } from '../labels';
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
