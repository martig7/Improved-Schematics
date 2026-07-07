import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRectByNode, type RectSeatStation } from '../renderOctilinear';
import { rectSeat, rectSeatToCapsule, type RectMember } from '../layout/rectSeat';

// Reproduce the box the compute helper uses so a direct seat+convert can be
// compared against it (R0 = LINE_WIDTH*0.7, RCAP = R0*MARKER_SCALE,
// S = 3*RCAP/MARKER_SCALE = 3*R0). Kept in step with renderOctilinear's RECT_BOX.
import { LINE_WIDTH, MARKER_SCALE } from '../constants';
const BOX = 3 * (LINE_WIDTH * 0.7) * MARKER_SCALE / MARKER_SCALE;

// Direct seat+convert for one station's marks, the reference the helper must match.
const directCapsule = (marks: RectSeatStation['marks']) => {
  const members: RectMember[] = marks.map((m) => ({ lineId: m.lineId, home: m.home!, axis: m.axis! }));
  return rectSeatToCapsule(rectSeat(members, BOX, BOX * 0.14), BOX);
};

test('computeRectByNode: capsule equals direct seat+convert for well-separated stations', () => {
  // Two interchanges far enough apart that the cross-station rescue moves
  // neither, so each cached capsule equals the direct seat+convert.
  const stations: RectSeatStation[] = [
    { nodeId: 'n1', marks: [
      { lineId: 'A', home: [0, 0], axis: 0 },
      { lineId: 'B', home: [40, 0], axis: 0 },
    ] },
    { nodeId: 'n2', marks: [
      { lineId: 'C', home: [1000, 1000], axis: 0 },
      { lineId: 'D', home: [1040, 1000], axis: 0 },
    ] },
  ];
  const byNode = computeRectByNode(stations);
  assert.equal(byNode.size, 2);
  assert.deepEqual(byNode.get('n1'), directCapsule(stations[0].marks));
  assert.deepEqual(byNode.get('n2'), directCapsule(stations[1].marks));
});

test('computeRectByNode: geometric predicate skips singles and marks missing home/axis', () => {
  const stations: RectSeatStation[] = [
    // single mark -> not a capsule
    { nodeId: 'single', marks: [{ lineId: 'A', home: [0, 0], axis: 0 }] },
    // one mark has no home -> whole station skipped
    { nodeId: 'noHome', marks: [
      { lineId: 'A', home: [0, 0], axis: 0 },
      { lineId: 'B', axis: 0 },
    ] },
    // one mark has no axis -> whole station skipped
    { nodeId: 'noAxis', marks: [
      { lineId: 'A', home: [0, 0], axis: 0 },
      { lineId: 'B', home: [40, 0] },
    ] },
    // qualifies
    { nodeId: 'ok', marks: [
      { lineId: 'A', home: [0, 0], axis: 0 },
      { lineId: 'B', home: [40, 0], axis: 0 },
    ] },
  ];
  const byNode = computeRectByNode(stations);
  assert.deepEqual([...byNode.keys()], ['ok']);
});

test('computeRectByNode: cross-station rescue separates overlapping capsules', () => {
  // Two identical single-line-pair capsules seated at the SAME spot overlap;
  // the rescue must push them apart so their group-rect unions no longer overlap.
  const at = (nodeId: string): RectSeatStation => ({
    nodeId,
    marks: [
      { lineId: nodeId + 'A', home: [0, 0], axis: 0 },
      { lineId: nodeId + 'B', home: [40, 0], axis: 0 },
    ],
  });
  const byNode = computeRectByNode([at('n1'), at('n2')]);
  const bbox = (nodeId: string) => {
    const cap = byNode.get(nodeId)!;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of cap.groups) {
      x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
    }
    return { x0, y0, x1, y1 };
  };
  const a = bbox('n1'), b = bbox('n2');
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  // Separated on at least one axis (no footprint overlap after the rescue).
  assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6);
});

test('computeRectByNode: deterministic on repeat', () => {
  const stations: RectSeatStation[] = [
    { nodeId: 'n1', marks: [
      { lineId: 'A', home: [0, 0], axis: 2 },
      { lineId: 'B', home: [3, 60], axis: 2 },
    ] },
  ];
  assert.deepEqual(computeRectByNode(stations), computeRectByNode(stations));
});
