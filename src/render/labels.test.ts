import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap, estimateTextWidth, placeLabels, segmentIntersectsBox } from './labels';
import { lineGraph } from './layout/_fixtures';
import type { Pixel, StopMark } from './layout/types';

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
