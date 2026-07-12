import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPlaces, placesSvg, placesPrims } from '../neighborhoods';
import type { GeographyData } from '../../geography/types';

const identity = { toSVG: (c: [number, number]): [number, number] => [c[0], c[1]] };

const geo = (places: GeographyData['places']): GeographyData => ({
  bbox: [0, 0, 1000, 1000], water: [], green: [], places,
});

test('projectPlaces declutters by kind priority then name, deterministic', () => {
  const g = geo([
    // two labels 60px apart: the suburb outranks the neighbourhood
    { name: 'Little Corner', coord: [500, 500], kind: 'neighbourhood' },
    { name: 'Big Suburb', coord: [540, 540], kind: 'suburb' },
    // far away, kept
    { name: 'Elsewhere', coord: [100, 100], kind: 'quarter' },
    // off-canvas, dropped
    { name: 'Offscreen', coord: [5000, 5000], kind: 'suburb' },
  ]);
  const kept = projectPlaces(g, identity, 1000, 1000);
  assert.deepEqual(kept.map((p) => p.name).sort(), ['Big Suburb', 'Elsewhere']);
  assert.deepEqual(projectPlaces(g, identity, 1000, 1000), kept, 'deterministic on repeat');
});

test('projectPlaces returns empty for absent places and empty geography', () => {
  assert.deepEqual(projectPlaces(undefined, identity, 100, 100), []);
  assert.deepEqual(projectPlaces(geo(undefined), identity, 100, 100), []);
  assert.deepEqual(projectPlaces(geo([]), identity, 100, 100), []);
});

test('placesSvg emits an uppercase text layer; empty input emits nothing', () => {
  const kept = projectPlaces(geo([{ name: 'Ballard', coord: [10, 20], kind: 'suburb' }]), identity, 100, 100);
  const svg = placesSvg(kept, true);
  assert.ok(svg.startsWith('<g class="nbhd">'));
  assert.ok(svg.includes('>BALLARD</text>'));
  assert.equal(placesSvg([], true), '');
  assert.equal(placesSvg(undefined, true), '');
});

test('placesPrims mirrors the SVG layer for the canvas scene', () => {
  const kept = projectPlaces(geo([{ name: 'Fremont', coord: [10, 20], kind: 'suburb' }]), identity, 100, 100);
  const prims = placesPrims(kept, false);
  assert.equal(prims.length, 1);
  const t = prims[0] as { kind: string; text: string; worldScale: boolean };
  assert.equal(t.kind, 'text');
  assert.equal(t.text, 'FREMONT');
  assert.equal(t.worldScale, true);
});
