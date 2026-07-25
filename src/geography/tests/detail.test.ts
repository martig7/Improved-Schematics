import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoundingBox } from '../../types/core';
import {
  harvestRegions,
  fitZoom,
  harvestContainerPx,
  tileEstimate,
  DETAIL_CONTAINER_PX,
  DEFAULT_LAND_DETAIL,
} from '../detail';

// A large metro extent (~300km across) and a compact one, so the zoom math is
// exercised at both ends of the range real cities span.
const BIG: BoundingBox = [-122.6, 37.0, -121.2, 38.2];
const SMALL: BoundingBox = [-0.35, 51.35, 0.1, 51.65];

test('fitZoom rises one whole step per container doubling', () => {
  const z1 = fitZoom(BIG, 512);
  const z2 = fitZoom(BIG, 1024);
  const z4 = fitZoom(BIG, 2048);
  assert.ok(Math.abs(z2 - z1 - 1) < 1e-9, 'doubling the container adds exactly one zoom level');
  assert.ok(Math.abs(z4 - z1 - 2) < 1e-9);
});

test('fitZoom takes the tighter axis and grows as the bbox shrinks', () => {
  assert.ok(fitZoom(SMALL, 512) > fitZoom(BIG, 512), 'a smaller extent fits at a higher zoom');
  // A wide-but-short bbox is limited by longitude, not latitude.
  const wide: BoundingBox = [-10, 51.4, 10, 51.5];
  assert.ok(fitZoom(wide, 512) < fitZoom(SMALL, 512));
});

test('the legacy 512 container harvests a large metro at a region-level zoom', () => {
  // The behaviour this feature exists to fix: ~z7 tiles are already decimated.
  const z = fitZoom(BIG, 512);
  assert.ok(z > 6 && z < 8, `expected a region-level zoom, got ${z.toFixed(2)}`);
  // The detailed level buys two whole levels over it.
  assert.ok(Math.abs(fitZoom(BIG, DETAIL_CONTAINER_PX.detailed) - z - 2) < 1e-9);
});

test('harvestContainerPx returns the level size when no maxzoom constrains it', () => {
  assert.equal(harvestContainerPx(BIG, 'standard'), 512);
  assert.equal(harvestContainerPx(BIG, 'detailed'), 2048);
  assert.equal(harvestContainerPx(BIG, 'ultra'), 4096);
  assert.equal(harvestContainerPx(BIG, 'ultra', Number.NaN), 4096, 'invalid maxzoom does not clamp');
});

test('harvestContainerPx halves down until the implied zoom fits maxzoom', () => {
  // BIG sits at ~z7.1 at 512, so ultra (4096) implies ~z10.1.
  const capped = harvestContainerPx(BIG, 'ultra', 8);
  assert.ok(fitZoom(BIG, capped) <= 8, 'never requests past maxzoom');
  assert.ok(capped < DETAIL_CONTAINER_PX.ultra, 'actually reduced');
  // A generous maxzoom leaves the request untouched.
  assert.equal(harvestContainerPx(BIG, 'ultra', 14), 4096);
});

test('harvestContainerPx never drops below a single tile', () => {
  // An absurdly low maxzoom still leaves one tile across the bbox.
  assert.equal(harvestContainerPx(BIG, 'ultra', -5), 512);
});

test('an unknown level falls back to the default', () => {
  const px = harvestContainerPx(BIG, 'nonsense' as never);
  assert.equal(px, DETAIL_CONTAINER_PX[DEFAULT_LAND_DETAIL]);
});

test('tileEstimate is quadratic in the container size', () => {
  assert.equal(tileEstimate(512), 1);
  assert.equal(tileEstimate(2048), 16);
  assert.equal(tileEstimate(4096), 64);
});

// Multi-pass regions. A second pass is only worth its tiles when it covers
// enough less ground to actually land at a higher zoom.
const NETWORK: BoundingBox = [-122.45, 47.50, -122.20, 47.72]; // well inside BIG

test('harvestRegions: full extent alone when there is no network extent', () => {
  const r = harvestRegions(BIG, null, 'detailed');
  assert.equal(r.length, 1);
  assert.equal(r[0].label, 'full');
});

test('harvestRegions: a much smaller network adds a finer second pass', () => {
  const r = harvestRegions(BIG, NETWORK, 'detailed');
  assert.equal(r.length, 2);
  assert.equal(r[1].label, 'network');
  // Same tile cost, strictly more resolution, purely from covering less ground.
  assert.equal(r[1].containerPx, r[0].containerPx);
  assert.ok(fitZoom(r[1].bbox, r[1].containerPx) > fitZoom(r[0].bbox, r[0].containerPx));
  // Coarsest first, so finer geometry unions over it.
  assert.ok(fitZoom(r[0].bbox, r[0].containerPx) < fitZoom(r[1].bbox, r[1].containerPx));
});

test('harvestRegions: a network nearly as large as the map earns no second pass', () => {
  const almost: BoundingBox = [BIG[0] + 0.01, BIG[1] + 0.01, BIG[2] - 0.01, BIG[3] - 0.01];
  assert.equal(harvestRegions(BIG, almost, 'detailed').length, 1);
});

test('harvestRegions: maxzoom clamps every pass down to the one-tile floor', () => {
  const capped = harvestRegions(BIG, NETWORK, 'ultra', 9);
  for (const reg of capped) {
    // Clamped under maxzoom, unless already at a single tile across the region,
    // which is as coarse as a pass can get.
    assert.ok(fitZoom(reg.bbox, reg.containerPx) <= 9 || reg.containerPx === 512,
      `${reg.label}: z=${fitZoom(reg.bbox, reg.containerPx).toFixed(1)} px=${reg.containerPx}`);
    assert.ok(reg.containerPx < DETAIL_CONTAINER_PX.ultra, `${reg.label} was reduced from ultra`);
  }
});
