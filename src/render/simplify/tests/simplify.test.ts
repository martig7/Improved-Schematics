import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIMPLIFIED_STYLES, DEFAULT_SIMPLIFIED_STYLE, getSimplifiedStyle,
  resolveSimplifiedLines, simplifiedSignature, paramsFor, sameSimplified,
} from '../index';

test('registry: ids are unique and the default id resolves', () => {
  const ids = SIMPLIFIED_STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'style ids unique');
  assert.ok(ids.includes(DEFAULT_SIMPLIFIED_STYLE), 'the default id is a real style');
  assert.equal(getSimplifiedStyle(DEFAULT_SIMPLIFIED_STYLE).id, DEFAULT_SIMPLIFIED_STYLE);
});

test('getSimplifiedStyle: unknown/absent falls back rather than throwing', () => {
  assert.equal(getSimplifiedStyle('no-such-style').id, DEFAULT_SIMPLIFIED_STYLE);
  assert.equal(getSimplifiedStyle(undefined).id, DEFAULT_SIMPLIFIED_STYLE);
});

test('default style: a thin bare line that still shows its ends', () => {
  const d = getSimplifiedStyle('default');
  assert.equal(d.lineWidthScale, 0.25);
  assert.equal(d.casing, false);
  assert.equal(d.stationMarks, 'intersection', 'ends + interchanges keep a marker');
  assert.equal(d.labels, 'intersection', 'ends + interchanges keep their name');
});

test('registry: every style declares valid marker/label scopes', () => {
  const scale = ['all', 'intersection', 'termini', 'none'];
  for (const s of SIMPLIFIED_STYLES) {
    assert.ok(scale.includes(s.stationMarks), `${s.id} stationMarks`);
    assert.ok(scale.includes(s.labels), `${s.id} labels`);
    assert.ok(s.lineWidthScale > 0, `${s.id} draws a visible stroke`);
  }
});

test('resolve: no setting -> empty map (the untouched draw path)', () => {
  assert.equal(resolveSimplifiedLines(undefined, undefined, undefined).size, 0);
  assert.equal(resolveSimplifiedLines({}, undefined, undefined).size, 0);
});

test('resolve: identity mapping when routes are their own lines', () => {
  const canon = new Map([['r1', 'r1'], ['r2', 'r2']]);
  const out = resolveSimplifiedLines({ r1: 'default' }, canon, ['r1', 'r2']);
  assert.equal(out.size, 1);
  assert.equal(out.get('r1')?.style.id, 'default');
  assert.equal(out.has('r2'), false);
});

test('resolve: a merged line needs EVERY one of its routes simplified', () => {
  // r1 and r2 are drawn as the SAME line; simplifying only r1 must not thin it,
  // or the route the user left alone would vanish into a hairline.
  const canon = new Map([['r1', 'r1'], ['r2', 'r1']]);
  const partial = resolveSimplifiedLines({ r1: 'default' }, canon, ['r1', 'r2']);
  assert.equal(partial.size, 0, 'partially simplified merged line is left alone');

  const both = resolveSimplifiedLines({ r1: 'default', r2: 'default' }, canon, ['r1', 'r2']);
  assert.equal(both.size, 1);
  assert.equal(both.get('r1')?.style.id, 'default');
});

test('resolve: mixed styles on one drawn line are rejected', () => {
  // Agreement is judged on the RESOLVED display, so this needs two genuinely
  // different styles (two unknown ids both falling back to default really do
  // agree on what to draw).
  const canon = new Map([['r1', 'r1'], ['r2', 'r1']]);
  const out = resolveSimplifiedLines({ r1: 'default', r2: 'dashed' }, canon, ['r1', 'r2']);
  assert.equal(out.size, 0);
});

test('resolve: one drawn line, same style but different settings, is rejected', () => {
  const canon = new Map([['r1', 'r1'], ['r2', 'r1']]);
  const out = resolveSimplifiedLines(
    { r1: { style: 'dashed', params: { dashLength: 6 } }, r2: { style: 'dashed', params: { dashLength: 20 } } },
    canon, ['r1', 'r2'],
  );
  assert.equal(out.size, 0, 'no single answer for what to draw');
});

test('paramsFor: fills defaults, clamps to range, drops unknown keys', () => {
  const dashed = getSimplifiedStyle('dashed');
  const spec = dashed.settings!.find((s) => s.key === 'dashLength')!;
  assert.equal(paramsFor(dashed, undefined).dashLength, spec.default, 'absent -> default');
  assert.equal(paramsFor(dashed, { dashLength: NaN }).dashLength, spec.default, 'non-finite -> default');
  assert.equal(paramsFor(dashed, { dashLength: spec.max + 999 }).dashLength, spec.max, 'clamped high');
  assert.equal(paramsFor(dashed, { dashLength: spec.min - 999 }).dashLength, spec.min, 'clamped low');
  assert.equal(paramsFor(dashed, { bogus: 3 } as Record<string, number>).bogus, undefined, 'unknown key dropped');
  // A style with no settings resolves to an empty param set, never undefined.
  assert.deepEqual(paramsFor(getSimplifiedStyle('default'), { dashLength: 5 }), {});
});

test('resolve: dashed yields a concrete on/off pattern from its setting', () => {
  const canon = new Map([['r1', 'r1']]);
  const at = (dashLength?: number) =>
    resolveSimplifiedLines(
      { r1: dashLength === undefined ? 'dashed' : { style: 'dashed', params: { dashLength } } },
      canon, ['r1'],
    ).get('r1');
  const dflt = getSimplifiedStyle('dashed').settings!.find((s) => s.key === 'dashLength')!.default;
  assert.deepEqual(at()?.dash, [dflt, dflt], 'gapRatio 1 -> equal on/off at the default');
  assert.deepEqual(at(7)?.dash, [7, 7]);
  assert.equal(at(7)?.style.id, 'dashed');
  // The solid style declares no dash at all.
  assert.equal(resolveSimplifiedLines({ r1: 'default' }, canon, ['r1']).get('r1')?.dash, undefined);
});

test('signature ignores dash length: it must not bust label/capsule memos', () => {
  const canon = new Map([['r1', 'r1']]);
  const sig = (dashLength: number) =>
    simplifiedSignature(resolveSimplifiedLines(
      { r1: { style: 'dashed', params: { dashLength } } }, canon, ['r1'],
    ));
  assert.equal(sig(4), sig(30), 'a dash tweak changes no per-stop scope');
});

test('sameSimplified: compares style AND settings, ignoring stored form', () => {
  assert.ok(sameSimplified({ r1: 'dashed' }, { r1: { style: 'dashed' } }), 'shorthand == explicit defaults');
  assert.ok(sameSimplified({ r1: { style: 'dashed', params: { dashLength: 9 } } }, { r1: { style: 'dashed', params: { dashLength: 9 } } }));
  assert.ok(!sameSimplified({ r1: { style: 'dashed', params: { dashLength: 9 } } }, { r1: { style: 'dashed', params: { dashLength: 4 } } }));
  assert.ok(!sameSimplified({ r1: 'dashed' }, { r1: 'default' }));
  assert.ok(!sameSimplified({ r1: 'dashed' }, {}));
  assert.ok(sameSimplified({}, {}));
});

test('resolve: unknown style id still resolves to a usable style', () => {
  const canon = new Map([['r1', 'r1']]);
  const out = resolveSimplifiedLines({ r1: 'no-such-style' }, canon, ['r1']);
  assert.equal(out.get('r1')?.style.id, DEFAULT_SIMPLIFIED_STYLE);
});

test('signature: stable, order-independent, and empty for no simplification', () => {
  assert.equal(simplifiedSignature(new Map()), '');
  const canon = new Map([['a', 'a'], ['b', 'b']]);
  const s1 = simplifiedSignature(resolveSimplifiedLines({ a: 'default', b: 'default' }, canon, ['a', 'b']));
  const s2 = simplifiedSignature(resolveSimplifiedLines({ b: 'default', a: 'default' }, canon, ['b', 'a']));
  assert.equal(s1, s2, 'key order does not change the signature');
  const s3 = simplifiedSignature(resolveSimplifiedLines({ a: 'default' }, canon, ['a', 'b']));
  assert.notEqual(s1, s3, 'a different set yields a different signature');
});
