import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRings } from './marchingSquares';
import { buildWaterMask } from './grid';
import type { OceanIndex } from './types';

function idx(W: number, H: number, cells: number[][]): OceanIndex {
  return { cs: 1, bbox: [0, 0, W, H], grid: [W, H], cells, depths: [], stats: {} };
}

test('single water cell → one 4-corner ring', () => {
  const rings = traceRings(buildWaterMask(idx(3, 3, [[1, 1]])));
  assert.equal(rings.length, 1);
  const r = rings[0];
  assert.deepEqual(r[0], r[r.length - 1]); // closed
  assert.equal(r.length, 5); // 4 corners + close
});

test('water square with a land hole → two rings (outer + hole)', () => {
  const cells: number[][] = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) if (!(c === 1 && r === 1)) cells.push([c, r]);
  const rings = traceRings(buildWaterMask(idx(3, 3, cells)));
  assert.equal(rings.length, 2);
});

test('two separate water cells → two rings', () => {
  const rings = traceRings(buildWaterMask(idx(5, 1, [[0, 0], [3, 0]])));
  assert.equal(rings.length, 2);
});
