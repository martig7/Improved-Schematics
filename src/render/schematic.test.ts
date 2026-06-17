import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSchematicSVG,
  precomputeSmoothedSchematic,
  drawSmoothedSchematic,
} from './schematic';
import type { RenderMode } from './types';
import type { GeographyData } from '../geography/types';
import { geographyFrame } from './renderGeographic';
import { createProjection } from './projection';

const SAMPLE = {
  stations: [
    { id: 's1', name: 'A', coords: [-122.0, 47.0], trackIds: ['t1'], trackGroupId: 'g1',
      buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
    { id: 's2', name: 'B', coords: [-122.05, 47.02], trackIds: ['t2'], trackGroupId: 'g2',
      buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
    { id: 's3', name: 'C', coords: [-122.1, 47.0], trackIds: ['t3'], trackGroupId: 'g3',
      buildType: 'constructed', stNodeIds: ['n3'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  ],
  tracks: [
    { id: 't1', coords: [[-122.0, 47.0], [-122.05, 47.02]] },
    { id: 't2', coords: [[-122.05, 47.02], [-122.1, 47.0]] },
  ],
  routes: [
    {
      id: 'r1', bullet: '1', color: '#cc0000', stComboTimings: [],
      stCombos: [
        { startStNodeId: 'n1', endStNodeId: 'n2', path: [{ trackId: 't1', reversed: false }], distance: 1 },
        { startStNodeId: 'n2', endStNodeId: 'n3', path: [{ trackId: 't2', reversed: false }], distance: 1 },
      ],
    },
  ],
};

test('empty network yields the empty-state svg in every mode', () => {
  for (const mode of ['geographic', 'smoothed', 'schematic'] as RenderMode[]) {
    const svg = generateSchematicSVG({ routes: [], tracks: [], stations: [], options: { mode } });
    assert.match(svg, /^<svg/);
    assert.match(svg, /Build at least one route/);
  }
});

const GEO: GeographyData = {
  bbox: [-3.05, 53.34, -2.83, 53.47],
  water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-3.0, 53.35], [-2.9, 53.35], [-2.9, 53.45], [-3.0, 53.35]]] } }],
  green: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-2.95, 53.4], [-2.93, 53.4], [-2.93, 53.42], [-2.95, 53.4]]] } }],
};

test('renders the geography backdrop with no routes built yet', () => {
  const svg = generateSchematicSVG({ routes: [], tracks: [], stations: [], geography: GEO, options: { mode: 'geographic' } });
  assert.doesNotMatch(svg, /Build at least one route/, 'not the empty-state prompt');
  assert.ok(svg.includes('#a8d4e6') || svg.includes('#cfe6c3'), 'has water or park fill');
});

test('still shows the prompt when there are no routes and no geography', () => {
  const svg = generateSchematicSVG({ routes: [], tracks: [], stations: [], options: { mode: 'geographic' } });
  assert.match(svg, /Build at least one route/);
});

test('each mode returns a well-formed svg for a small network', () => {
  const stations = [
    { id: 's1', name: 'A', coords: [-122.0, 47.0], trackIds: ['t1'], trackGroupId: 'g1',
      buildType: 'constructed', stNodeIds: ['n1'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
    { id: 's2', name: 'B', coords: [-122.05, 47.02], trackIds: ['t2'], trackGroupId: 'g2',
      buildType: 'constructed', stNodeIds: ['n2'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
    { id: 's3', name: 'C', coords: [-122.1, 47.0], trackIds: ['t3'], trackGroupId: 'g3',
      buildType: 'constructed', stNodeIds: ['n3'], routeIds: ['r1'], createdAt: 0, nearbyStations: [] },
  ];
  const tracks = [
    { id: 't1', coords: [[-122.0, 47.0], [-122.05, 47.02]] },
    { id: 't2', coords: [[-122.05, 47.02], [-122.1, 47.0]] },
  ];
  const routes = [
    {
      id: 'r1',
      bullet: '1',
      color: '#cc0000',
      stComboTimings: [],
      stCombos: [
        { startStNodeId: 'n1', endStNodeId: 'n2', path: [{ trackId: 't1', reversed: false }], distance: 1 },
        { startStNodeId: 'n2', endStNodeId: 'n3', path: [{ trackId: 't2', reversed: false }], distance: 1 },
      ],
    },
  ];

  for (const mode of ['geographic', 'smoothed', 'schematic'] as RenderMode[]) {
    const svg = generateSchematicSVG({
      routes: routes as never,
      tracks: tracks as never,
      stations: stations as never,
      options: { mode, showLabels: true, width: 600, height: 600 },
    });
    assert.match(svg, /^<svg/, `mode ${mode} should produce svg`);
    assert.match(svg, /<\/svg>$/, `mode ${mode} should close svg`);
  }
});

test('geographic mode emits a data-frame for the geography extent, within the canvas', () => {
  const W = 600, H = 600;
  // Geography near the sample network, so it projects to a sensible inner rect.
  const geo = {
    bbox: [-122.12, 46.98, -121.98, 47.04],
    water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-122.1, 47.0], [-122.05, 47.0], [-122.05, 47.03], [-122.1, 47.03], [-122.1, 47.0]]] } }],
    green: [],
  } as GeographyData;
  const svg = generateSchematicSVG({
    routes: SAMPLE.routes as never,
    tracks: SAMPLE.tracks as never,
    stations: SAMPLE.stations as never,
    geography: geo,
    options: { mode: 'geographic', width: W, height: H },
  });
  const m = svg.match(/data-frame="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
  assert.ok(m, 'geographic svg should carry a data-frame attribute');
  const [x, y, w, h] = m!.slice(1).map(Number);
  assert.ok(w > 0 && h > 0, 'frame has positive size');
  assert.ok(x >= 0 && y >= 0 && x + w <= W && y + h <= H, 'frame stays inside the canvas');
});

test('geographyFrame frames the furthest water OR green vertex (union)', () => {
  // Equator proj (k=1): toSVG([lng,lat]) = [100+(lng+5)*80, 900-(lat+5)*80].
  const proj = createProjection([-5, -5, 5, 5], 1000, 1000, 0.1);
  const geo = {
    bbox: [-5, -5, 5, 5],
    // water spans [-2.5,-2.5]..[2.5,2.5] → pixels x[300,700] y[300,700].
    water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-2.5, -2.5], [2.5, 2.5]]] } }],
    // a single green vertex further east at x=820 must widen the frame to it.
    green: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[4, 0]]] } }],
  } as GeographyData;
  assert.deepEqual(geographyFrame(geo, proj), { x: 300, y: 300, w: 520, h: 400 });
});

test('geographyFrame is null when there is no geography', () => {
  const proj = createProjection([-5, -5, 5, 5], 1000, 1000, 0.1);
  assert.equal(geographyFrame(undefined, proj), null);
});

test('smoothed and schematic modes emit a content data-frame within the canvas', () => {
  // Octi-based modes have no geographic demand bbox to project, so they frame on
  // the rendered network's pixel extent instead — fit/export hug the map, not
  // the padded canvas.
  for (const mode of ['smoothed', 'schematic'] as RenderMode[]) {
    const svg = generateSchematicSVG({
      routes: SAMPLE.routes as never,
      tracks: SAMPLE.tracks as never,
      stations: SAMPLE.stations as never,
      options: { mode, width: 600, height: 600 },
    });
    const m = svg.match(/data-frame="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
    assert.ok(m, `${mode} svg should carry a content data-frame`);
    const [x, y, w, h] = m!.slice(1).map(Number);
    // The renderer sets its own viewBox (octi sizes to content); frame must sit
    // inside it.
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const VBW = Number(vb![1]);
    const VBH = Number(vb![2]);
    assert.ok(w > 0 && h > 0, `${mode} frame has positive size`);
    assert.ok(
      x >= 0 && y >= 0 && x + w <= VBW + 0.5 && y + h <= VBH + 0.5,
      `${mode} frame stays inside the viewBox`,
    );
  }
});

test('geographic mode omits data-frame when there is no geography', () => {
  const svg = generateSchematicSVG({
    routes: SAMPLE.routes as never,
    tracks: SAMPLE.tracks as never,
    stations: SAMPLE.stations as never,
    options: { mode: 'geographic', width: 600, height: 600 },
  });
  assert.doesNotMatch(svg, /data-frame=/, 'no geography → no frame, falls back to full canvas');
});

test('two-phase smoothed render matches the single-phase output', () => {
  const options = { mode: 'smoothed' as RenderMode, showLabels: true, width: 600, height: 600 };
  const oneShot = generateSchematicSVG({
    routes: SAMPLE.routes as never,
    tracks: SAMPLE.tracks as never,
    stations: SAMPLE.stations as never,
    options,
  });
  const pre = precomputeSmoothedSchematic({
    routes: SAMPLE.routes as never,
    tracks: SAMPLE.tracks as never,
    stations: SAMPLE.stations as never,
    options,
  });
  assert.notEqual(typeof pre, 'string', 'small network should precompute a layout, not fall back');
  const twoPhase = typeof pre === 'string' ? pre : drawSmoothedSchematic(pre, options);
  assert.equal(twoPhase, oneShot, 'precompute+draw must equal generateSchematicSVG');
});

test('redrawing a cached layout is stable (no mutation across toggles)', () => {
  const pre = precomputeSmoothedSchematic({
    routes: SAMPLE.routes as never,
    tracks: SAMPLE.tracks as never,
    stations: SAMPLE.stations as never,
    options: { mode: 'smoothed', width: 600, height: 600 },
  });
  assert.notEqual(typeof pre, 'string');
  if (typeof pre === 'string') return;
  // Toggle labels on, off, on again from the SAME cached layout. Each draw must
  // depend only on its own args — the first draw must not corrupt the layout.
  const withLabels = drawSmoothedSchematic(pre, { showLabels: true });
  const noLabels = drawSmoothedSchematic(pre, { showLabels: false });
  const withLabelsAgain = drawSmoothedSchematic(pre, { showLabels: true });
  assert.equal(withLabels, withLabelsAgain, 'redraw with same options must be identical');
  assert.notEqual(withLabels, noLabels, 'label toggle must actually change the output');
});
