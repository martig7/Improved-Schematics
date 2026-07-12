import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphsToSvg, glyphsToPrims, wrapMarker } from '../serialize';
import { sceneFromSvg } from '../../sceneFromSvg';
import type { Glyph } from '../types';

const sample: Glyph[] = [
  { kind: 'circle', cx: 10, cy: 10, r: 3, fill: '#ffffff', stroke: '#dc2626', strokeWidth: 1.5, data: { 'data-line': 'L1' } },
  { kind: 'text', x: 10, y: 12, text: 'A', fontSize: 5, fontWeight: 'bold', fill: '#111111', align: 'middle' },
];

test('glyphsToSvg emits circle + text with data-line and text-anchor', () => {
  const svg = glyphsToSvg(sample);
  assert.ok(svg.includes('<circle'));
  assert.ok(svg.includes('data-line="L1"'));
  assert.ok(svg.includes('stroke="#dc2626"'));
  assert.ok(svg.includes('text-anchor="middle"'));
  assert.ok(svg.includes('>A</text>'));
});

test('glyphsToPrims stamps stops layer + worldScale', () => {
  const prims = glyphsToPrims(sample);
  assert.equal(prims.length, 2);
  for (const p of prims) { assert.equal(p.layer, 'stops'); assert.equal(p.worldScale, true); }
  const t = prims.find((p) => p.kind === 'text') as { ax: number; ay: number; align: string };
  assert.equal(t.ax, 0); assert.equal(t.ay, 0); assert.equal(t.align, 'center');
});

test('wrapMarker output parses back to matching stops prims via sceneFromSvg', () => {
  const svg = '<svg viewBox="0 0 100 100">' + wrapMarker([10, 10], 'n1', ['L1'], glyphsToSvg(sample)) + '</svg>';
  const scene = sceneFromSvg(svg);
  const emitted = glyphsToPrims(sample);
  const circleP = scene.prims.find((p) => p.kind === 'circle') as { fill: string; stroke: string; strokeWidth: number; worldScale: boolean; layer: string };
  assert.equal(circleP.fill, '#ffffff');
  assert.equal(circleP.stroke, '#dc2626');
  assert.equal(circleP.worldScale, true);
  assert.equal(circleP.layer, 'stops');
  const parsedText = scene.prims.find((p) => p.kind === 'text') as { text: string; align: string };
  const emittedText = emitted.find((p) => p.kind === 'text') as { text: string; align: string };
  assert.equal(parsedText.text, emittedText.text);
  assert.equal(parsedText.align, emittedText.align);
});

test('direct-emit prims agree with sceneFromSvg on NON-integer geometry (rounding parity)', () => {
  // Real capsule dots land on non-integer positions/radii; the direct-emit prim
  // (canvas) must equal what sceneFromSvg parses from the rounded SVG (export).
  const gs: Glyph[] = [
    { kind: 'circle', cx: 10.37, cy: 20.62, r: 1.5925, fill: '#ffffff', stroke: '#dc2626', strokeWidth: 0.975, data: { 'data-line': 'L1' } },
    { kind: 'text', x: 10.37, y: 22.13, text: 'A', fontSize: 2.7115, fontWeight: 'bold', fill: '#111111', align: 'middle' },
    { kind: 'path', d: 'M 1.0 2.0 L 3.0 4.0', fill: 'none', stroke: '#111111', strokeWidth: 6.87, lineCap: 'round', lineJoin: 'round' },
  ];
  const svg = '<svg viewBox="0 0 100 100">' + wrapMarker([10.37, 20.62], 'n1', ['L1'], glyphsToSvg(gs)) + '</svg>';
  const parsed = sceneFromSvg(svg).prims;
  const direct = glyphsToPrims(gs);
  const pick = (arr: readonly unknown[], kind: string) => arr.find((p) => (p as { kind: string }).kind === kind) as Record<string, number>;
  for (const k of ['cx', 'cy', 'r', 'strokeWidth']) assert.equal(pick(direct, 'circle')[k], pick(parsed, 'circle')[k], `circle ${k}`);
  for (const k of ['x', 'y', 'fontSize']) assert.equal(pick(direct, 'text')[k], pick(parsed, 'text')[k], `text ${k}`);
  assert.equal(pick(direct, 'path').strokeWidth, pick(parsed, 'path').strokeWidth, 'path strokeWidth');
});

test('text glyph fontFamily round-trips: svg emit -> scene parse equals direct prim', () => {
  const glyph = {
    kind: 'text' as const, x: 10, y: 20, text: '05', fontSize: 3.2, fontWeight: 'bold',
    align: 'middle' as const, fill: '#1e1a1b',
    fontFamily: '"TRTA Numbers Sharp", "Open Sans", Helvetica, sans-serif',
  };
  const svg = glyphsToSvg([glyph]);
  assert.ok(svg.includes('font-family="&quot;TRTA Numbers Sharp&quot;, &quot;Open Sans&quot;, Helvetica, sans-serif"'), 'family emitted escaped');
  const direct = glyphsToPrims([glyph])[0];
  assert.equal((direct as { fontFamily?: string }).fontFamily, glyph.fontFamily);
  const scene = sceneFromSvg(`<svg viewBox="0 0 100 100"><g class="imp-stop" data-ax="10" data-ay="20"><g data-stops="L" data-station-id="n">${svg}</g></g></svg>`);
  const t = scene.prims.find((p) => p.kind === 'text') as { fontFamily?: string };
  assert.equal(t.fontFamily, glyph.fontFamily, 'parsed family matches (entities decoded)');
});

test('text glyph WITHOUT fontFamily emits the default stack and parses back with none', () => {
  const glyph = {
    kind: 'text' as const, x: 10, y: 20, text: 'A', fontSize: 3, fontWeight: 'bold',
    align: 'middle' as const, fill: '#111111',
  };
  const svg = glyphsToSvg([glyph]);
  assert.ok(svg.includes('font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif"'), 'default stack byte-stable');
  const scene = sceneFromSvg(`<svg viewBox="0 0 100 100"><g class="imp-stop" data-ax="10" data-ay="20"><g data-stops="L" data-station-id="n">${svg}</g></g></svg>`);
  const t = scene.prims.find((p) => p.kind === 'text') as { fontFamily?: string };
  assert.equal(t.fontFamily, undefined, 'default stack stays implicit');
});
