import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATION_DESIGNS,
  getStationDesign,
  pickExampleRoute,
  DEFAULT_STATION_DESIGN,
  EXAMPLE_STATION_DEFAULT,
} from '../stationDesigns';
import { renderStops } from '../stops';

test('registry contains Classic and default id is classic', () => {
  assert.ok(STATION_DESIGNS.some((d) => d.id === 'classic'));
  assert.equal(DEFAULT_STATION_DESIGN, 'classic');
});

test('getStationDesign returns Classic and falls back for unknown/undefined', () => {
  assert.equal(getStationDesign('classic').id, 'classic');
  assert.equal(getStationDesign('nope').id, 'classic');
  assert.equal(getStationDesign(undefined).id, 'classic');
});

test('Classic dispatch reuses the pipeline renderStops (no drift)', () => {
  assert.equal(getStationDesign('classic').renderStops, renderStops);
});

test('pickExampleRoute picks the first non-temporary bulleted route', () => {
  const ex = pickExampleRoute([
    { tempParentId: 'x', bullet: 'Z', color: '#123456' },
    { bullet: 'Q', color: '#00ff00', textColor: '#000000' },
  ]);
  assert.deepEqual(ex, { bullet: 'Q', color: '#00ff00', textColor: '#000000' });
});

test('pickExampleRoute defaults when there are no usable routes', () => {
  assert.deepEqual(pickExampleRoute([]), EXAMPLE_STATION_DEFAULT);
  assert.deepEqual(pickExampleRoute([{ tempParentId: 'x', bullet: 'Z' }]), EXAMPLE_STATION_DEFAULT);
  assert.deepEqual(pickExampleRoute([{ bullet: '   ' }]), EXAMPLE_STATION_DEFAULT);
});

test('pickExampleRoute sanitizes a bad color to gray', () => {
  const ex = pickExampleRoute([{ bullet: 'A', color: 'not-a-color' }]);
  assert.equal(ex.color, '#888888');
});

test('classic renderPreview returns an <svg> containing the bullet and ring color', () => {
  const svg = getStationDesign('classic').renderPreview({ bullet: 'A', color: '#dc2626', textColor: '#ffffff' }, false);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('>A<'));
  assert.ok(svg.includes('#dc2626'));
});
