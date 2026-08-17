import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusStationGeometry } from '../stationGeometryCensus';
import { computeParisByNode } from '../parisCapsules';
import type { StopMark } from '../types';
import { LINE_GAP, LINE_WIDTH, setRenderScales } from '../../constants';

test('the station census catches parallel bubbles, bundle overflow, and missing endpoint crops', () => {
  const marks: StopMark[] = [
    { lineId: 'a', color: '#f00', pos: [0, 0], axis: 0, terminus: true, flagNode: 'n' },
    { lineId: 'b', color: '#00f', pos: [0, 0], axis: 4, flagNode: 'n' },
  ];
  const result = censusStationGeometry({
    stopsByNode: new Map([['n', marks]]),
    parisByNode: new Map([['n', {
      interchange: true, radius: 20, ends: [], anchor: [0, 0], connectors: [],
      cells: [{ at: [0, 0], lineIds: ['a', 'b'], endpointLineIds: ['a'], shape: 'round' }],
      groups: [{ axis: 0, cellIndexes: [0], points: [[0, 0]] }],
    }]]),
    cropTargetsByRegime: new Map([['paris', [{
      lineId: 'a', flagNode: 'n', shape: { kind: 'disc', cx: 0, cy: 0, r: 20 }, shared: false,
    }]]]),
    croppedLaneByLine: new Map(), lineWidth: 3.5, lineGap: 2,
  });
  assert.deepEqual(result.violations.map((violation) => violation.kind), [
    'parallel-bubble', 'bundle-width', 'missing-crop',
  ]);
});

test('independent line and station scale extremes keep Paris cells inside the bundle', () => {
  const marks: StopMark[] = [
    { lineId: 'a', color: '#f00', pos: [0, 0], axis: 0, flagNode: 'n' },
    { lineId: 'b', color: '#00f', pos: [0, 0], axis: 2, flagNode: 'n' },
  ];
  try {
    for (const [line, station] of [[0.3, 0.3], [0.3, 1.5], [1.5, 0.3], [1.5, 1.5]]) {
      setRenderScales({ line, station });
      const parisByNode = computeParisByNode(new Map([['n', marks]]), LINE_WIDTH);
      const result = censusStationGeometry({
        stopsByNode: new Map([['n', marks]]),
        parisByNode,
        cropTargetsByRegime: new Map(),
        croppedLaneByLine: new Map(),
        lineWidth: LINE_WIDTH,
        lineGap: LINE_GAP,
      });
      assert.deepEqual(result.violations, [], `line=${line} station=${station}`);
    }
  } finally {
    setRenderScales({ line: 1, station: 1 });
  }
});

test('the station census catches an endpoint that does not reach its crop boundary', () => {
  const base = {
    stopsByNode: new Map<string, StopMark[]>(),
    parisByNode: new Map(),
    cropTargetsByRegime: new Map([['paris', [{
      lineId: 'red', flagNode: 'end', shape: { kind: 'disc' as const, cx: 0, cy: 0, r: 10 }, shared: false,
    }]]]),
    lineWidth: 2,
    lineGap: 2,
  };
  const bad = censusStationGeometry({
    ...base,
    croppedLaneByLine: new Map([['paris', new Map([['red', 'M-20.0,0.0 L-30.0,0.0']])]]),
  });
  assert.deepEqual(bad.violations.map((violation) => violation.kind), ['bad-crop']);

  const good = censusStationGeometry({
    ...base,
    croppedLaneByLine: new Map([['paris', new Map([['red', 'M-9.0,0.0 L-30.0,0.0']])]]),
  });
  assert.deepEqual(good.violations, []);
});

test('the station census accepts any side of a rectangular crop boundary', () => {
  const result = censusStationGeometry({
    stopsByNode: new Map(),
    parisByNode: new Map(),
    cropTargetsByRegime: new Map([['pill', [{
      lineId: 'line', flagNode: 'end',
      shape: { kind: 'rect' as const, x0: -10, x1: 10, y0: -10, y1: 10 }, shared: false,
    }]]]),
    croppedLaneByLine: new Map([['pill', new Map([['line', 'M0.0,-10.0 L0.0,-30.0']])]]),
    lineWidth: 0,
    lineGap: 2,
  });
  assert.deepEqual(result.violations, []);
});
