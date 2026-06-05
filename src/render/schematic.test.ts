import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchematicSVG } from './schematic';
import type { RenderMode } from './types';

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
