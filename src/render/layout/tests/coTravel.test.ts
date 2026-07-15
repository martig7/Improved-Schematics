import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coTravelComponents } from '../coTravel';

// synthetic strength matrix: two tight pairs {A,B},{C,D} (share 5), a foreign
// line X that shares 2 with A only, everything else shares 1 (the universal
// baseline). tie() is a total order used only to break ties deterministically.
const mk = (m: Record<string, Record<string, number>>) => (a: string, b: string) =>
  a === b ? Infinity : (m[a]?.[b] ?? m[b]?.[a] ?? 0);

const S = mk({
  A: { B: 5, C: 1, D: 1, X: 2 },
  B: { C: 1, D: 1, X: 1 },
  C: { D: 5, X: 1 },
  D: { X: 1 },
});
const tie = (l: string) => l.charCodeAt(0);

test('coTravel: tight pairs group, weak-shared foreign line stays out (T=3)', () => {
  const comp = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 3);
  assert.equal(comp.get('A'), comp.get('B'), 'A,B together');
  assert.equal(comp.get('C'), comp.get('D'), 'C,D together');
  assert.notEqual(comp.get('A'), comp.get('C'), 'the two pairs are distinct groups');
  assert.notEqual(comp.get('X'), comp.get('A'), 'X (shares only 2 < 3) is not pulled into A,B');
});

test('coTravel: a low threshold merges the weak link (T=2 pulls X in)', () => {
  const comp = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 2);
  assert.equal(comp.get('X'), comp.get('A'), 'at T=2 the A-X link (=2) joins X to A');
});

test('coTravel: deterministic under input line reordering', () => {
  const c1 = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 3);
  const c2 = coTravelComponents(['X', 'D', 'C', 'B', 'A'], S, tie, 3);
  // component ids are assigned by first appearance in tie order, so the
  // partition (grouping) is identical regardless of input order
  const part = (c: Map<string, number>) => {
    const g = new Map<number, string[]>();
    for (const [l, id] of c) {
      let arr = g.get(id);
      if (!arr) g.set(id, (arr = []));
      arr.push(l);
    }
    return [...g.values()].map((ls) => ls.sort().join('')).sort();
  };
  assert.deepEqual(part(c1), part(c2));
});

test('coTravel: singletons when nothing clears the threshold', () => {
  const comp = coTravelComponents(['A', 'B', 'C', 'D', 'X'], S, tie, 6);
  assert.equal(new Set(comp.values()).size, 5, 'all isolated at T=6');
});
