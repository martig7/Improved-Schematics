import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropLaneToShape, cropLaneToRect, insetShape, type CropShape } from '../laneCrop';

type P = [number, number];
const onCircle = (p: P, cx: number, cy: number, r: number, tol = 1e-6) =>
  Math.abs(Math.sqrt((p[0] - cx) ** 2 + (p[1] - cy) ** 2) - r) < tol;

test('cropLaneToShape rect: delegates to the rectangle crop (byte-identical)', () => {
  const poly: P[] = [[-30, 0], [30, 0]];
  const box = { x0: -10, x1: 10, y0: -10, y1: 10 };
  const viaShape = cropLaneToShape(poly, { kind: 'rect', ...box });
  const viaRect = cropLaneToRect(poly, box);
  assert.deepEqual(viaShape, viaRect);
  assert.deepEqual(viaShape[0], [-10, 0]);
});

test('cropLaneToShape disc CUT: a lane through the disc starts on the boundary', () => {
  // node end at (-30,0) outside, running +x through a disc of radius 10 at origin
  const disc: CropShape = { kind: 'disc', cx: 0, cy: 0, r: 10 };
  const out = cropLaneToShape([[-30, 0], [30, 0]], disc);
  assert.deepEqual(out[0], [-10, 0]);
  assert.ok(onCircle(out[0], 0, 0, 10));
  assert.deepEqual(out[out.length - 1], [30, 0], 'far end preserved');
});

test('cropLaneToShape disc INSIDE: node end inside exits at the boundary', () => {
  // node end at the center, running +x out through the disc
  const disc: CropShape = { kind: 'disc', cx: 0, cy: 0, r: 10 };
  const out = cropLaneToShape([[0, 0], [30, 0]], disc);
  assert.deepEqual(out[0], [10, 0]);
  assert.ok(onCircle(out[0], 0, 0, 10));
});

test('cropLaneToShape disc: a lane short of the disc extends to it within maxExt', () => {
  const disc: CropShape = { kind: 'disc', cx: 0, cy: 0, r: 10 };
  // node end at (-16,0), running away (-x) so the polyline never reaches; extend
  // the node end back toward the disc (its own outward direction is -x -> +x hits at -10)
  const poly: P[] = [[-16, 0], [-40, 0]];
  const out = cropLaneToShape(poly, disc, 20);
  assert.deepEqual(out[0], [-10, 0], 'extended to the near boundary');
  assert.ok(onCircle(out[0], 0, 0, 10));
});

test('cropLaneToShape disc: no extension past the cap leaves the lane unchanged', () => {
  const disc: CropShape = { kind: 'disc', cx: 0, cy: 0, r: 10 };
  const poly: P[] = [[-100, 0], [-140, 0]];
  const out = cropLaneToShape(poly, disc, 20); // 90px to the boundary >> cap 20
  assert.deepEqual(out, poly);
});

test('cropLaneToShape disc: a lane that never reaches (no maxExt) is unchanged', () => {
  const disc: CropShape = { kind: 'disc', cx: 0, cy: 0, r: 10 };
  const poly: P[] = [[20, 20], [40, 40]]; // stays outside, moving away
  assert.deepEqual(cropLaneToShape(poly, disc), poly);
});

test('insetShape shrinks a rect and a disc inward (clamped positive)', () => {
  assert.deepEqual(insetShape({ kind: 'rect', x0: 0, y0: 0, x1: 20, y1: 20 }, 2), { kind: 'rect', x0: 2, y0: 2, x1: 18, y1: 18 });
  assert.deepEqual(insetShape({ kind: 'disc', cx: 3, cy: -1, r: 10 }, 2), { kind: 'disc', cx: 3, cy: -1, r: 8 });
  const tiny = insetShape({ kind: 'disc', cx: 0, cy: 0, r: 1 }, 5);
  assert.ok(tiny.kind === 'disc' && tiny.r > 0, 'never collapses to a non-positive radius');
});

test('cropLaneToShape on an inset shape lands the lane inside the original boundary', () => {
  // a lane through a disc of radius 10, cropped to the disc inset by 2, ends at
  // radius 8 (2px inside the drawn boundary, so a stroke cap is covered)
  const inset = insetShape({ kind: 'disc', cx: 0, cy: 0, r: 10 }, 2);
  const out = cropLaneToShape([[-30, 0], [30, 0]], inset);
  assert.deepEqual(out[0], [-8, 0]);
});

test('cropLaneToShape disc: deterministic on repeat', () => {
  const disc: CropShape = { kind: 'disc', cx: 3, cy: -2, r: 7.5 };
  const poly: P[] = [[3, -2], [25, 13]];
  assert.deepEqual(cropLaneToShape(poly, disc), cropLaneToShape(poly, disc));
});
