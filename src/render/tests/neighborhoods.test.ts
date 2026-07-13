import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPlaces, placesSvg, placesPrims, filterPlacesKind, placeKinds, kindLabel, placeFrameScale, PLACE_FONT_SIZE } from '../neighborhoods';
import type { GeographyData } from '../../geography/types';

const identity = { toSVG: (c: [number, number]): [number, number] => [c[0], c[1]] };

const geo = (places: GeographyData['places']): GeographyData => ({
  bbox: [0, 0, 3000, 3000], water: [], green: [], places,
});

test('projectPlaces keeps every named place; no decluttering (game thins by construction)', () => {
  const g = geo([
    // three points within a tight cluster: ALL kept (we do not declutter)
    { name: 'Little Corner', coord: [500, 500], kind: 'neighbourhood' },
    { name: 'Other Corner', coord: [510, 510], kind: 'neighbourhood' },
    { name: 'Big Suburb', coord: [520, 520], kind: 'suburb' },
    { name: 'Elsewhere', coord: [100, 100], kind: 'quarter' },
    // off-canvas, dropped
    { name: 'Offscreen', coord: [9000, 9000], kind: 'suburb' },
    // unnamed, dropped
    { name: '', coord: [200, 200], kind: 'suburb' },
  ]);
  const kept = projectPlaces(g, identity, 2700, 2700);
  assert.deepEqual(kept.map((p) => p.name), ['Big Suburb', 'Elsewhere', 'Little Corner', 'Other Corner'], 'all named on-canvas kept, name-sorted');
  assert.deepEqual(projectPlaces(g, identity, 2700, 2700), kept, 'deterministic on repeat');
});

test('projectPlaces drops points beyond the off-canvas margin only', () => {
  const g = geo([
    { name: 'In', coord: [1350, 1350], kind: 'suburb' },
    { name: 'JustOff', coord: [2705, 1350], kind: 'suburb' }, // within margin at scale 1 (margin ~16.5)
    { name: 'FarOff', coord: [3200, 1350], kind: 'suburb' },
  ]);
  assert.deepEqual(projectPlaces(g, identity, 2700, 2700, 1).map((p) => p.name), ['In', 'JustOff']);
});

test('placeFrameScale keys off the larger frame dimension over the 2700 base', () => {
  assert.equal(placeFrameScale(2700, 2700), 1);
  assert.equal(placeFrameScale(1350, 2700), 1); // tall frame: max is the height
  assert.equal(placeFrameScale(1196, 2000), 2000 / 2700);
  assert.equal(placeFrameScale(4050, 2894), 4050 / 2700);
});

test('projectPlaces returns empty for absent places and empty geography', () => {
  assert.deepEqual(projectPlaces(undefined, identity, 100, 100), []);
  assert.deepEqual(projectPlaces(geo(undefined), identity, 100, 100), []);
  assert.deepEqual(projectPlaces(geo([]), identity, 100, 100), []);
});

test('filterPlacesKind narrows to one kind; undefined shows all', () => {
  const kept = projectPlaces(geo([
    { name: 'Ballard', coord: [500, 500], kind: 'suburb' },
    { name: 'Fremont', coord: [900, 900], kind: 'neighbourhood' },
  ]), identity, 2700, 2700);
  assert.deepEqual(filterPlacesKind(kept, 'suburb').map((p) => p.name), ['Ballard']);
  assert.deepEqual(filterPlacesKind(kept, undefined).map((p) => p.name).sort(), ['Ballard', 'Fremont']);
  assert.deepEqual(filterPlacesKind(undefined, 'suburb'), []);
});

test('placeKinds lists distinct kinds sorted; kindLabel names them', () => {
  const g = geo([
    { name: 'A', coord: [1, 1], kind: 'suburb' },
    { name: 'B', coord: [2, 2], kind: 'neighbourhood' },
    { name: 'C', coord: [3, 3], kind: 'suburb' },
  ]);
  assert.deepEqual(placeKinds(g), ['neighbourhood', 'suburb']);
  assert.deepEqual(placeKinds(undefined), []);
  assert.equal(kindLabel('neighbourhood'), 'Neighborhoods');
  assert.equal(kindLabel('suburb'), 'Suburbs');
  assert.equal(kindLabel('locality'), 'Localitys');
});

test('placesSvg emits an uppercase text layer at the given size; empty input emits nothing', () => {
  const kept = projectPlaces(geo([{ name: 'Ballard', coord: [10, 20], kind: 'suburb' }]), identity, 2700, 2700);
  const svg = placesSvg(kept, true, 24);
  assert.ok(svg.startsWith('<g class="nbhd">'));
  assert.ok(svg.includes('>BALLARD</text>'));
  assert.ok(svg.includes('font-size="24.0"'));
  assert.ok(placesSvg(kept, true).includes(`font-size="${PLACE_FONT_SIZE.toFixed(1)}"`), 'defaults to the base size');
  assert.equal(placesSvg([], true), '');
  assert.equal(placesSvg(undefined, true), '');
});

test('placesPrims mirrors the SVG layer for the canvas scene at the given size', () => {
  const kept = projectPlaces(geo([{ name: 'Fremont', coord: [10, 20], kind: 'suburb' }]), identity, 2700, 2700);
  const prims = placesPrims(kept, false, 30);
  assert.equal(prims.length, 1);
  const t = prims[0] as { kind: string; text: string; worldScale: boolean; fontSize: number };
  assert.equal(t.kind, 'text');
  assert.equal(t.text, 'FREMONT');
  assert.equal(t.worldScale, true);
  assert.equal(t.fontSize, 30);
});
