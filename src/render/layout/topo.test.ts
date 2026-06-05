import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, polylineLength, densify, creepBlocked } from './topo';
import type { Pixel } from './types';

test('dist computes euclidean distance', () => {
  assert.equal(dist([0, 0], [3, 4]), 5);
});

test('polylineLength sums segment lengths', () => {
  assert.equal(polylineLength([[0, 0], [0, 10], [10, 10]]), 20);
});

test('densify produces equispaced points including both endpoints', () => {
  const pts = densify([[0, 0], [0, 10]], 2.5);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [0, 10]);
  // 10 / 2.5 = 4 segments -> 5 points
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[1], [0, 2.5]);
});

test('densify never returns fewer than the two endpoints', () => {
  const pts = densify([[0, 0], [1, 0]], 100);
  assert.deepEqual(pts, [[0, 0], [1, 0]]);
});

test('creepBlocked rejects a candidate that interlaces an obtuse meeting', () => {
  // samples along a straight run; p1 far left, pl far right.
  const samples: Pixel[] = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const pk: Pixel = [20, 0];
  // candidate sitting almost on top of p_k: alpha*dist(pk,p1)=0.707*20=14.1 > 0
  // distance to candidate ~0, so 14.1 <= 0 is false AND 0.707*10 <= 0 false -> NOT blocked
  assert.equal(creepBlocked([20.1, 0], pk, samples), false);
  // a candidate far from p_k relative to its distance to the ends IS blocked:
  // dist(pk, far)=15 ; alpha*dist(pk,p1)=14.1 <= 15 -> blocked
  assert.equal(creepBlocked([20, 15], pk, samples), true);
});
