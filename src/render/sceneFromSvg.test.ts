import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneFromSvg } from './sceneFromSvg';
import { prepareScene, labelScreenBox, isLabelHidden } from './sceneCanvas';
import type { TextPrim } from './sceneIR';

// A representative slice of renderRibbons' output: svg header + data-frame, land
// rect, an unclassed geography backdrop group, an .edges bundle (casing+stroke),
// a .transfers connector, a .stops marker (imp-stop > inner g > circle + bullet
// text), and a .stations label (imp-lbl translate > imp-lbl-s > text).
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2700 2700" width="2700" height="2700" data-frame="100.0 200.0 1000.0 800.0">\n' +
  '<rect width="2700" height="2700" fill="#ffffff"/>\n' +
  '<g fill="#cfe8ff" fill-rule="nonzero" stroke="none"><path d="M0 0 L10 0 L10 10 Z"/></g>\n' +
  '<g class="edges">\n' +
  '<path d="M1,2L3,4" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>\n' +
  '<path d="M1,2L3,4" fill="none" stroke="#ff0000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" data-line-id="r1"/>\n' +
  '</g>\n' +
  '<g class="transfers"><path d="M5 5 L6 6" fill="none" stroke="#888888" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/></g>\n' +
  '<g class="stops">\n' +
  '<g class="imp-stop" data-ax="10.0" data-ay="20.0"><g data-stops="r1" data-station-id="n1"><circle cx="10.0" cy="20.0" r="2.8" fill="#fff" stroke="#ff0000" stroke-width="1.50" data-line="r1"/><text x="10.0" y="21.6" text-anchor="middle" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="4.50" font-weight="bold" fill="#111111">A</text></g></g>\n' +
  '</g>\n' +
  '<g class="stations">\n' +
  '<g class="imp-lbl" data-station-id="n1" transform="translate(10.0,20.0)"><g class="imp-lbl-s"><text x="6.0" y="3.0" text-anchor="start" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="11" fill="#222" font-weight="medium">Foo &amp; Bar</text></g></g>\n' +
  '</g>\n</svg>';

test('sceneFromSvg parses canvas + frame + background', () => {
  const s = sceneFromSvg(SVG);
  assert.equal(s.width, 2700);
  assert.equal(s.height, 2700);
  assert.deepEqual(s.frame, { x: 100, y: 200, w: 1000, h: 800 });
  assert.equal(s.background, '#ffffff');
});

test('sceneFromSvg: edges are worldScale, casing+stroke both captured', () => {
  const s = sceneFromSvg(SVG);
  const edges = s.prims.filter((p) => p.layer === 'edges');
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.kind, 'path');
    assert.equal(e.worldScale, true); // inside .edges → scales with the map
  }
  const casing = edges[0];
  const stroke = edges[1];
  assert.equal(casing.kind === 'path' && casing.stroke, '#ffffff');
  assert.equal(casing.kind === 'path' && casing.strokeWidth, 7);
  assert.equal(stroke.kind === 'path' && stroke.stroke, '#ff0000');
  assert.equal(stroke.kind === 'path' && stroke.strokeWidth, 4);
  assert.equal(stroke.kind === 'path' && stroke.lineCap, 'round');
});

test('sceneFromSvg: geography backdrop is unclassed/world-positioned (other)', () => {
  const s = sceneFromSvg(SVG);
  const water = s.prims.find((p) => p.kind === 'path' && p.fillRule === 'nonzero');
  assert.ok(water);
  assert.equal(water!.layer, 'other');
  assert.equal(water!.worldScale, false);
});

test('sceneFromSvg: transfers carry opacity and counter-scale', () => {
  const s = sceneFromSvg(SVG);
  const t = s.prims.find((p) => p.layer === 'transfers');
  assert.ok(t);
  assert.equal(t!.opacity, 0.85);
  assert.equal(t!.worldScale, false);
});

test('sceneFromSvg: stop marker dot + route bullet are worldScale at world pos', () => {
  const s = sceneFromSvg(SVG);
  const stops = s.prims.filter((p) => p.layer === 'stops');
  const dot = stops.find((p) => p.kind === 'circle');
  const bullet = stops.find((p) => p.kind === 'text') as TextPrim | undefined;
  assert.ok(dot);
  assert.equal(dot!.worldScale, true);
  assert.equal(dot!.kind === 'circle' && dot!.cx, 10);
  assert.ok(bullet);
  assert.equal(bullet!.worldScale, true); // bullet scales with the marker
  assert.equal(bullet!.text, 'A');
  assert.equal(bullet!.x, 10); // world position, not a screen offset
  assert.equal(bullet!.ax, 0);
});

test('sceneFromSvg: label is screen-scaled, world-anchored, entity-decoded', () => {
  const s = sceneFromSvg(SVG);
  const label = s.prims.find((p) => p.layer === 'stations' && p.kind === 'text') as TextPrim | undefined;
  assert.ok(label);
  assert.equal(label!.worldScale, false); // constant screen size
  assert.equal(label!.ax, 10); // world anchor from the outer translate
  assert.equal(label!.ay, 20);
  assert.equal(label!.x, 6); // screen-space offset
  assert.equal(label!.y, 3);
  assert.equal(label!.align, 'left');
  assert.equal(label!.fontSize, 11);
  assert.equal(label!.text, 'Foo & Bar'); // &amp; decoded
});

test('prepareScene buckets into draw-order layers', () => {
  const s = sceneFromSvg(SVG);
  const p = prepareScene(s);
  assert.equal(p.edges.length, 2);
  assert.equal(p.transfers.length, 1);
  assert.equal(p.labels.length, 1);
  // base = background rect + geography backdrop path, background first.
  assert.ok(p.base.length >= 2);
  assert.equal(p.base[0].layer, 'background');
  // stops bucket has the dot + the bullet text.
  assert.equal(p.stops.length, 2);
});

test('labelScreenBox + isLabelHidden: analytic overlap with the view', () => {
  const label: TextPrim = {
    kind: 'text',
    text: 'Foo',
    x: 6,
    y: 3,
    ax: 100,
    ay: 100,
    fontSize: 11,
    fontWeight: 'medium',
    align: 'left',
    fill: '#222',
    layer: 'stations',
    worldScale: false,
  };
  const view = { scale: 2, vx: 0, vy: 0 };
  const box = labelScreenBox(label, view);
  // anchor screen pos = (100-0)*2 = 200; + offset (6,3) → text starts at (206,203)
  assert.equal(box.x0, 206);
  assert.ok(box.x1 > box.x0);

  // A cutout box covering the anchor hides the label (rule 1).
  assert.equal(isLabelHidden(label, view, [{ x0: 90, y0: 90, x1: 110, y1: 110 }]), true);
  // A far-away box leaves it visible.
  assert.equal(isLabelHidden(label, view, [{ x0: -50, y0: -50, x1: -10, y1: -10 }]), false);
  // No boxes → never hidden.
  assert.equal(isLabelHidden(label, view, []), false);
});
