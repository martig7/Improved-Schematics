import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../placement';
import type { RectCapsule } from '../../layout/rectSeat';
import type { StopMark, Pixel } from '../../layout/types';

const mk = (lineId: string, x: number, y: number, extra: Partial<StopMark> = {}): StopMark =>
  ({ lineId, color: '#dc2626', pos: [x, y] as Pixel, name: lineId, ...extra });

// Two marks carrying home/axis. With capsuleMode 'rectRows' they seat into an
// upright-box row; without it they fall through to the pill path.
const rectMarks = (): StopMark[] => [
  mk('A', 0, 0, { home: [0, 0] as Pixel, axis: 0, chain: 0 }),
  mk('B', 40, 0, { home: [40, 0] as Pixel, axis: 0, chain: 1 }),
];

test('rectRows mode with a cached capsule -> rectRows capsule, dots kept, one group', () => {
  const cached: RectCapsule = {
    box: 21,
    centers: [{ lineId: 'A', x: 0, y: 0 }, { lineId: 'B', x: 30, y: 0 }],
    groups: [{ x: -10, y: -10, w: 50, h: 20, rx: 4 }],
    connectors: [],
  };
  const s = buildScene('n1', rectMarks(), {
    megaFallback: 'curve', capsuleMode: 'rectRows', rectByNode: new Map([['n1', cached]]),
  });
  assert.equal(s.capsule.kind, 'rectRows');
  assert.ok(s.lines.length > 0);
  const cap = s.capsule as { kind: 'rectRows'; groups: unknown[] };
  assert.ok(cap.groups.length >= 1);
});

test('same marks without capsuleMode -> pill', () => {
  const s = buildScene('n1', rectMarks(), { megaFallback: 'curve' });
  assert.equal(s.capsule.kind, 'pill');
});

test('rectRows mode reads the cached capsule when present (no draw-time seat)', () => {
  // A cached capsule whose centers differ from the marks; the scene must mirror
  // it exactly (positions, groups, connectors, box), not re-seat from the marks.
  const cached: RectCapsule = {
    box: 21,
    centers: [{ lineId: 'A', x: 100, y: 200 }, { lineId: 'B', x: 130, y: 200 }],
    groups: [{ x: 90, y: 190, w: 50, h: 20, rx: 4 }],
    connectors: [{ points: [[100, 200], [130, 200]] }],
  };
  const s = buildScene('n1', rectMarks(), {
    megaFallback: 'curve', capsuleMode: 'rectRows',
    rectByNode: new Map([['n1', cached]]),
  });
  assert.equal(s.capsule.kind, 'rectRows');
  const cap = s.capsule as Extract<typeof s.capsule, { kind: 'rectRows' }>;
  assert.equal(cap.box, 21);
  assert.deepEqual(cap.groups, cached.groups);
  assert.deepEqual(cap.connectors, cached.connectors);
  // Each dot sits at its cached center; anchor is the centroid of the centers.
  const posA = s.lines.find((l) => l.lineId === 'A')!.pos;
  const posB = s.lines.find((l) => l.lineId === 'B')!.pos;
  assert.deepEqual(posA, [100, 200]);
  assert.deepEqual(posB, [130, 200]);
  assert.deepEqual(s.anchor, [115, 200]);
});

test('rectRows mode with a cache miss degrades to a non-rectRows scene', () => {
  // No rectByNode entry for this node: there is no draw-time seating, so the
  // multi-line station falls through to the normal pill path (per-line boxes).
  const s = buildScene('n1', rectMarks(), {
    megaFallback: 'curve', capsuleMode: 'rectRows', rectByNode: new Map(),
  });
  assert.notEqual(s.capsule.kind, 'rectRows');
});

test('single rectRows stop uses its cached rescued position', () => {
  const marks: StopMark[] = [mk('A', 5, 5, { home: [5, 5] as Pixel, axis: 0 })];
  const s = buildScene('n1', marks, {
    megaFallback: 'curve', capsuleMode: 'rectRows',
    tokyuStopPos: new Map([['n1', [80, 90]]]),
  });
  assert.equal(s.capsule.kind, 'none');
  assert.deepEqual(s.anchor, [80, 90]);
  assert.deepEqual(s.lines[0].pos, [80, 90]);
});

test('single stop without tokyuStopPos keeps its mark position', () => {
  const marks: StopMark[] = [mk('A', 5, 5)];
  const s = buildScene('n1', marks, { megaFallback: 'curve', capsuleMode: 'rectRows' });
  assert.equal(s.capsule.kind, 'none');
  assert.deepEqual(s.anchor, [5, 5]);
  assert.deepEqual(s.lines[0].pos, [5, 5]);
});
