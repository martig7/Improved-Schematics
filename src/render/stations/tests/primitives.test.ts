import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastInk, bulletFontSize, dotStrokeWidth, capsuleStrokeWidths, capsuleGlyphs, circle, bullet, text, fitFontSize } from '../primitives';

test('contrastInk picks readable ink by luminance', () => {
  assert.equal(contrastInk('#000000'), '#ffffff');
  assert.equal(contrastInk('#ffffff'), '#111111');
  assert.equal(contrastInk('#fccc0a'), '#111111');
});

test('bulletFontSize shrinks for multi-char names', () => {
  assert.equal(bulletFontSize(10, 'A'), 17);
  assert.ok(bulletFontSize(10, 'ABC') < 17);
});

test('circle carries optional data attrs', () => {
  const g = circle(1, 2, 3, { fill: '#fff', stroke: '#000', strokeWidth: 1.5, data: { 'data-line': 'L1' } });
  assert.equal(g.kind, 'circle');
  assert.deepEqual(g.data, { 'data-line': 'L1' });
});

test('bullet places text below the dot center', () => {
  const g = bullet(10, 20, 'A', 13, '#111111');
  assert.equal(g.kind, 'text');
  assert.equal(g.text, 'A');
  assert.ok((g as { y: number }).y > 20); // fs*0.36 offset
});

test('capsuleGlyphs: ring -> one circle, pill -> two paths', () => {
  const ring = capsuleGlyphs({ kind: 'ring', cx: 5, cy: 5, r: 6 }, { border: '#111111', fill: '#ffffff' }, 3);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].kind, 'circle');
  const pill = capsuleGlyphs({ kind: 'pill', points: [[0, 0], [10, 0]], smooth: false }, { border: '#111111', fill: '#ffffff' }, 3);
  assert.equal(pill.length, 2);
  assert.equal(pill[0].kind, 'path');
  assert.equal((pill[0] as { stroke: string }).stroke, '#111111'); // border first
  assert.equal((pill[1] as { stroke: string }).stroke, '#ffffff'); // fill second
  const w = capsuleStrokeWidths(3);
  assert.ok(w.border > w.fill);
});

test('capsuleGlyphs none -> empty', () => {
  assert.deepEqual(capsuleGlyphs({ kind: 'none' }, { border: '#000', fill: '#fff' }, 3), []);
});

test('fitFontSize caps at the prescribed size and shrinks only when text overflows', () => {
  // Short text well within the box: returns the prescribed size UNCHANGED
  // (identical float), so non-overflowing markers stay byte-identical.
  assert.equal(fitFontSize('05', 20, 100), 20);
  assert.equal(fitFontSize('', 20, 5), 20);
  assert.equal(fitFontSize('A', 20, 0), 20); // guard: no width -> unchanged
  // Overflowing text shrinks below the prescribed size, monotonically longer.
  const three = fitFontSize('137', 20, 12);
  const four = fitFontSize('1234', 20, 12);
  assert.ok(three < 20 && four < three);
  // Fitted width does not exceed the budget (0.60 em/digit model).
  assert.ok(three * 3 * 0.6 <= 12 + 1e-9);
});

test('text() bakes the width fit only when maxWidth is given', () => {
  const plain = text(0, 0, '137', { fontSize: 20, fill: '#000' });
  assert.equal((plain as { fontSize: number }).fontSize, 20, 'no maxWidth -> prescribed size');
  const fitted = text(0, 0, '137', { fontSize: 20, fill: '#000', maxWidth: 12 });
  assert.ok((fitted as { fontSize: number }).fontSize < 20, 'maxWidth -> shrunk to fit');
});
