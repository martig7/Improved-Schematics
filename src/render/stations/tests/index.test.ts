import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATION_DESIGNS, getStationDesign, DEFAULT_STATION_DESIGN, EXAMPLE_STATION_DEFAULT, pickExampleRoute, renderStationPreview } from '../index';
import { renderStations } from '../render';
import type { StopMark, Pixel } from '../../layout/types';

test('registry has classic, nyc-solid, nyc-map; default classic; fallback', () => {
  for (const id of ['classic', 'nyc-solid', 'nyc-map', 'tokyu']) assert.ok(STATION_DESIGNS.some((d) => d.id === id));
  assert.equal(DEFAULT_STATION_DESIGN, 'classic');
  assert.equal(getStationDesign('classic').id, 'classic');
  assert.equal(getStationDesign('nope').id, 'classic');
  assert.equal(getStationDesign(undefined).id, 'classic');
});

test('pickExampleRoute: first bulleted non-temp route, else A/red default', () => {
  assert.deepEqual(pickExampleRoute([{ tempParentId: 'x', bullet: 'Z' }, { bullet: 'Q', color: '#00ff00', textColor: '#000000' }]), { bullet: 'Q', color: '#00ff00', textColor: '#000000' });
  assert.deepEqual(pickExampleRoute([]), EXAMPLE_STATION_DEFAULT);
  assert.equal(pickExampleRoute([{ bullet: 'A', color: 'bad' }]).color, '#888888');
  assert.equal(pickExampleRoute([{ bullet: 'A', color: 'bad' }]).textColor, '');
});

test('renderStationPreview returns an <svg> with the bullet and expected color', () => {
  const svg = renderStationPreview(getStationDesign('nyc-solid'), { bullet: 'A', color: '#dc2626', textColor: '#ffffff' }, false);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('fill="#dc2626"'));
  assert.ok(svg.includes('>A</text>'));
});

test('london preview: a horizontal route line with a perpendicular tick over it', () => {
  const svg = renderStationPreview(getStationDesign('london'), { bullet: 'A', color: '#dc2626', textColor: '' }, false);
  assert.ok(svg.startsWith('<svg'));
  // a horizontal route line in the route color (y1 == y2)
  const routeLine = svg.match(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" stroke="#dc2626"[^>]*\/>/);
  assert.ok(routeLine, 'route line present in the route color');
  assert.equal(routeLine![2], routeLine![4], 'route line is horizontal');
  // the tick is another route-color line, struck vertically (x1 == x2)
  const lines = [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" stroke="#dc2626"[^>]*\/>/g)];
  const tick = lines.find((m) => Math.abs(+m[1] - +m[3]) < 1e-6);
  assert.ok(tick, 'a strictly vertical tick over the horizontal line');
  // the tick rises above the line (negative y), i.e. toward the top of the tile
  assert.ok(Math.min(+tick![2], +tick![4]) < 0, 'tick strikes up from the line');
});

test('renderStations emits svg fragments + matching stops prims', () => {
  const marks: StopMark[] = [{ lineId: 'L', color: '#dc2626', pos: [5, 5] as Pixel, name: 'A' }];
  const stops = new Map([['n1', marks]]);
  const { svg, prims } = renderStations(stops, { dark: false, showBullets: true }, getStationDesign('classic'));
  assert.equal(svg.length, 1);
  assert.ok(svg[0].includes('class="imp-stop"'));
  assert.ok(svg[0].includes('data-station-id="n1"'));
  assert.ok(prims.some((p) => p.kind === 'circle' && p.layer === 'stops'));
});
