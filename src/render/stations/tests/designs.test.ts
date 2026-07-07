import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classic } from '../classic';
import { nycSolid } from '../nycSolid';
import { nycMap } from '../nycMap';
import type { StopScene } from '../types';

const single = (color = '#dc2626', textColor = ''): StopScene => ({
  nodeId: 'n', lines: [{ lineId: 'L', color, bullet: 'A', textColor, pos: [10, 10], chain: 0 }], capsule: { kind: 'none' }, anchor: [10, 10], dotRadius: 13,
});
const pair = (): StopScene => ({
  nodeId: 'n', lines: [ { lineId: 'L1', color: '#dc2626', bullet: 'A', textColor: '', pos: [0, 0], chain: 0 }, { lineId: 'L2', color: '#0000ff', bullet: 'B', textColor: '', pos: [20, 0], chain: 1 } ], capsule: { kind: 'pill', points: [[0, 0], [20, 0]], smooth: false }, anchor: [10, 0], dotRadius: 9,
});
const ctx = { dark: false, showBullets: true };
const circleOf = (gs: ReturnType<typeof classic.paint>) => gs.find((g) => g.kind === 'circle') as { fill: string; stroke: string };
const textOf = (gs: ReturnType<typeof classic.paint>) => gs.find((g) => g.kind === 'text') as { fill: string };

test('classic: hollow disc (bg fill, line-color ring), ink bullet', () => {
  const gs = classic.paint(single(), ctx);
  assert.equal(circleOf(gs).fill, '#ffffff');
  assert.equal(circleOf(gs).stroke, '#dc2626');
  assert.equal(textOf(gs).fill, '#111111');
});

test('nycSolid: disc filled in line color; bullet uses textColor then contrast', () => {
  assert.equal(circleOf(nycSolid.paint(single('#dc2626', '#00ff00'), ctx)).fill, '#dc2626');
  assert.equal(textOf(nycSolid.paint(single('#dc2626', '#00ff00'), ctx)).fill, '#00ff00');
  assert.equal(textOf(nycSolid.paint(single('#000080', ''), ctx)).fill, '#ffffff'); // contrast fallback
});

test('nycMap: fixed black dot + white bullet in BOTH themes', () => {
  for (const dark of [false, true]) {
    const gs = nycMap.paint(single(), { dark, showBullets: true });
    assert.equal(circleOf(gs).fill, '#111111');
    assert.equal(textOf(gs).fill, '#ffffff');
  }
});

test('nycMap on-map capsule: fixed white pill / black border in BOTH themes; single-dot preview', () => {
  assert.equal(nycMap.previewKind, undefined); // preview tile is a single dot
  for (const dark of [false, true]) {
    const gs = nycMap.paint(pair(), { dark, showBullets: true });
    const paths = gs.filter((g) => g.kind === 'path') as Array<{ stroke: string }>;
    assert.equal(paths[0].stroke, '#111111'); // border
    assert.equal(paths[1].stroke, '#ffffff'); // fill
  }
});

test('showBullets false omits bullet text', () => {
  const gs = classic.paint(single(), { dark: false, showBullets: false });
  assert.ok(!gs.some((g) => g.kind === 'text'));
});
