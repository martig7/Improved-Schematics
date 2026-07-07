import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../placement';
import type { StopMark, Pixel } from '../../layout/types';

const mk = (lineId: string, x: number, y: number, extra: Partial<StopMark> = {}): StopMark =>
  ({ lineId, color: '#dc2626', pos: [x, y] as Pixel, name: lineId, ...extra });

// Two marks carrying home/axis. With capsuleMode 'rectRows' they seat into an
// upright-box row; without it they fall through to the pill path.
const rectMarks = (): StopMark[] => [
  mk('A', 0, 0, { home: [0, 0] as Pixel, axis: 0, chain: 0 }),
  mk('B', 40, 0, { home: [40, 0] as Pixel, axis: 0, chain: 1 }),
];

test('rectRows mode with home/axis -> rectRows capsule, dots kept, one group', () => {
  const s = buildScene('n1', rectMarks(), { megaFallback: 'curve', capsuleMode: 'rectRows' });
  assert.equal(s.capsule.kind, 'rectRows');
  assert.ok(s.lines.length > 0);
  const cap = s.capsule as { kind: 'rectRows'; groups: unknown[] };
  assert.ok(cap.groups.length >= 1);
});

test('same marks without capsuleMode -> pill', () => {
  const s = buildScene('n1', rectMarks(), { megaFallback: 'curve' });
  assert.equal(s.capsule.kind, 'pill');
});
