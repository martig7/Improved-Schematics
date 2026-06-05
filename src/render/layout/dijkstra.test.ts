import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dijkstra } from './dijkstra';

test('dijkstra finds the cheapest path on a tiny weighted graph', () => {
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['0', [{ to: '1', w: 1 }, { to: '2', w: 5 }]],
    ['1', [{ to: '2', w: 1 }, { to: '0', w: 1 }]],
    ['2', []],
  ]);
  const res = dijkstra('0', '2', (n) => adj.get(n) ?? [], () => 0);
  assert.deepEqual(res?.path, ['0', '1', '2']);
  assert.equal(res?.cost, 2);
});

test('dijkstra returns null when no path exists', () => {
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['0', []],
    ['1', []],
  ]);
  const res = dijkstra('0', '1', (n) => adj.get(n) ?? [], () => 0);
  assert.equal(res, null);
});

test('dijkstra handles trivial start === goal', () => {
  const res = dijkstra('0', '0', () => [], () => 0);
  assert.deepEqual(res?.path, ['0']);
  assert.equal(res?.cost, 0);
});

test('dijkstra respects expansion budget and returns null on overflow', () => {
  // Chain of 1000 nodes; budget=5 → can't reach the goal.
  const adj = new Map<string, Array<{ to: string; w: number }>>();
  for (let i = 0; i < 1000; i++) {
    adj.set(String(i), [{ to: String(i + 1), w: 1 }]);
  }
  const res = dijkstra('0', '999', (n) => adj.get(n) ?? [], () => 0, 5);
  assert.equal(res, null);
});
