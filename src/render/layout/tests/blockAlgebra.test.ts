import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Block,
  flattenBlock,
  mirrorBlock,
  joinBlocks,
  blockLines,
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

test('reorderToGroups: inversion count equals adjacent-transposition distance', () => {
  // force a desired group order via explicit target ranks
  const r = reorderToGroups(['B', 'A'], new Map([['A', 0], ['B', 1]]), [0, 1]);
  assert.deepEqual(r.order, ['A', 'B']);
  assert.equal(r.swaps, 1);
});
