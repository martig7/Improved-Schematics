import { test } from 'node:test';
import assert from 'node:assert';
import { findParallelPairs } from '../corridorSep';
import type { Pixel } from '../types';

const SP = 6;

test('separation: near-parallel sub-clearance edges pair with signed offset', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['b', [[0, 3], [100, 5]]], // ~1 deg divergence, 3-5px away for the whole run
  ]);
  const pairs = findParallelPairs(['a', 'b'], (id) => polys.get(id), () => 0, SP);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].eA, 'a');
  assert.equal(pairs[0].sign, 1);
  assert.ok(pairs[0].d0 > 2.5 && pairs[0].d0 < 5, 'offset ~3-4.5: ' + pairs[0].d0);
  assert.equal(pairs[0].needed, SP);
});

test('separation: antiparallel edges pair with sign -1', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['b', [[100, 4], [0, 4]]],
  ]);
  const pairs = findParallelPairs(['a', 'b'], (id) => polys.get(id), () => 0, SP);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].sign, -1);
  assert.ok(Math.abs(pairs[0].d0 - 4) < 0.5, 'offset ~4: ' + pairs[0].d0);
});

test('separation: perpendicular and end-to-end edges do not pair', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['x', [[50, -50], [50, 50]]],   // perpendicular crossing
    ['c', [[100, 0], [200, 0]]],    // collinear continuation
  ]);
  const pairs = findParallelPairs(['a', 'c', 'x'], (id) => polys.get(id), () => 0, SP);
  assert.equal(pairs.filter((p) => p.eB === 'x' || p.eA === 'x').length, 0, 'no perpendicular pair');
  // the collinear continuation only touches at the shared endpoint: the
  // near-parallel sub-clearance RUN there is a single point, not sustained
  assert.equal(pairs.filter((p) => (p.eA === 'a' && p.eB === 'c')).length, 0, 'no end-to-end pair');
});

test('separation: clear edges (beyond combined reach) do not pair', () => {
  const polys = new Map<string, Pixel[]>([
    ['a', [[0, 0], [100, 0]]],
    ['b', [[0, 20], [100, 20]]],
  ]);
  const pairs = findParallelPairs(['a', 'b'], (id) => polys.get(id), () => 3, SP);
  // needed = 3 + 3 + 6 = 12 < 20 apart
  assert.equal(pairs.length, 0);
});
