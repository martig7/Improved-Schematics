import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paris } from '../paris';
import type { StopLine, StopScene } from '../types';
import { capsuleStrokeWidths } from '../primitives';

const ctx = { dark: false, showBullets: true, land: '#ffffff' };

const line = (lineId: string, color: string, pos: [number, number], terminus = false): StopLine => ({
  lineId,
  color,
  bullet: lineId.toUpperCase(),
  textColor: '#ffffff',
  pos,
  chain: 0,
  axis: 0,
  terminus,
});

test('an ordinary single station matches the perfect-intersection circle radius', () => {
  const scene: StopScene = {
    nodeId: 'n',
    lines: [line('a', '#cc0000', [0, 0])],
    capsule: {
      kind: 'paris', interchange: false, radius: 6,
      cells: [{ at: [0, 0], lineIds: ['a'], endpointLineIds: [], shape: 'round' }],
      groups: [{ axis: 0, cellIndexes: [0], points: [[0, 0]] }],
      connectors: [], ends: [],
    },
    anchor: [0, 0],
    dotRadius: 3,
  };
  const glyphs = paris.paint(scene, ctx);
  assert.deepEqual(glyphs, [{ kind: 'circle', cx: 0, cy: 0, r: 6, fill: '#cc0000', stroke: 'none', strokeWidth: 0 }]);
});

test('a route endpoint gets a white bubble, color fill, tail, and route badge', () => {
  const ln = { ...line('a', '#cc0000', [0, 0], true), end: [1, 0] as [number, number] };
  const scene: StopScene = {
    nodeId: 'n', lines: [ln], dotRadius: 3, anchor: [0, 0],
    capsule: {
      kind: 'paris', interchange: false, radius: 6,
      cells: [{ at: [0, 0], lineIds: ['a'], endpointLineIds: ['a'], shape: 'round' }],
      groups: [{ axis: 0, cellIndexes: [0], points: [[0, 0]] }],
      connectors: [],
      ends: [{ lineId: 'a', cut: [10, 0], at: [18, 0] }],
    },
  };
  const glyphs = paris.paint(scene, ctx);
  assert.equal(glyphs.filter((glyph) => glyph.kind === 'line').length, 2, 'cased route tail');
  assert.ok(glyphs.some((glyph) => glyph.kind === 'circle' && glyph.fill === '#ffffff' && glyph.r === 6));
  assert.ok(glyphs.some((glyph) => glyph.kind === 'circle' && glyph.fill === '#cc0000' && glyph.r < 6));
  assert.ok(glyphs.some((glyph) => glyph.kind === 'text' && glyph.text === 'A'), 'route badge text');
});

test('two routes ending in one round cell split its color fill', () => {
  const scene: StopScene = {
    nodeId: 'n',
    lines: [line('a', '#cc0000', [0, 0], true), line('b', '#0000cc', [0, 0], true)],
    capsule: {
      kind: 'paris', interchange: true, radius: 6,
      cells: [{ at: [0, 0], lineIds: ['a', 'b'], endpointLineIds: ['a', 'b'], shape: 'round' }],
      groups: [{ axis: 1, cellIndexes: [0], points: [[0, 0]] }],
      connectors: [], ends: [],
    },
    anchor: [0, 0], dotRadius: 3,
  };
  const glyphs = paris.paint(scene, ctx);
  assert.ok(glyphs.some((glyph) => glyph.kind === 'path' && glyph.fill === '#cc0000'));
  assert.ok(glyphs.some((glyph) => glyph.kind === 'path' && glyph.fill === '#0000cc'));
});

test('a single Paris bubble has the same outer width as an NYC capsule', () => {
  const scene: StopScene = {
    nodeId: 'n',
    lines: [line('a', '#cc0000', [0, 0]), line('b', '#0000cc', [0, 0])],
    capsule: {
      kind: 'paris', interchange: true, radius: capsuleStrokeWidths(3).fill / 2,
      cells: [{ at: [0, 0], lineIds: ['a', 'b'], endpointLineIds: [], shape: 'round' }],
      groups: [{ axis: 0, cellIndexes: [0], points: [[0, 0]] }],
      connectors: [], ends: [],
    },
    anchor: [0, 0], dotRadius: 3,
  };
  const bubble = paris.paint(scene, ctx).find((glyph) => glyph.kind === 'circle' && glyph.fill === '#111111');
  assert.ok(bubble && bubble.kind === 'circle');
  assert.equal(bubble.r * 2, capsuleStrokeWidths(scene.dotRadius).border);
});

test('a three-cell diagonal capsule uses a rounded path and square middle endpoint', () => {
  const scene: StopScene = {
    nodeId: 'n',
    lines: [line('a', '#cc0000', [0, 0]), line('b', '#0000cc', [8, 8], true), line('c', '#00aa00', [16, 16])],
    capsule: {
      kind: 'paris', interchange: true, radius: 6,
      cells: [
        { at: [0, 0], lineIds: ['a'], endpointLineIds: [], shape: 'round' },
        { at: [8, 8], lineIds: ['b'], endpointLineIds: ['b'], shape: 'square' },
        { at: [16, 16], lineIds: ['c'], endpointLineIds: [], shape: 'round' },
      ],
      groups: [{ axis: 1, cellIndexes: [0, 1, 2], points: [[0, 0], [8, 8], [16, 16]] }],
      connectors: [], ends: [],
    },
    anchor: [8, 8], dotRadius: 3,
  };
  const glyphs = paris.paint(scene, ctx);
  assert.ok(glyphs.some((glyph) => glyph.kind === 'path' && glyph.fill === 'none' && glyph.stroke === '#ffffff'));
  const endpoint = glyphs.find((glyph) => glyph.kind === 'path' && glyph.fill === '#0000cc');
  assert.ok(endpoint && endpoint.kind === 'path');
  assert.match(endpoint.d, /^M .* L .* L .* L .* Z$/);
});

test('coincident endpoints split a square interchange cell into both route colors', () => {
  const scene: StopScene = {
    nodeId: 'n',
    lines: [line('a', '#cc0000', [10, 10], true), line('b', '#0000cc', [10, 10], true)],
    capsule: {
      kind: 'paris', interchange: true, radius: 6,
      cells: [{ at: [10, 10], lineIds: ['a', 'b'], endpointLineIds: ['a', 'b'], shape: 'square' }],
      groups: [{ axis: 1, cellIndexes: [0], points: [[10, 10]] }],
      connectors: [], ends: [],
    },
    anchor: [10, 10], dotRadius: 3,
  };
  const fills = paris.paint(scene, ctx).filter((glyph) => glyph.kind === 'path' && glyph.fill !== 'none');
  assert.deepEqual(fills.map((glyph) => glyph.fill), ['#cc0000', '#0000cc']);
});
