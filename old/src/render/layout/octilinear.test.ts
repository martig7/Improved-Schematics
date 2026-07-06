import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octilinearLayout } from './octilinear';
import { cellKey } from './grid';
import { lineGraph } from './_fixtures';

test('octilinearLayout assigns a unique grid cell per node', () => {
  const graph = lineGraph([
    [0, 0],
    [100, 30],
    [200, 10],
    [300, 80],
  ]);
  const layout = octilinearLayout(graph);
  const seen = new Set<string>();
  for (const n of layout.nodes.values()) {
    const k = cellKey(n.cell);
    assert.ok(!seen.has(k), 'no two nodes share a cell');
    seen.add(k);
  }
  assert.equal(layout.cellSize, 3);
  assert.equal(layout.edges.length, 3);
});

test('octilinearLayout edge paths start and end at node cells', () => {
  const graph = lineGraph([
    [0, 0],
    [100, 0],
    [200, 0],
  ]);
  const layout = octilinearLayout(graph);
  for (const e of layout.edges) {
    const from = layout.nodes.get(e.from)!.cell;
    const to = layout.nodes.get(e.to)!.cell;
    assert.equal(cellKey(e.path[0]), cellKey(from));
    assert.equal(cellKey(e.path[e.path.length - 1]), cellKey(to));
  }
});
