import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directBubbleCropTargets } from '../directBubbleCrops';
import type { StopMark } from '../types';
import { cropLaneToShape, insetShape } from '../../laneCrop';

test('every direct-bubble regime receives a crop for an endpoint at a perfect intersection', () => {
  const marks: StopMark[] = [
    { lineId: 'end', color: '#f00', pos: [10, 10], axis: 0, terminus: true, flagNode: 'n' },
    { lineId: 'through', color: '#00f', pos: [10, 10], axis: 2, flagNode: 'n' },
  ];
  const targets = directBubbleCropTargets({
    stopsByNode: new Map([['n', marks]]),
    torontoByNode: new Map([['n', { cx: 10, cy: 10 }]]),
    dcByNode: new Map([['n', { marks: [{ at: [10, 10], r: 4, ring: true }], ends: [] }]]),
    parisByNode: new Map([['n', {
      interchange: true, radius: 3, ends: [], anchor: [10, 10], connectors: [],
      cells: [{ at: [10, 10], lineIds: ['end', 'through'], endpointLineIds: ['end'], shape: 'round' }],
      groups: [{ axis: 0, cellIndexes: [0], points: [[10, 10]] }],
    }]]),
    isRouteTerminus: () => true,
    isShared: () => false,
  });
  assert.deepEqual([...targets.keys()], ['toronto', 'dc', 'paris', 'pill']);
  for (const regime of targets.keys()) {
    assert.equal(targets.get(regime)?.length, 1);
    assert.equal(targets.get(regime)?.[0].lineId, 'end');
    const target = targets.get(regime)![0];
    const shape = insetShape(target.shape, 1);
    const cropped = cropLaneToShape([[10, 10], [-10, 10]], shape, 48);
    assert.equal(shape.kind, 'disc');
    assert.ok(Math.abs(cropped[0][0] - (10 - (shape.kind === 'disc' ? shape.r : 0))) < 1e-6);
    assert.equal(cropped[0][1], 10);
  }
});

test('parallel lines do not create a direct-bubble crop without a solved crossing', () => {
  const marks: StopMark[] = [
    { lineId: 'a', color: '#f00', pos: [0, 0], axis: 0, terminus: true, flagNode: 'n' },
    { lineId: 'b', color: '#00f', pos: [0, 2], axis: 4, flagNode: 'n' },
  ];
  const targets = directBubbleCropTargets({
    stopsByNode: new Map([['n', marks]]), torontoByNode: new Map(), dcByNode: new Map(), parisByNode: new Map(),
    isRouteTerminus: () => true, isShared: () => false,
  });
  assert.equal(targets.size, 0);
});
