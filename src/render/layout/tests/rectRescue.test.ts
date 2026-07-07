import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rescueRectCapsules } from '../rectRescue';
import type { StopScene, StopLine, Point } from '../../stations/types';

// Minimal StopLine at a given position; the fields the rescue does not read are
// filled with harmless placeholders.
const line = (lineId: string, pos: Point): StopLine => ({
  lineId, color: '#000', bullet: '', textColor: '', pos, chain: 0,
});

// Build a rectRows scene from a single group rect (x, y, w, h). One member per
// requested lineId; the group and one connector let us confirm every geometry
// field shifts together. box is the rescue's margin scale.
function rectScene(
  nodeId: string,
  rect: { x: number; y: number; w: number; h: number },
  lineIds: string[],
  box = 30,
): StopScene {
  return {
    nodeId,
    lines: lineIds.map((id, i) => line(id, [rect.x + 2 + i, rect.y + 2])),
    capsule: {
      kind: 'rectRows',
      box,
      groups: [{ x: rect.x, y: rect.y, w: rect.w, h: rect.h, rx: 4 }],
      connectors: [{ points: [[rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h]] }],
    },
    anchor: [rect.x + rect.w / 2, rect.y + rect.h / 2],
    dotRadius: 5,
  };
}

// Axis-aligned union bounds of a rectRows scene's groups (no margin), used to
// assert on overlap after the rescue.
function groupUnion(scene: StopScene) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (scene.capsule.kind !== 'rectRows') throw new Error('not rectRows');
  for (const g of scene.capsule.groups) {
    x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y);
    x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
  }
  return { x0, y0, x1, y1 };
}

// Signed overlap area of two group unions; <= 0 means the boxes are clear on at
// least one axis (no interior overlap).
function unionOverlapArea(a: StopScene, b: StopScene): number {
  const ua = groupUnion(a), ub = groupUnion(b);
  const ox = Math.min(ua.x1, ub.x1) - Math.max(ua.x0, ub.x0);
  const oy = Math.min(ua.y1, ub.y1) - Math.max(ua.y0, ub.y0);
  if (ox <= 0 || oy <= 0) return 0;
  return ox * oy;
}

const noneScene = (nodeId: string, pos: Point, dotRadius = 5): StopScene => ({
  nodeId,
  lines: [line('X', pos)],
  capsule: { kind: 'none' },
  anchor: pos,
  dotRadius,
});

const pillScene = (nodeId: string, pos: Point): StopScene => ({
  nodeId,
  lines: [line('P', pos), line('Q', [pos[0] + 10, pos[1]])],
  capsule: { kind: 'pill', points: [pos, [pos[0] + 10, pos[1]]], smooth: false },
  anchor: pos,
  dotRadius: 5,
});

// Core (unexpanded) painted box of a 'none' single stop: side 3*dotRadius
// centered at the anchor. Matches the single box tokyu.paint draws.
function noneBox(scene: StopScene) {
  const half = (3 * scene.dotRadius) / 2;
  return { x0: scene.anchor[0] - half, y0: scene.anchor[1] - half, x1: scene.anchor[0] + half, y1: scene.anchor[1] + half };
}

// Signed overlap area of two axis-aligned boxes; <= 0 means clear on an axis.
function boxOverlapArea(a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): number {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (ox <= 0 || oy <= 0) return 0;
  return ox * oy;
}

// Core (unexpanded) group-union box of a rectRows scene.
function rectBox(scene: StopScene) {
  const u = groupUnion(scene);
  return { x0: u.x0, y0: u.y0, x1: u.x1, y1: u.y1 };
}

test('two overlapping rectRows scenes -> no longer overlap; larger stays put', () => {
  // A has 3 members (bigger), B has 2; they overlap heavily. A stays, B moves.
  const a = rectScene('A', { x: 0, y: 0, w: 40, h: 30 }, ['1', '2', '3']);
  const b = rectScene('B', { x: 20, y: 10, w: 40, h: 30 }, ['4', '5']);
  const aGroupBefore = { ...a.capsule.kind === 'rectRows' ? a.capsule.groups[0] : {} };
  const bUnionBefore = groupUnion(b);

  rescueRectCapsules([a, b]);

  // Overlap resolved (reduced to <= 0).
  assert.ok(unionOverlapArea(a, b) <= 0, 'clusters still overlap after rescue');
  // The larger-member scene (A) did not move.
  assert.deepEqual(
    a.capsule.kind === 'rectRows' ? a.capsule.groups[0] : null,
    aGroupBefore,
  );
  // The smaller scene (B) did move.
  const bUnionAfter = groupUnion(b);
  assert.ok(
    bUnionAfter.x0 !== bUnionBefore.x0 || bUnionAfter.y0 !== bUnionBefore.y0,
    'smaller scene should have moved',
  );
});

test('every geometry field of the moved scene shifts by the same delta', () => {
  const a = rectScene('A', { x: 0, y: 0, w: 40, h: 30 }, ['1', '2', '3']);
  const b = rectScene('B', { x: 20, y: 10, w: 40, h: 30 }, ['4', '5']);
  if (b.capsule.kind !== 'rectRows') throw new Error('setup');
  const g0 = { ...b.capsule.groups[0] };
  const lp0 = b.lines.map((l) => [...l.pos] as Point);
  const cp0 = b.capsule.connectors[0].points.map((p) => [...p] as Point);
  const an0: Point = [...b.anchor];

  rescueRectCapsules([a, b]);

  if (b.capsule.kind !== 'rectRows') throw new Error('post');
  const dx = b.capsule.groups[0].x - g0.x;
  const dy = b.capsule.groups[0].y - g0.y;
  // lines, connector points, and anchor all shifted by the same (dx, dy).
  b.lines.forEach((l, i) => {
    assert.equal(l.pos[0], lp0[i][0] + dx);
    assert.equal(l.pos[1], lp0[i][1] + dy);
  });
  b.capsule.connectors[0].points.forEach((p, i) => {
    assert.equal(p[0], cp0[i][0] + dx);
    assert.equal(p[1], cp0[i][1] + dy);
  });
  assert.equal(b.anchor[0], an0[0] + dx);
  assert.equal(b.anchor[1], an0[1] + dy);
});

test('non-overlapping rectRows scenes -> unchanged', () => {
  const a = rectScene('A', { x: 0, y: 0, w: 40, h: 30 }, ['1', '2']);
  const b = rectScene('B', { x: 400, y: 400, w: 40, h: 30 }, ['3', '4']);
  const aBefore = JSON.parse(JSON.stringify(a));
  const bBefore = JSON.parse(JSON.stringify(b));

  rescueRectCapsules([a, b]);

  assert.deepEqual(a, aBefore);
  assert.deepEqual(b, bBefore);
});

test('two adjacent single (none) Tokyu stops whose boxes overlap get separated with a gap', () => {
  // Boxes are side 15 (dotRadius 5); centers 10 apart overlap by 5 on X.
  const a = noneScene('A', [0, 0]);
  const b = noneScene('B', [10, 0]);
  assert.ok(boxOverlapArea(noneBox(a), noneBox(b)) > 0, 'setup: boxes must overlap');

  rescueRectCapsules([a, b]);

  // Cleared, and not merely touching: a positive gap remains between the boxes.
  assert.equal(boxOverlapArea(noneBox(a), noneBox(b)), 0, 'boxes still overlap after rescue');
  const ba = noneBox(a), bb = noneBox(b);
  const gapX = Math.max(bb.x0 - ba.x1, ba.x0 - bb.x1);
  const gapY = Math.max(bb.y0 - ba.y1, ba.y0 - bb.y1);
  assert.ok(gapX > 0 || gapY > 0, 'cleared stops keep a visible gap, not corner contact');
  // The anchor and its line dot moved together.
  assert.deepEqual(b.lines[0].pos, b.anchor);
});

test('a single (none) box overlapping a rectRows capsule is pushed clear', () => {
  // The rectRows interchange (2 members) is bigger, so it anchors; the single
  // yields. They overlap at the origin corner.
  const rect = rectScene('R', { x: 0, y: 0, w: 40, h: 30 }, ['1', '2']);
  const single = noneScene('S', [5, 5]);
  const rectBefore = JSON.parse(JSON.stringify(rect));
  assert.ok(boxOverlapArea(rectBox(rect), noneBox(single)) > 0, 'setup: single must overlap the capsule');

  rescueRectCapsules([rect, single]);

  assert.equal(boxOverlapArea(rectBox(rect), noneBox(single)), 0, 'single still overlaps the capsule');
  // The bigger interchange did not move.
  assert.deepEqual(rect, rectBefore);
});

test('a non-overlapping mixed set is left unchanged', () => {
  const rect = rectScene('R', { x: 0, y: 0, w: 40, h: 30 }, ['1', '2', '3']);
  const single = noneScene('S', [400, 400]);
  const pill = pillScene('P', [800, 800]);
  const before = JSON.parse(JSON.stringify([rect, single, pill]));

  rescueRectCapsules([rect, single, pill]);

  assert.deepEqual([rect, single, pill], before);
});

test('deterministic: same input -> identical output', () => {
  const build = (): StopScene[] => [
    rectScene('A', { x: 0, y: 0, w: 40, h: 30 }, ['1', '2', '3']),
    rectScene('B', { x: 20, y: 10, w: 40, h: 30 }, ['4', '5']),
    rectScene('C', { x: 30, y: 25, w: 40, h: 30 }, ['6']),
    noneScene('D', [15, 12]),
    noneScene('E', [40, 8]),
  ];
  const run1 = build();
  const run2 = build();
  rescueRectCapsules(run1);
  rescueRectCapsules(run2);
  assert.deepEqual(run1, run2);
});
