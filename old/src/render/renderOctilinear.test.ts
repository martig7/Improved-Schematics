import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOctilinear } from './renderOctilinear';
import { octilinearLayout } from './layout/octilinear';
import { simplifyLayout } from './layout/simplify';
import { orderLines } from './layout/lineOrder';
import { lineGraph } from './layout/_fixtures';
import type { WaterCollection } from './types';

function laidOut() {
  const graph = lineGraph([
    [0, 0],
    [100, 30],
    [200, 5],
    [300, 70],
  ]);
  let layout = octilinearLayout(graph);
  layout = simplifyLayout(layout, graph);
  orderLines(layout);
  return layout;
}

test('renderOctilinear returns a self-contained svg', () => {
  const svg = renderOctilinear(laidOut(), { dark: false, showLabels: true });
  assert.match(svg, /^<svg[\s>]/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /data-line-id="L1"/);
});

test('renderOctilinear includes a water backdrop when water is supplied', () => {
  const water = {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]],
        },
      },
    ],
  } as unknown as WaterCollection;
  const svg = renderOctilinear(laidOut(), { water });
  assert.match(svg, /class="water"/);
});

test('renderOctilinear omits labels when showLabels is false', () => {
  // stations toggle off too: stop-dot name bullets are also <text> elements
  const svg = renderOctilinear(laidOut(), { showLabels: false, showStations: false });
  assert.doesNotMatch(svg, /<text /);
});
