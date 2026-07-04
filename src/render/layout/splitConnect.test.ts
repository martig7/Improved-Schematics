import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSplitConnectors } from './splitConnect';
import type { Pixel } from './types';

test('MST joins N units with N-1 connectors at nearest dot pairs', () => {
  // three units in an L: 0-1 (100px) and 1-2 (80px) are the MST edges
  const units = [
    { id: 'a', dots: [[0, 0]] as Pixel[] },
    { id: 'b', dots: [[100, 0]] as Pixel[] },
    { id: 'c', dots: [[100, 80]] as Pixel[] },
  ];
  const cs = planSplitConnectors(units, []);
  assert.equal(cs.length, 2);
  // both edges are axis-aligned already: no elbow corner
  for (const c of cs) assert.equal(c.corner, null, `unexpected elbow: ${JSON.stringify(c)}`);
});

test('elbow corner picks the L that grazes other markers least', () => {
  const units = [
    { id: 'a', dots: [[0, 0]] as Pixel[] },
    { id: 'b', dots: [[100, 60]] as Pixel[] },
  ];
  // a foreign marker sits at (100, 10) — near candidate corner (100, 0);
  // the connector must take the other elbow, via (0, 60)
  const cs = planSplitConnectors(units, [[100, 10]]);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].corner, [0, 60]);
});

test('nearest dot pair is chosen, not centroids', () => {
  const units = [
    { id: 'a', dots: [[0, 0], [0, 50]] as Pixel[] },
    { id: 'b', dots: [[30, 50], [30, 100]] as Pixel[] },
  ];
  const cs = planSplitConnectors(units, []);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].a, [0, 50]);
  assert.deepEqual(cs[0].b, [30, 50]);
});
