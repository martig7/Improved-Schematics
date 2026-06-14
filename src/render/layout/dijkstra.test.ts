import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dijkstra, dijkstraMulti } from './dijkstra';

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

test('dijkstraMulti picks the cheapest source/target pair including entry costs', () => {
  // graph: s1 -(1)- m -(1)- t1 ; s2 -(1)- m ; m -(1)- t2
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['s1', [{ to: 'm', w: 1 }]],
    ['s2', [{ to: 'm', w: 1 }]],
    ['m', [{ to: 't1', w: 1 }, { to: 't2', w: 1 }]],
    ['t1', []],
    ['t2', []],
  ]);
  // Make s2 cheaper to enter, t2 cheaper to exit.
  const res = dijkstraMulti(
    new Map([['s1', 10], ['s2', 0]]),
    new Map([['t1', 10], ['t2', 0]]),
    (n) => adj.get(n) ?? [],
    100,
  );
  assert.ok(res);
  assert.equal(res!.path[0], 's2');
  assert.equal(res!.path.at(-1), 't2');
  // cost = entry(s2)=0 + edge s2->m=1 + edge m->t2=1 + entry(t2)=0 = 2
  assert.equal(res!.cost, 2);
});

test('dijkstraMulti returns null when no source reaches any target', () => {
  const adj = new Map<string, Array<{ to: string; w: number }>>([
    ['s', []],
    ['t', []],
  ]);
  const res = dijkstraMulti(new Map([['s', 0]]), new Map([['t', 0]]), (n) => adj.get(n) ?? [], 100);
  assert.equal(res, null);
});
