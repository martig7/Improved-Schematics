import { test } from 'node:test';
import assert from 'node:assert/strict';
import UPNG from 'upng-js';
import {
  edgeScale,
  encodePalettePng,
  encodeForDiscord,
  DISCORD_MAX_EDGE,
  DISCORD_MAX_BYTES,
  type RasterFrame,
} from '../discordExport';

// A flat two-colour RGBA frame of the given size: the ideal line-art case, so it
// quantizes to a tiny palette PNG.
const flatFrame = (w: number, h: number): RasterFrame => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = (i % w) < w / 2 ? [220, 40, 40, 255] : [40, 80, 200, 255];
    rgba.set(c, i * 4);
  }
  return { rgba: rgba.buffer, width: w, height: h };
};

test('edgeScale brings the longer side to the target edge', () => {
  assert.equal(edgeScale(2700, 2700, 3600), 3600 / 2700);
  // Non-square: the LONGER side hits the edge (shorter stays proportional).
  assert.equal(edgeScale(1500, 2700, 2700), 1);
  assert.equal(edgeScale(2700, 1350, 2700), 1);
});

test('encodePalettePng emits a valid PNG (signature + dimensions)', () => {
  const png = encodePalettePng(flatFrame(64, 48).rgba, 64, 48, 256);
  // PNG magic number.
  assert.deepEqual([...new Uint8Array(png, 0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const dec = UPNG.decode(png);
  assert.equal(dec.width, 64);
  assert.equal(dec.height, 48);
  assert.equal(dec.ctype, 3, 'palette (indexed) colour type');
});

test('encodeForDiscord returns the first fitting encoding and rasterizes at the max edge', () => {
  const edges: number[] = [];
  const { png, fits } = encodeForDiscord((edge) => {
    edges.push(edge);
    return flatFrame(200, 150); // tiny -> fits on the first try
  });
  assert.equal(fits, true);
  assert.ok(png.byteLength <= DISCORD_MAX_BYTES);
  // A fit on attempt 1 means only the largest edge was rasterized (no step-down).
  assert.deepEqual(edges, [DISCORD_MAX_EDGE]);
});

test('encodeForDiscord steps through the ladder and reports !fits when nothing fits', () => {
  // An unreachable 1-byte budget forces every step over budget; the call must walk
  // the whole edge ladder and still return the smallest PNG it produced.
  const edges: number[] = [];
  const { png, fits } = encodeForDiscord((edge) => {
    edges.push(edge);
    return flatFrame(200, 150);
  }, 1);
  assert.equal(fits, false);
  assert.ok(png.byteLength > 0, 'still returns a downloadable PNG');
  assert.equal(edges.length, 3, 'tried every edge step');
});
