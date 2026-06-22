// Phase 3 oracle: renderRibbons emits the Scene IR directly (via sceneOut). The
// proven SVG parser (sceneFromSvg, Phase 1/2) is the ORACLE — for every layer the
// direct emitter produces, its prims must match what parsing the SAME svg yields.
// Plus the additivity invariant: passing sceneOut must not change the svg string.
//
// As each Phase-3 part adds a layer's direct emission (transfers, stops, labels),
// `presentLayers` grows and this test automatically covers it. The final part
// flips `EXPECT_FULL_COVERAGE` to assert the direct scene covers every drawn layer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precomputeSmoothed, drawSmoothed } from './renderGeographic';
import type { SceneOut } from './renderOctilinear';
import { sceneFromSvg } from './sceneFromSvg';
import type { Prim, Scene, Layer } from './sceneIR';
import type { GeographyData } from '../geography/types';

// Set true once transfers + stops + labels are all direct-emitted (final part).
const EXPECT_FULL_COVERAGE = true;

const STATIONS = [
  { id: 's1', name: 'Alpha', coords: [-122.0, 47.0], trackIds: ['t1'], trackGroupId: 'g1', buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's2', name: 'Beta & Co', coords: [-122.05, 47.02], trackIds: ['t2'], trackGroupId: 'g2', buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1', 'r2'], createdAt: 0, nearbyStations: [] },
  { id: 's3', name: 'Gamma', coords: [-122.1, 47.0], trackIds: ['t3'], trackGroupId: 'g3', buildType: 'constructed', stNodeIds: ['n3'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  { id: 's4', name: 'Delta', coords: [-122.05, 46.97], trackIds: ['t4'], trackGroupId: 'g4', buildType: 'constructed', stNodeIds: ['n4'], routeIds: ['r2'], createdAt: 0, nearbyStations: [] },
];
const TRACKS = [
  { id: 't1', coords: [[-122.0, 47.0], [-122.05, 47.02]] },
  { id: 't2', coords: [[-122.05, 47.02], [-122.1, 47.0]] },
  { id: 't3', coords: [[-122.05, 47.02], [-122.05, 46.97]] },
];
const ROUTES = [
  { id: 'r1', bullet: '1', color: '#cc0000', stComboTimings: [], stCombos: [
    { startStNodeId: 'n1', endStNodeId: 'n2', path: [{ trackId: 't1', reversed: false }], distance: 1 },
    { startStNodeId: 'n2', endStNodeId: 'n3', path: [{ trackId: 't2', reversed: false }], distance: 1 } ] },
  { id: 'r2', bullet: '2', color: '#0000cc', stComboTimings: [], stCombos: [
    { startStNodeId: 'n2', endStNodeId: 'n4', path: [{ trackId: 't3', reversed: false }], distance: 1 } ] },
];
const GEO: GeographyData = {
  bbox: [-122.12, 46.95, -121.98, 47.05],
  water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-122.1, 47.0], [-122.05, 47.0], [-122.05, 47.03], [-122.1, 47.03], [-122.1, 47.0]]] } }],
  green: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-122.02, 46.98], [-122.0, 46.98], [-122.0, 47.0], [-122.02, 47.0], [-122.02, 46.98]]] } }],
};

function render(): { svg: string; svgNoSink: string; scene: Scene } {
  const pre = precomputeSmoothed({
    routes: ROUTES as never,
    tracks: TRACKS as never,
    stations: STATIONS as never,
    geography: GEO,
    options: { mode: 'smoothed', showLabels: true, showStations: true, width: 600, height: 600 },
  });
  assert.notEqual(typeof pre, 'string', 'fixture must precompute a real layout');
  if (typeof pre === 'string') throw new Error('unreachable');
  const out: SceneOut = { scene: null };
  const opts = { showLabels: true, showStations: true };
  const svg = drawSmoothed(pre, opts, out);
  const svgNoSink = drawSmoothed(pre, opts);
  assert.ok(out.scene, 'sceneOut should be filled');
  return { svg, svgNoSink, scene: out.scene! };
}

const near = (a: number, b: number, tol = 0.2) => Math.abs(a - b) <= tol;

function assertPrimMatch(a: Prim, b: Prim, msg: string): void {
  assert.equal(a.kind, b.kind, `${msg} kind`);
  assert.equal(a.worldScale, b.worldScale, `${msg} worldScale`);
  if (a.kind === 'path' && b.kind === 'path') {
    assert.equal(a.d, b.d, `${msg} d`);
    assert.equal(a.fill, b.fill, `${msg} fill`);
    assert.equal(a.stroke, b.stroke, `${msg} stroke`);
    assert.ok(near(a.strokeWidth, b.strokeWidth, 0.05), `${msg} strokeWidth`);
    assert.equal(a.fillRule ?? null, b.fillRule ?? null, `${msg} fillRule`);
  } else if (a.kind === 'circle' && b.kind === 'circle') {
    assert.ok(near(a.cx, b.cx) && near(a.cy, b.cy) && near(a.r, b.r), `${msg} circle geom`);
    assert.equal(a.fill, b.fill, `${msg} fill`);
    assert.equal(a.stroke, b.stroke, `${msg} stroke`);
  } else if (a.kind === 'rect' && b.kind === 'rect') {
    assert.ok(near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h), `${msg} rect geom`);
    assert.equal(a.fill, b.fill, `${msg} fill`);
    assert.equal(a.stroke, b.stroke, `${msg} stroke`);
  } else if (a.kind === 'line' && b.kind === 'line') {
    assert.ok(near(a.x1, b.x1) && near(a.y1, b.y1) && near(a.x2, b.x2) && near(a.y2, b.y2), `${msg} line geom`);
  } else if (a.kind === 'text' && b.kind === 'text') {
    assert.equal(a.text, b.text, `${msg} text`);
    assert.equal(a.align, b.align, `${msg} align`);
    assert.ok(near(a.ax, b.ax) && near(a.ay, b.ay), `${msg} text anchor`);
    assert.ok(near(a.x, b.x) && near(a.y, b.y), `${msg} text offset`);
    assert.ok(near(a.fontSize, b.fontSize, 0.05), `${msg} fontSize`);
  }
}

function compareLayer(direct: Scene, parsed: Scene, layer: Layer): void {
  const da = direct.prims.filter((p) => p.layer === layer);
  const db = parsed.prims.filter((p) => p.layer === layer);
  assert.equal(da.length, db.length, `${layer}: prim count (direct ${da.length} vs parsed ${db.length})`);
  for (let i = 0; i < da.length; i++) assertPrimMatch(da[i], db[i], `${layer} #${i}`);
}

test('Phase 3: sceneOut is additive — svg string is unchanged', () => {
  const { svg, svgNoSink } = render();
  assert.equal(svg, svgNoSink);
});

test('Phase 3: direct scene carries canvas/frame/background', () => {
  const { svg, scene } = render();
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
  assert.equal(scene.width, Number(vb[1]));
  assert.equal(scene.height, Number(vb[2]));
  assert.ok(scene.background, 'background captured');
  assert.ok(scene.frame, 'frame captured');
});

test('Phase 3 oracle: every layer the direct emitter produces matches the parser', () => {
  const { svg, scene } = render();
  const parsed = sceneFromSvg(svg);
  const present = new Set(scene.prims.map((p) => p.layer));
  // Foundation must at minimum cover these; parts add stops/stations/transfers.
  for (const required of ['background', 'edges'] as Layer[]) {
    assert.ok(present.has(required), `direct scene should emit ${required}`);
  }
  for (const layer of present) compareLayer(scene, parsed, layer);
});

test('Phase 3: fixture exercises the dynamic layers parts will add', () => {
  const { svg } = render();
  const parsed = sceneFromSvg(svg);
  assert.ok(parsed.prims.some((p) => p.layer === 'stops'), 'fixture has stop markers');
  assert.ok(parsed.prims.some((p) => p.layer === 'stations' && p.kind === 'text'), 'fixture has labels');
});

test('Phase 3: transfers fragment maps to a transfers-layer prim (worldScale false, opacity kept)', () => {
  // The oracle fixture does not coax a rendered transfer (the resolver suppresses
  // it), so pin the transfers PART directly: it feeds the exact fragment
  // renderTransferConnectors emits (transfers.ts) through sceneFromSvg. This locks
  // the layer mapping, worldScale, and that opacity survives.
  const frag =
    '<g class="transfers"><path d="M10.0,10.0L20.0,20.0" fill="none" stroke="#374151" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/></g>';
  const t = sceneFromSvg(frag).prims.filter((p) => p.layer === 'transfers');
  assert.equal(t.length, 1);
  const p = t[0];
  assert.equal(p.kind, 'path');
  assert.equal(p.worldScale, false);
  assert.equal(p.opacity, 0.85);
  if (p.kind === 'path') {
    assert.equal(p.d, 'M10.0,10.0L20.0,20.0');
    assert.equal(p.stroke, '#374151');
    assert.equal(p.fill, 'none');
    assert.ok(Math.abs(p.strokeWidth - 1.4) < 1e-9);
  }
});

test('Phase 3: direct scene covers every drawn layer (final part flips this on)', () => {
  if (!EXPECT_FULL_COVERAGE) return; // enabled by the integration part once complete
  const { svg, scene } = render();
  const parsed = sceneFromSvg(svg);
  const parsedLayers = new Set(parsed.prims.map((p) => p.layer));
  const directLayers = new Set(scene.prims.map((p) => p.layer));
  for (const layer of parsedLayers) {
    assert.ok(directLayers.has(layer), `direct scene missing layer ${layer}`);
    compareLayer(scene, parsed, layer);
  }
});
