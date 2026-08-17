import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITERATIONS,
  LINE_GAP,
  LINE_SCALE,
  LINE_WIDTH,
  MARK_R0,
  OCT_DIRS,
  OCT_UNIT,
  STEP_SIZE,
  STATION_SCALE,
  STATION_WIDTH,
  TARGET_EDGE_CELLS,
  regimeDivisor,
  setRenderScales,
} from '../constants';
import { BADGE_R as DC_BADGE_R, STOP_OUTER as DC_STOP_OUTER } from '../layout/dcStations';
import { capsuleStrokeWidths } from '../stations/primitives';

test('OCT_DIRS has 8 directions', () => {
  assert.equal(OCT_DIRS.length, 8);
});

test('OCT_UNIT normalizes diagonals to length 1', () => {
  for (const [x, y] of OCT_UNIT) {
    assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
  }
  assert.ok(Math.abs(OCT_UNIT[1][0] - Math.SQRT1_2) < 1e-9);
});

test('scalar constants match the game', () => {
  assert.equal(STEP_SIZE, 3);
  assert.equal(TARGET_EDGE_CELLS, 2.2);
  assert.equal(ITERATIONS, 80);
});

test('regimeDivisor picks the finer grid at and below the 800-edge boundary', () => {
  assert.equal(regimeDivisor(0), 1.6);
  assert.equal(regimeDivisor(799), 1.6);
  assert.equal(regimeDivisor(800), 1.6);
});

test('regimeDivisor picks the coarser grid above the 800-edge boundary', () => {
  assert.equal(regimeDivisor(801), 1.2);
  assert.equal(regimeDivisor(5000), 1.2);
});

test('regimeDivisor: OCTI_DIVISOR overrides both regimes', () => {
  const prev = process.env.OCTI_DIVISOR;
  process.env.OCTI_DIVISOR = '1.4';
  try {
    assert.equal(regimeDivisor(0), 1.4);
    assert.equal(regimeDivisor(9999), 1.4);
  } finally {
    if (prev === undefined) delete process.env.OCTI_DIVISOR;
    else process.env.OCTI_DIVISOR = prev;
  }
});

test('line and station scales change independent render metrics', () => {
  try {
    setRenderScales({ line: 0.5, station: 1.4 });
    assert.equal(LINE_SCALE, 0.5);
    assert.equal(STATION_SCALE, 1.4);
    assert.equal(LINE_WIDTH, 1.75);
    assert.equal(LINE_GAP, 1);
    assert.ok(Math.abs(STATION_WIDTH - 4.9) < 1e-12);
    assert.ok(Math.abs(MARK_R0 - 3.43) < 1e-12);

    const stationMetrics = [STATION_WIDTH, MARK_R0];
    const stationChrome = [DC_BADGE_R, DC_STOP_OUTER, capsuleStrokeWidths(MARK_R0).border];
    setRenderScales({ line: 1.25, station: 1.4 });
    assert.deepEqual([STATION_WIDTH, MARK_R0], stationMetrics);
    assert.deepEqual([DC_BADGE_R, DC_STOP_OUTER, capsuleStrokeWidths(MARK_R0).border], stationChrome);

    const lineMetrics = [LINE_WIDTH, LINE_GAP];
    setRenderScales({ line: 1.25, station: 0.6 });
    assert.deepEqual([LINE_WIDTH, LINE_GAP], lineMetrics);
    assert.notDeepEqual([DC_BADGE_R, DC_STOP_OUTER, capsuleStrokeWidths(MARK_R0).border], stationChrome);
  } finally {
    setRenderScales({ line: 1, station: 1 });
  }
});
