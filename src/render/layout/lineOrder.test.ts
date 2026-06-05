import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderLines } from './lineOrder';
import { octilinearLayout } from './octilinear';
import { twoLineGraph } from './_fixtures';

test('orderLines is deterministic and preserves line membership', () => {
  const layout = octilinearLayout(twoLineGraph());
  orderLines(layout);
  const before = layout.edges.map((e) => [...e.lineOrder]);
  orderLines(layout);
  const after = layout.edges.map((e) => [...e.lineOrder]);
  assert.deepEqual(after, before); // idempotent / stable
  for (const e of layout.edges) {
    assert.equal(e.lineOrder.length, e.lines.length);
    assert.deepEqual([...e.lineOrder].sort(), e.lines.map((l) => l.id).sort());
  }
});
