import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotationFrameOf, rotateCoord, reframeCoord } from '../rotateInput';
import { rotatedRectCorners, insideConvex } from '../cropFrame';
import type { Coordinate } from '../../types/core';

// What the crop editor commits. The box is drawn TURNED over a map rendered at
// the applied angle; committing it means finding the angle the box is upright in
// and re-expressing the box there. The sign relating a canvas rotation to a map
// angle is the one thing here that is easy to get backwards, so it is pinned by
// checking that both descriptions select the same geography.

const GEO_BBOX: [number, number, number, number] = [-74.1, 40.6, -73.7, 40.9];
const frame = rotationFrameOf({ geography: { bbox: GEO_BBOX }, stations: [] })!;
const SCALE = 4000;

/** The renderer's mapping, in essence: rotate into the frame, scale longitude by
 *  the metric east factor, and flip y (screen y runs down). */
const project = (g: Coordinate, angle: number): [number, number] => {
  const r = rotateCoord(g, frame, angle);
  return [(r[0] - frame.cx) * frame.k * SCALE, -(r[1] - frame.cy) * SCALE];
};
const unproject = (p: [number, number], angle: number): Coordinate => {
  void angle;
  return [frame.cx + p[0] / (frame.k * SCALE), frame.cy - p[1] / SCALE];
};

/** A spread of sample points over the region. */
const samples = (): Coordinate[] => {
  const out: Coordinate[] = [];
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      out.push([GEO_BBOX[0] + ((GEO_BBOX[2] - GEO_BBOX[0]) * i) / 12,
                GEO_BBOX[1] + ((GEO_BBOX[3] - GEO_BBOX[1]) * j) / 12]);
    }
  }
  return out;
};

/** applyCrop's conversion, isolated. */
function commit(box: { x0: number; y0: number; x1: number; y1: number }, shown: number, tiltRad: number) {
  const angle = shown + (tiltRad * 180) / Math.PI;
  const pts = rotatedRectCorners((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2,
    (box.x1 - box.x0) / 2, (box.y1 - box.y0) / 2, tiltRad)
    .map((p) => reframeCoord(unproject(p, shown), frame, shown, angle));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { angle, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number] };
}

for (const [shown, tiltDeg] of [[0, 20], [23, -23], [23, 22], [0, -45], [10, 60]] as Array<[number, number]>) {
  test(`a box turned ${tiltDeg} deg over a map at ${shown} deg selects the same ground`, () => {
    const tilt = (tiltDeg * Math.PI) / 180;
    const box = { x0: -900, y0: -650, x1: 700, y1: 500 };
    const { angle, bbox } = commit(box, shown, tilt);

    // What the user drew: the turned rectangle, in the displayed map's pixels.
    const drawn = rotatedRectCorners((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2,
      (box.x1 - box.x0) / 2, (box.y1 - box.y0) / 2, tilt);

    let checked = 0;
    for (const g of samples()) {
      const p = project(g, shown);
      const inDrawn = insideConvex(drawn, p[0], p[1]);
      const r = rotateCoord(g, frame, angle);
      const inBox = r[0] >= bbox[0] && r[0] <= bbox[2] && r[1] >= bbox[1] && r[1] <= bbox[3];
      // Points within a hair of the boundary can fall either way; skip them.
      const edge = Math.min(
        Math.abs(r[0] - bbox[0]), Math.abs(r[0] - bbox[2]),
      ) * frame.k * SCALE < 1 || Math.min(Math.abs(r[1] - bbox[1]), Math.abs(r[1] - bbox[3])) * SCALE < 1;
      if (edge) continue;
      assert.equal(inBox, inDrawn, `${g} : drawn ${inDrawn} vs committed ${inBox}`);
      checked++;
    }
    assert.ok(checked > 100, `only ${checked} points compared`);
    assert.ok(Math.abs(angle - (shown + tiltDeg)) < 1e-9);
  });
}

test('no tilt leaves the angle and the plain two-corner unproject alone', () => {
  const box = { x0: -900, y0: -650, x1: 700, y1: 500 };
  const { angle, bbox } = commit(box, 23, 0);
  assert.equal(angle, 23);
  const bl = unproject([box.x0, box.y1], 23);
  const tr = unproject([box.x1, box.y0], 23);
  // The two paths agree to well under a centimetre on the ground; they differ at
  // all only because carrying a point through two frames applies the rotation's
  // 1e-9 quantization twice. The live code skips the carry entirely when level.
  for (const [a, b] of [[bbox[0], bl[0]], [bbox[1], bl[1]], [bbox[2], tr[0]], [bbox[3], tr[1]]]) {
    assert.ok(Math.abs(a - b) < 1e-7, `${a} vs ${b}`);
  }
});

test('the committed box is UPRIGHT in the angle it commits', () => {
  // The four drawn corners, carried into the new frame, are two x values and two
  // y values: the AABB reproduces the selection exactly rather than inflating it.
  const tilt = (22 * Math.PI) / 180;
  const box = { x0: -900, y0: -650, x1: 700, y1: 500 };
  const { angle } = commit(box, 23, tilt);
  const pts = rotatedRectCorners((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2,
    (box.x1 - box.x0) / 2, (box.y1 - box.y0) / 2, tilt)
    .map((p) => reframeCoord(unproject(p, 23), frame, 23, angle));
  assert.ok(Math.abs(pts[0][1] - pts[1][1]) * SCALE < 1e-6, 'top edge level');
  assert.ok(Math.abs(pts[2][1] - pts[3][1]) * SCALE < 1e-6, 'bottom edge level');
  assert.ok(Math.abs(pts[0][0] - pts[3][0]) * frame.k * SCALE < 1e-6, 'left edge plumb');
  assert.ok(Math.abs(pts[1][0] - pts[2][0]) * frame.k * SCALE < 1e-6, 'right edge plumb');
});
