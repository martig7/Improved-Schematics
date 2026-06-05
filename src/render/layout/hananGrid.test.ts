import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHananGrid } from './hananGrid';
import type { Pixel } from './types';

test('a 2x2 grid of stations yields 4 station grid nodes with octilinear neighbours', () => {
  const positions = new Map<string, Pixel>([
    ['a', [0, 0]],
    ['b', [100, 0]],
    ['c', [0, 100]],
    ['d', [100, 100]],
  ]);
  const g = buildHananGrid(positions, { snapCell: 100, padding: 0 });
  assert.equal(g.stationNodeKeys.size, 4);
  // The 4 station positions should each correspond to a grid node.
  const distinct = new Set(g.stationNodeKeys.values());
  assert.equal(distinct.size, 4);
  // Each station should have at least 2 octilinear neighbours within the grid.
  for (const key of distinct) {
    const neighbours = g.adj.get(key) ?? [];
    assert.ok(neighbours.length >= 2, `station ${key} should have >=2 neighbours, got ${neighbours.length}`);
  }
});

test('snap collapses nearby stations to the same grid node', () => {
  const positions = new Map<string, Pixel>([
    ['a', [0, 0]],
    ['b', [3, 4]], // well within cell of size 50 → snaps to (0,0)
  ]);
  const g = buildHananGrid(positions, { snapCell: 50, padding: 0 });
  assert.equal(g.stationNodeKeys.get('a'), g.stationNodeKeys.get('b'));
});

test('neighbour directions are valid octilinear (0..7)', () => {
  const positions = new Map<string, Pixel>([
    ['a', [0, 0]],
    ['b', [100, 0]],
    ['c', [0, 100]],
  ]);
  const g = buildHananGrid(positions, { snapCell: 100, padding: 0 });
  for (const adj of g.adj.values()) {
    for (const e of adj) {
      assert.ok(e.dir >= 0 && e.dir < 8, `dir ${e.dir} out of range`);
      assert.ok(e.len > 0, `len should be positive, got ${e.len}`);
    }
  }
});

test('every adjacency edge is symmetric (reverse direction also present)', () => {
  const positions = new Map<string, Pixel>([
    ['a', [0, 0]],
    ['b', [100, 0]],
    ['c', [100, 100]],
  ]);
  const g = buildHananGrid(positions, { snapCell: 100, padding: 0 });
  for (const [k, adj] of g.adj) {
    for (const e of adj) {
      const rev = (g.adj.get(e.to) ?? []).find((r) => r.to === k);
      assert.ok(rev, `missing reverse edge from ${e.to} to ${k}`);
    }
  }
});
