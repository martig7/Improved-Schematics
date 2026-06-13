import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeEndpointOrders } from './edgeOrders';
import type { LayoutEdge } from './types';

const E = (over: Partial<LayoutEdge>): LayoutEdge => ({
  id: 'e', from: 'a', to: 'b', path: [[0, 0], [1, 0]],
  lines: [], lineOrder: ['L1', 'L2', 'L3'], stops: new Map(), ...over,
});

test('edgeEndpointOrders: defaults both ends to lineOrder', () => {
  const { from, to } = edgeEndpointOrders(E({}));
  assert.deepEqual(from, ['L1', 'L2', 'L3']);
  assert.deepEqual(to, ['L1', 'L2', 'L3']);
});

test('edgeEndpointOrders: uses orderFrom/orderTo when present', () => {
  const { from, to } = edgeEndpointOrders(E({ orderFrom: ['L2', 'L1', 'L3'], orderTo: ['L1', 'L3', 'L2'] }));
  assert.deepEqual(from, ['L2', 'L1', 'L3']);
  assert.deepEqual(to, ['L1', 'L3', 'L2']);
});

test('edgeEndpointOrders: returns copies (caller cannot mutate the edge)', () => {
  const e = E({});
  const { from } = edgeEndpointOrders(e);
  from.push('X');
  assert.deepEqual(e.lineOrder, ['L1', 'L2', 'L3']);
});
