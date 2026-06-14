import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSchematicSVG,
  precomputeSmoothedSchematic,
  drawSmoothedSchematic,
} from './schematic';
import type { RenderMode } from './types';

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
