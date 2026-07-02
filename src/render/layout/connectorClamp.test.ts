import { test } from 'node:test';
import assert from 'node:assert';
import { connectorControls } from './connectorClamp';

const SQ = Math.SQRT1_2;
// Max |perpendicular-to-dirB| excursion of the cubic vs the pb lane, sampled.
function overshoot(pa: [number, number], pb: [number, number], c1: [number, number], c2: [number, number], dirB: [number, number]): number {
  const nB = [-dirB[1], dirB[0]];
  const lanePB = pb[0] * nB[0] + pb[1] * nB[1];
  const lanePA = pa[0] * nB[0] + pa[1] * nB[1];
  const lo = Math.min(lanePA, lanePB), hi = Math.max(lanePA, lanePB);
  let worst = 0;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const u = 1 - t;
    const x = u*u*u*pa[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*pb[0];
    const y = u*u*u*pa[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*pb[1];
    const lane = x * nB[0] + y * nB[1];
    worst = Math.max(worst, Math.max(lo - lane, lane - hi, 0));
  }
  return worst;
}

test('connectorControls: LON spike geometry — overshoot collapses to < 0.5px', () => {
  const pa: [number, number] = [1454.9, 1389.3], pb: [number, number] = [1490.3, 1394.9];
  const dirA: [number, number] = [SQ, SQ], dirB: [number, number] = [1, 0];
  const { c1, c2 } = connectorControls(pa, pb, dirA, dirB, 22.0);
  assert.ok(overshoot(pa, pb, c1, c2, dirB) < 0.5, `overshoot ${overshoot(pa, pb, c1, c2, dirB)}`);
});

test('connectorControls: large lateral jog (NYC-scale) keeps the base tangent', () => {
  // 60px slot jump across the corridor: lat=60 >> kBase*perpA — clamp inactive.
  const pa: [number, number] = [0, 0], pb: [number, number] = [40, 60];
  const { c1 } = connectorControls(pa, pb, [SQ, SQ], [1, 0], 22.0);
  assert.ok(Math.abs(c1[0] - (0 + SQ * 22)) < 1e-9); // full kBase used
});

test('connectorControls: collinear ends unchanged', () => {
  const { c1, c2 } = connectorControls([0, 0], [50, 0], [1, 0], [1, 0], 22.0);
  assert.deepEqual(c1, [22, 0]);
  assert.deepEqual(c2, [28, 0]);
});
