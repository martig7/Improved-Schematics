import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../placement';
import type { StopMark, Pixel } from '../../layout/types';

const ctx = {};
const mk = (lineId: string, x: number, y: number, extra: Partial<StopMark> = {}): StopMark => ({ lineId, color: '#dc2626', pos: [x, y] as Pixel, name: lineId, ...extra });

test('single mark -> capsule none, lines has one dot', () => {
  const s = buildScene('n1', [mk('A', 5, 5)], ctx);
  assert.equal(s.capsule.kind, 'none');
  assert.equal(s.lines.length, 1);
  assert.deepEqual(s.anchor, [5, 5]);
});

test('two spread marks -> pill (straight), dots kept', () => {
  const s = buildScene('n1', [mk('A', 0, 0, { chain: 0 }), mk('B', 20, 0, { chain: 1 })], ctx);
  assert.equal(s.capsule.kind, 'pill');
  assert.equal((s.capsule as { smooth: boolean }).smooth, false);
  assert.equal(s.lines.length, 2);
});

test('coincident marks -> ring', () => {
  const s = buildScene('n1', [mk('A', 5, 5), mk('B', 5, 5)], ctx);
  assert.equal(s.capsule.kind, 'ring');
});

test('mega marks -> smooth pill, dots kept (residual curve)', () => {
  const marks = [mk('A', 0, 0, { mega: true }), mk('B', 12, 4, { mega: true }), mk('C', 4, 12, { mega: true })];
  const s = buildScene('n1', marks, {});
  assert.equal(s.capsule.kind, 'pill');
  assert.equal((s.capsule as { smooth: boolean }).smooth, true);
  assert.equal(s.lines.length, 3);
});

test('StopLine carries color/bullet/textColor from the mark', () => {
  const s = buildScene('n1', [mk('A', 5, 5, { textColor: '#00ff00' })], ctx);
  assert.equal(s.lines[0].color, '#dc2626');
  assert.equal(s.lines[0].bullet, 'A');
  assert.equal(s.lines[0].textColor, '#00ff00');
});
