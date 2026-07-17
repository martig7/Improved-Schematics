import { test } from 'node:test';
import assert from 'node:assert';
import { computePaintGroups } from '../paintLayers';

test('paint groups: co-running trunk families cluster; a crosser stays its own layer', () => {
  // two 2-line trunks (a1+a2 over eA1/eA2, b1+b2 over eB1/eB2) and a lone
  // crosser x sharing only a short edge with the a-trunk
  const orderOf = new Map<string, string[]>([
    ['eA1', ['a1', 'a2']],
    ['eA2', ['a1', 'a2']],
    ['eB1', ['b1', 'b2']],
    ['eB2', ['b1', 'b2']],
    ['eShared', ['a1', 'a2', 'x']],
    ['eX', ['x']],
  ]);
  const arcOf = new Map<string, number>([
    ['eA1', 100], ['eA2', 100], ['eB1', 90], ['eB2', 90], ['eShared', 10], ['eX', 100],
  ]);
  const groups = computePaintGroups(orderOf, arcOf, ['a1', 'a2', 'b1', 'b2', 'x']);
  assert.deepEqual(groups, [
    ['a1', 'a2'], // 210 arc each: longest first
    ['b1', 'b2'],
    ['x'],        // 10/110 share with the a-trunk: below half, own layer
  ]);
});

test('paint groups: a line spending most of its length with a bundle joins it', () => {
  const orderOf = new Map<string, string[]>([
    ['e1', ['t1', 't2', 'j']],
    ['e2', ['t1', 't2', 'j']],
    ['e3', ['j']],
  ]);
  const arcOf = new Map<string, number>([['e1', 100], ['e2', 100], ['e3', 50]]);
  const groups = computePaintGroups(orderOf, arcOf, ['t1', 't2', 'j']);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], ['t1', 't2', 'j']);
});

test('paint groups: cover every line, including undrawn ones', () => {
  const orderOf = new Map<string, string[]>([['e1', ['a']]]);
  const arcOf = new Map<string, number>([['e1', 10]]);
  const groups = computePaintGroups(orderOf, arcOf, ['a', 'ghost']);
  assert.deepEqual(groups.flat().sort(), ['a', 'ghost']);
});
