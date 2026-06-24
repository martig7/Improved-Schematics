import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geographyBackdrop } from './geographyBackdrop';
import { DEFAULT_THEME } from './types';
import type { Projection } from './projection';
import type { GeographyData } from '../geography/types';

// Identity-ish projection: lng→x, lat→y (no flip) so assertions are simple.
const proj: Projection = { width: 100, height: 100, toSVG: ([lng, lat]) => [lng, lat] };

const GEO: GeographyData = {
  bbox: [0, 0, 10, 10],
  water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] } }],
  green: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] } }],
};

test('geographyBackdrop: returns "" when geography is undefined', () => {
  assert.equal(geographyBackdrop(undefined, proj, DEFAULT_THEME, false), '');
});

test('geographyBackdrop: emits a green group then a water group (water on top)', () => {
  const svg = geographyBackdrop(GEO, proj, DEFAULT_THEME, false);
  const greenIdx = svg.indexOf(DEFAULT_THEME.green);
  const waterIdx = svg.indexOf(DEFAULT_THEME.water);
  assert.ok(greenIdx >= 0, 'has green fill');
  assert.ok(waterIdx >= 0, 'has water fill');
  assert.ok(greenIdx < waterIdx, 'green is drawn before water');
  assert.ok(svg.includes('M0 0 L10 0 L10 10'), 'projects water ring');
  assert.ok(svg.includes(`fill="${DEFAULT_THEME.green}" fill-rule="nonzero"`), 'parks fill solid (nonzero)');
  assert.ok(svg.includes(`fill="${DEFAULT_THEME.water}" fill-rule="nonzero"`), 'water fills solid (nonzero, no XOR gaps)');
  // Classed so the canvas backend buckets them into the backdrop layer (below routes).
  assert.ok(svg.includes(`<g class="green" fill="${DEFAULT_THEME.green}"`), 'green group carries class="green"');
  assert.ok(svg.includes(`<g class="water" fill="${DEFAULT_THEME.water}"`), 'water group carries class="water"');
});

test('geographyBackdrop: omits an empty category', () => {
  const svg = geographyBackdrop({ ...GEO, green: [] }, proj, DEFAULT_THEME, false);
  assert.ok(!svg.includes(DEFAULT_THEME.green));
  assert.ok(svg.includes(DEFAULT_THEME.water));
});
