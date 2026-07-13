import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPlaces, placesSvg, placesPrims, declutterPlaces, selectPlaces, tiersAtZoom, tierRank, placeFrameScale, PLACE_FONT_SIZE } from '../neighborhoods';
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

test('tiersAtZoom follows the basemap zoom bands', () => {
  assert.deepEqual([...tiersAtZoom(8)], ['city']);
  assert.deepEqual([...tiersAtZoom(11)].sort(), ['city', 'suburb']); // the default
  assert.deepEqual([...tiersAtZoom(12)].sort(), ['city', 'neighbourhood', 'suburb']);
  assert.deepEqual([...tiersAtZoom(14)].sort(), ['neighbourhood', 'suburb']);
  assert.deepEqual([...tiersAtZoom(15)], ['neighbourhood']);
});

test('tierRank orders city < suburb < neighbourhood', () => {
  assert.ok(tierRank('city') < tierRank('suburb'));
  assert.ok(tierRank('suburb') < tierRank('neighbourhood'));
  assert.equal(tierRank('neighborhood'), tierRank('neighbourhood')); // spelling alias
  assert.ok(tierRank('mystery') >= 3);
});

test('declutterPlaces culls overlapping labels, bigger tier wins, wider padding culls more', () => {
  const near = [
    { name: 'Small', px: [1000, 1000] as [number, number], kind: 'neighbourhood' },
    { name: 'Big', px: [1010, 1000] as [number, number], kind: 'suburb' },
    { name: 'FarAway', px: [2000, 2000] as [number, number], kind: 'neighbourhood' },
  ];
  const kept = declutterPlaces(near, 30, 0.6);
  assert.deepEqual(kept.map((p) => p.name).sort(), ['Big', 'FarAway'], 'suburb beats neighbourhood, far one kept');
  // Zero padding + tiny font: nothing overlaps, all three survive.
  assert.equal(declutterPlaces(near, 1, 0).length, 3);
  assert.deepEqual(declutterPlaces(near, 30, 0.6), kept, 'deterministic on repeat');
});

test('selectPlaces: zoom picks the visible tiers; padding controls how hard it culls', () => {
  const mixed = [
    { name: 'City', px: [500, 500] as [number, number], kind: 'city' },
    { name: 'Town', px: [1500, 500] as [number, number], kind: 'suburb' },
    { name: 'Block', px: [2500, 500] as [number, number], kind: 'neighbourhood' },
  ];
  // zoom 11 = city + suburb (no neighbourhood); zoom 12 adds it.
  assert.deepEqual(selectPlaces(mixed, 11, 8, 10).map((p) => p.name).sort(), ['City', 'Town']);
  assert.deepEqual(selectPlaces(mixed, 12, 8, 10).map((p) => p.name).sort(), ['Block', 'City', 'Town']);
  // A dense same-tier row at zoom 12: more padding keeps fewer.
  const row = Array.from({ length: 12 }, (_, i) => ({
    name: `N${i}`, px: [1000 + i * 40, 1000] as [number, number], kind: 'neighbourhood',
  }));
  const light = selectPlaces(row, 12, 4, 20);
  const heavy = selectPlaces(row, 12, 32, 20);
  assert.ok(heavy.length < light.length, `heavy padding (${heavy.length}) culls more than light (${light.length})`);
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
