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

// The two crossing regimes share the solve but not the scene: a covering design
// gets the junction alone, a point-marking one also gets the lanes it must mark.
const crossMarks = (): StopMark[] => [mk('A', 0, 0, { axis: 0 }), mk('B', 8, 8, { axis: 2 })];
const crossAt = new Map([['n1', { cx: 4, cy: 4 }]]);

test('toronto crossing -> ring at the junction, lanes dropped', () => {
  const s = buildScene('n1', crossMarks(), { capsuleMode: 'toronto', torontoByNode: crossAt });
  assert.equal(s.capsule.kind, 'ring');
  assert.deepEqual(s.anchor, [4, 4]);
  assert.equal(s.lines.length, 0, 'the capsule covers them, so none are carried');
});

test('dc crossing -> a pill carrying the crossing, its spine and its lanes', () => {
  // It marks a junction as a point, which speaks only for the lanes that point
  // stands on, so it cannot collapse: it needs the spine to draw a wider station
  // along, and the lanes to know what is there.
  const s = buildScene('n1', crossMarks(), { capsuleMode: 'dc', torontoByNode: crossAt });
  assert.equal(s.capsule.kind, 'pill');
  assert.deepEqual((s.capsule as { cross?: [number, number] }).cross, [4, 4]);
  assert.ok((s.capsule as { points: unknown[] }).points.length >= 2, 'a spine to draw along');
  assert.deepEqual(s.anchor, [4, 4], 'still anchored on the junction');
  assert.deepEqual(s.lines.map((l) => l.lineId).sort(), ['A', 'B']);
});

test('a crossing regime with no solved entry falls through to a plain pill', () => {
  for (const capsuleMode of ['toronto', 'dc'] as const) {
    const s = buildScene('n1', crossMarks(), { capsuleMode, torontoByNode: new Map() });
    assert.equal(s.capsule.kind, 'pill', capsuleMode);
    assert.equal((s.capsule as { cross?: unknown }).cross, undefined, capsuleMode);
    assert.equal(s.lines.length, 2, capsuleMode);
  }
});

test('paris placement carries the four-axis solve and seats each line on its cell', () => {
  const marks = [mk('A', 0, 0), mk('B', 20, 0)];
  const parisByNode = new Map([['n1', {
    interchange: true,
    radius: 6,
    cells: [
      { at: [4, 4] as Pixel, lineIds: ['A'], endpointLineIds: [], shape: 'round' as const },
      { at: [12, 12] as Pixel, lineIds: ['B'], endpointLineIds: ['B'], shape: 'round' as const },
    ],
    groups: [{ axis: 1, cellIndexes: [0, 1], points: [[4, 4], [12, 12]] as Pixel[] }],
    connectors: [],
    ends: [],
    anchor: [8, 8] as Pixel,
  }]]);
  const scene = buildScene('n1', marks, { capsuleMode: 'paris', parisByNode });
  assert.equal(scene.capsule.kind, 'paris');
  assert.deepEqual(scene.lines.map((line) => line.pos), [[4, 4], [12, 12]]);
  assert.deepEqual(scene.anchor, [8, 8]);
});

test('StopLine carries color/bullet/textColor from the mark', () => {
  const s = buildScene('n1', [mk('A', 5, 5, { textColor: '#00ff00' })], ctx);
  assert.equal(s.lines[0].color, '#dc2626');
  assert.equal(s.lines[0].bullet, 'A');
  assert.equal(s.lines[0].textColor, '#00ff00');
});
