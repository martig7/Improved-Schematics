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

test('a bullet fits inside its dot, letters as well as digits', () => {
  // Capitals in the bold stack run wider than digits, and the width a circle offers
  // at the text's own height is the chord there, not the diameter. Both together
  // used to push longer bullets out past the dot.
  const r = 10;
  const CAP = 0.72;
  const adv = (ch: string): number => (ch >= '0' && ch <= '9' ? 0.60 : 0.72);
  for (const name of ['A', '1', '4A', 'ABC', 'NCL', 'BLVE', 'WWWW', '12345']) {
    const fs = bulletFontSize(r, name);
    let w = 0;
    for (const ch of name) w += adv(ch);
    const halfW = w * fs / 2;
    const halfH = CAP * fs / 2;
    assert.ok(Math.sqrt(halfW * halfW + halfH * halfH) <= r + 1e-9, `${name} overflows its dot at ${fs.toFixed(2)}px`);
  }
});

test('a one-character bullet keeps the full prescribed size', () => {
  // The shrink must only ever bite on bullets that would not otherwise fit.
  for (const name of ['A', '1', 'M', 'W']) assert.equal(bulletFontSize(10, name), 17, name);
});

test('a longer bullet shrinks monotonically', () => {
  const sizes = ['A', 'AB', 'ABC', 'ABCD', 'ABCDE'].map((n) => bulletFontSize(10, n));
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] < sizes[i - 1], `${i} chars did not shrink`);
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
