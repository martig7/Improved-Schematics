import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIMPLIFIED_STYLES, DEFAULT_SIMPLIFIED_STYLE, getSimplifiedStyle,
  resolveSimplifiedLines, simplifiedSignature,
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

test('default style: a bare thin line (quarter width, nothing else drawn)', () => {
  const d = getSimplifiedStyle('default');
  assert.equal(d.lineWidthScale, 0.25);
  assert.equal(d.casing, false);
  assert.equal(d.stationMarks, false);
  assert.equal(d.capsuleMember, false);
  assert.equal(d.labels, false);
});

test('resolve: no setting -> empty map (the untouched draw path)', () => {
  assert.equal(resolveSimplifiedLines(undefined, undefined, undefined).size, 0);
  assert.equal(resolveSimplifiedLines({}, undefined, undefined).size, 0);
});

test('resolve: identity mapping when routes are their own lines', () => {
  const canon = new Map([['r1', 'r1'], ['r2', 'r2']]);
  const out = resolveSimplifiedLines({ r1: 'default' }, canon, ['r1', 'r2']);
  assert.equal(out.size, 1);
  assert.equal(out.get('r1')?.id, 'default');
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
  assert.equal(both.get('r1')?.id, 'default');
});

test('resolve: mixed styles on one drawn line are rejected', () => {
  const canon = new Map([['r1', 'r1'], ['r2', 'r1']]);
  const out = resolveSimplifiedLines({ r1: 'default', r2: 'other' }, canon, ['r1', 'r2']);
  assert.equal(out.size, 0);
});

test('resolve: unknown style id still resolves to a usable style', () => {
  const canon = new Map([['r1', 'r1']]);
  const out = resolveSimplifiedLines({ r1: 'no-such-style' }, canon, ['r1']);
  assert.equal(out.get('r1')?.id, DEFAULT_SIMPLIFIED_STYLE);
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
