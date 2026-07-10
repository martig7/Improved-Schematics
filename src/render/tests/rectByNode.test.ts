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
  const { rectByNode: byNode } = computeRectByNode(stations);
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
    // a mega multi-line station whose marks carry home/axis -> INCLUDED, so the
    // Tokyu design seats it as a numbered rectRows grid (every line gets a box).
    { nodeId: 'mega', marks: [
      { lineId: 'A', home: [0, 0], axis: 0, mega: true },
      { lineId: 'B', home: [40, 0], axis: 0, mega: true },
    ] },
    // qualifies
    { nodeId: 'ok', marks: [
      { lineId: 'A', home: [0, 0], axis: 0 },
      { lineId: 'B', home: [40, 0], axis: 0 },
    ] },
  ];
  const { rectByNode: byNode } = computeRectByNode(stations);
  assert.deepEqual([...byNode.keys()], ['mega', 'ok']);
});

test('computeRectByNode: a mega multi-line station is seated into rectByNode', () => {
  const stations: RectSeatStation[] = [
    { nodeId: 'mega', marks: [
      { lineId: 'A', home: [0, 0], axis: 0, mega: true },
      { lineId: 'B', home: [40, 0], axis: 0, mega: true },
    ] },
  ];
  const { rectByNode: byNode } = computeRectByNode(stations);
  assert.ok(byNode.has('mega'));
  const cap = byNode.get('mega')!;
  assert.equal(cap.centers.length, 2);
  assert.ok(cap.groups.length >= 1);
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
  const { rectByNode: byNode } = computeRectByNode([at('n1'), at('n2')]);
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

test('computeRectByNode: single stops are recorded in tokyuStopPos', () => {
  // Two singles far apart: both recorded at their own pos, neither moved.
  const stations: RectSeatStation[] = [
    { nodeId: 's1', marks: [{ lineId: 'A', home: [0, 0], axis: 0, pos: [0, 0] }] },
    { nodeId: 's2', marks: [{ lineId: 'B', home: [500, 500], axis: 0, pos: [500, 500] }] },
  ];
  const { rectByNode, tokyuStopPos } = computeRectByNode(stations);
  assert.equal(rectByNode.size, 0);
  assert.deepEqual(tokyuStopPos.get('s1'), [0, 0]);
  assert.deepEqual(tokyuStopPos.get('s2'), [500, 500]);
});

// A straight horizontal lane through the anchor, mirroring what laneItemFor
// supplies in production: the rescue slides singles ALONG this curve.
const hLaneItem = (lineId: string, _flagNode: string, anchor: [number, number]) => ({
  lineId,
  curve: {
    pts: [[anchor[0] - 200, anchor[1]], [anchor[0] + 200, anchor[1]]] as [number, number][],
    cum: [0, 400],
    anchorT: 200,
  },
  t0: 200,
});

test('computeRectByNode: two overlapping single boxes are separated ALONG their lanes', () => {
  // Two single boxes almost on top of each other overlap; the mutual along-lane
  // relaxation slides both apart so their painted boxes clear on one axis.
  const stations: RectSeatStation[] = [
    { nodeId: 's1', marks: [{ lineId: 'A', home: [0, 0], axis: 0, pos: [0, 0], flagNode: 'f1' }] },
    { nodeId: 's2', marks: [{ lineId: 'B', home: [4, 0], axis: 0, pos: [4, 0], flagNode: 'f2' }] },
  ];
  const { tokyuStopPos } = computeRectByNode(stations, undefined, hLaneItem);
  const a = tokyuStopPos.get('s1')!, b = tokyuStopPos.get('s2')!;
  const half = 3 * (LINE_WIDTH * 0.7) / 2;
  const overlapX = (half + half) - Math.abs(a[0] - b[0]);
  const overlapY = (half + half) - Math.abs(a[1] - b[1]);
  assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, 'single boxes still overlap after rescue');
  // On-lane invariant: sliding follows the (horizontal) lane, never leaves it.
  assert.ok(Math.abs(a[1]) < 1e-9 && Math.abs(b[1]) < 1e-9, 'a box left its lane');
});

test('computeRectByNode: a curveless single stays put (static obstacle)', () => {
  // Without a drawn lane there is nothing safe to slide along; the box holds
  // its position rather than drift off-line.
  const stations: RectSeatStation[] = [
    { nodeId: 's1', marks: [{ lineId: 'A', home: [0, 0], axis: 0, pos: [0, 0] }] },
    { nodeId: 's2', marks: [{ lineId: 'B', home: [4, 0], axis: 0, pos: [4, 0] }] },
  ];
  const { tokyuStopPos } = computeRectByNode(stations);
  assert.deepEqual(tokyuStopPos.get('s1'), [0, 0]);
  assert.deepEqual(tokyuStopPos.get('s2'), [4, 0]);
});

test('computeRectByNode: a single box is pushed clear of an interchange capsule', () => {
  // The interchange (2 members) anchors; the single sits on top of it and slides
  // out along its own lane.
  const stations: RectSeatStation[] = [
    { nodeId: 'inter', marks: [
      { lineId: 'A', home: [0, 0], axis: 0, pos: [0, 0] },
      { lineId: 'B', home: [40, 0], axis: 0, pos: [40, 0] },
    ] },
    { nodeId: 'single', marks: [{ lineId: 'C', home: [10, 0], axis: 0, pos: [10, 0], flagNode: 'f3' }] },
  ];
  const { rectByNode, tokyuStopPos } = computeRectByNode(stations, undefined, hLaneItem);
  // The single must clear every DRAWN capsule part rect (sitting in the empty
  // gap between two separated parts is legitimate).
  const cap = rectByNode.get('inter')!;
  const s = tokyuStopPos.get('single')!;
  const half = 3 * (LINE_WIDTH * 0.7) / 2;
  const sx0 = s[0] - half, sy0 = s[1] - half, sx1 = s[0] + half, sy1 = s[1] + half;
  for (const g of cap.groups) {
    const overlapX = Math.min(g.x + g.w, sx1) - Math.max(g.x, sx0);
    const overlapY = Math.min(g.y + g.h, sy1) - Math.max(g.y, sy0);
    assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, 'single overlaps a drawn capsule part');
  }
  // On-lane invariant: the single stayed on its horizontal lane.
  assert.ok(Math.abs(s[1]) < 1e-9, 'single left its lane');
});

test('computeRectByNode: deterministic on repeat', () => {
  const stations: RectSeatStation[] = [
    { nodeId: 'n1', marks: [
      { lineId: 'A', home: [0, 0], axis: 2 },
      { lineId: 'B', home: [3, 60], axis: 2 },
    ] },
    { nodeId: 's1', marks: [{ lineId: 'C', home: [5, 5], axis: 0, pos: [5, 5] }] },
  ];
  assert.deepEqual(computeRectByNode(stations), computeRectByNode(stations));
});
