import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Block,
  flattenBlock,
  mirrorBlock,
  joinBlocks,
  blockLines,
  splitPlan,
  reorderToGroups,
} from '../blockAlgebra';

test('flatten: nested blocks flatten depth-first in order', () => {
  const b: Block = ['A', ['B', ['C', 'D']], 'E'];
  assert.deepEqual(flattenBlock(b), ['A', 'B', 'C', 'D', 'E']);
});

test('mirror: reverses at every nesting level, is an involution', () => {
  const b: Block = ['A', ['B', 'C'], 'D'];
  const m = mirrorBlock(b);
  assert.deepEqual(flattenBlock(m), ['D', 'C', 'B', 'A']);
  assert.deepEqual(mirrorBlock(m), b, 'mirror twice = identity');
});

test('join: nests both operands intact, side chooses order', () => {
  const a: Block = ['A1', 'A2'];
  const b: Block = ['B1'];
  assert.deepEqual(flattenBlock(joinBlocks(a, b, false)), ['A1', 'A2', 'B1']);
  assert.deepEqual(flattenBlock(joinBlocks(a, b, true)), ['B1', 'A1', 'A2']);
  // nesting survives: the joined block's items ARE the operands
  const j = joinBlocks(a, b, false);
  assert.equal(j.length, 2);
  assert.deepEqual(j[0], a);
  assert.deepEqual(j[1], b);
});

test('blockLines: set of all leaf lines', () => {
  const b: Block = ['A', ['B', ['C']]];
  assert.deepEqual([...blockLines(b)].sort(), ['A', 'B', 'C']);
});

test('splitPlan: contiguous exits are free (zero swaps)', () => {
  // order [A,B,C,D]; exits: {A,B} -> g0, {C,D} -> g1, already contiguous
  const groupOf = new Map([['A', 0], ['B', 0], ['C', 1], ['D', 1]]);
  const plan = splitPlan(['A', 'B', 'C', 'D'], groupOf);
  assert.equal(plan.swaps, 0);
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'D']);
});

test('splitPlan: interleaved exits need the bubble distance, order stable within groups', () => {
  // [A,C,B,D] with {A,B}=g0,{C,D}=g1: one adjacent swap (C<->B) fixes it
  const groupOf = new Map([['A', 0], ['B', 0], ['C', 1], ['D', 1]]);
  const plan = splitPlan(['A', 'C', 'B', 'D'], groupOf);
  assert.equal(plan.swaps, 1);
  assert.deepEqual(plan.order, ['A', 'B', 'C', 'D'], 'stable within groups');
});

test('splitPlan: group order follows first-appearance when targets tie', () => {
  // [C,A,D,B]: g1 appears first -> target group order [g1, g0]
  const groupOf = new Map([['A', 0], ['B', 0], ['C', 1], ['D', 1]]);
  const plan = splitPlan(['C', 'A', 'D', 'B'], groupOf);
  assert.deepEqual(plan.order, ['C', 'D', 'A', 'B']);
  assert.equal(plan.swaps, 1); // from [C,A,D,B] to [C,D,A,B] only pair (A,D) inverts
});

test('reorderToGroups: inversion count equals adjacent-transposition distance', () => {
  const groupOf = new Map([['A', 0], ['B', 1]]);
  const plan = splitPlan(['B', 'A'], groupOf);
  assert.equal(plan.swaps, 0, 'single-line groups in first-appearance order are already contiguous');
  // force a desired group order via explicit target ranks
  const r = reorderToGroups(['B', 'A'], new Map([['A', 0], ['B', 1]]), [0, 1]);
  assert.deepEqual(r.order, ['A', 'B']);
  assert.equal(r.swaps, 1);
});
