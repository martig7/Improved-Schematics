// The geometry-on-pre cache: drawSmoothed computes the expensive toggle-independent
// ribbon geometry (lane bundles + marker placement) ONCE, memoizes it on `pre`, and
// serializes it with the precompute. A draw from a restored pre must skip the solver
// and reproduce byte-identical svg + Scene. Guards the cache-read perf win
// (docs/cache-read-perf.md) against future renderRibbons changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precomputeSmoothed, drawSmoothed } from '../renderGeographic';
import { serializePre, deserializePre } from '../persist';
import type { SmoothedPrecomputed } from '../schematic';
import type { SceneOut } from '../renderOctilinear';
import type { GeographyData } from '../../geography/types';
import { BADGE_R as DC_BADGE_R } from '../layout/dcStations';

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

function fresh(): SmoothedPrecomputed {
  const pre = precomputeSmoothed({
    routes: ROUTES as never,
    tracks: TRACKS as never,
    stations: STATIONS as never,
    geography: GEO,
    options: { mode: 'smoothed', showLabels: true, showStations: true, width: 600, height: 600 },
  });
  assert.notEqual(typeof pre, 'string', 'fixture must precompute a real layout');
  if (typeof pre === 'string') throw new Error('unreachable');
  return pre;
}
const opts = { showLabels: true, showStations: true };

test('precompute is geometry-free; first draw memoizes it on pre', () => {
  const pre = fresh();
  assert.equal(pre.geometry, undefined, 'precompute does not eagerly build geometry');
  drawSmoothed(pre, opts);
  assert.ok(pre.geometry, 'first draw memoizes geometry on pre');
  for (const marks of pre.geometry.stopsByNode.values()) {
    for (const mark of marks) assert.ok(mark.flagNode, `stop ${mark.lineId} retains its route flag node`);
  }
});

test('serialized geometry round-trips; restored draw is byte-identical (svg + scene)', () => {
  const pre = fresh();
  const out1: SceneOut = { scene: null };
  const svg1 = drawSmoothed(pre, opts, out1); // memoizes geometry
  assert.ok(pre.geometry, 'geometry memoized before serialize');

  const restored = deserializePre(serializePre(pre));
  assert.notEqual(typeof restored, 'string');
  if (typeof restored === 'string') throw new Error('unreachable');
  assert.ok(restored.geometry, 'geometry survives serialize/deserialize');

  const out2: SceneOut = { scene: null };
  const svg2 = drawSmoothed(restored, opts, out2);
  assert.equal(svg2, svg1, 'restored draw produces identical svg (placement reused, not recomputed)');
  assert.deepEqual(out2.scene, out1.scene, 'restored draw produces identical Scene IR');
});

test('memoized geometry is reused across toggle changes (same object, not recomputed)', () => {
  const pre = fresh();
  drawSmoothed(pre, { showLabels: false, showStations: false });
  const g = pre.geometry;
  assert.ok(g);
  drawSmoothed(pre, { showLabels: true, showStations: true });
  assert.equal(pre.geometry, g, 'toggles reuse the same geometry object');
});

test('simplified lines paint below every regular line in SVG and Scene IR', () => {
  const pre = fresh();
  drawSmoothed(pre, opts);

  const geometry = pre.geometry!;
  geometry.paintGroups = [['r2'], ['r1']];

  const out: SceneOut = { scene: null };
  const svg = drawSmoothed(pre, { ...opts, simplifiedRoutes: { r1: 'default' } }, out);
  const lineIds = [...svg.matchAll(/data-line-id="([^"]+)"/g)].map((match) => match[1]);
  const simplifiedSvgIndex = lineIds.indexOf('r1');
  const regularSvgIndex = lineIds.indexOf('r2');
  assert.ok(simplifiedSvgIndex >= 0 && regularSvgIndex >= 0, 'fixture paints both SVG lines');
  assert.ok(simplifiedSvgIndex < regularSvgIndex, 'simplified SVG line paints first');

  assert.ok(out.scene, 'draw produces Scene IR');
  const edgePrims = out.scene.prims.filter((prim) => prim.layer === 'edges');
  const simplifiedSceneIndex = edgePrims.findIndex(
    (prim) => prim.kind === 'path' && prim.stroke === '#cc0000',
  );
  const regularSceneIndex = edgePrims.findIndex(
    (prim) => prim.kind === 'path' && prim.stroke === '#0000cc',
  );
  assert.ok(simplifiedSceneIndex >= 0 && regularSceneIndex >= 0, 'fixture paints both Scene IR lines');
  assert.ok(simplifiedSceneIndex < regularSceneIndex, 'simplified Scene IR line paints first');
});

test('DC Metro omits tails and route badges for simplified lines', () => {
  const pre = fresh();
  const redBadge = new RegExp(`<circle[^>]*r="${DC_BADGE_R.toFixed(1)}"[^>]*fill="#cc0000"`);
  const blueBadge = new RegExp(`<circle[^>]*r="${DC_BADGE_R.toFixed(1)}"[^>]*fill="#0000cc"`);
  const baselineSvg = drawSmoothed(pre, { ...opts, stationDesign: 'dc' });
  assert.match(baselineSvg, /<line[^>]*stroke="#cc0000"/, 'fixture gives the simplified route a DC tail');
  assert.match(baselineSvg, redBadge, 'fixture gives the simplified route a DC badge');

  const out: SceneOut = { scene: null };
  const svg = drawSmoothed(
    pre,
    { ...opts, stationDesign: 'dc', simplifiedRoutes: { r1: 'default' } },
    out,
  );

  assert.doesNotMatch(svg, /<line[^>]*stroke="#cc0000"/, 'simplified route has no SVG tail');
  assert.doesNotMatch(
    svg,
    redBadge,
    'simplified route has no SVG badge',
  );
  assert.match(svg, /data-line="r1"/, 'simplified route keeps its terminus station marker');
  assert.match(svg, /<line[^>]*stroke="#0000cc"/, 'regular route keeps its SVG tail');
  assert.match(svg, blueBadge, 'regular route keeps its SVG badge');

  assert.ok(out.scene, 'draw produces Scene IR');
  const stopPrims = out.scene.prims.filter((prim) => prim.layer === 'stops');
  assert.equal(
    stopPrims.some((prim) => prim.kind === 'line' && prim.stroke === '#cc0000'),
    false,
    'simplified route has no Scene IR tail',
  );
  assert.equal(
    stopPrims.some((prim) => prim.kind === 'circle' && prim.r === +DC_BADGE_R.toFixed(1) && prim.fill === '#cc0000'),
    false,
    'simplified route has no Scene IR badge',
  );
  assert.ok(
    stopPrims.some((prim) => prim.kind === 'line' && prim.stroke === '#0000cc'),
    'regular route keeps its Scene IR tail',
  );
  assert.ok(
    stopPrims.some((prim) => prim.kind === 'circle' && prim.r === +DC_BADGE_R.toFixed(1) && prim.fill === '#0000cc'),
    'regular route keeps its Scene IR badge',
  );
});

test('Paris design paints computed bubbles, endpoint fills, and route-end glyphs', () => {
  const pre = fresh();
  const out: SceneOut = { scene: null };
  const svg = drawSmoothed(pre, { ...opts, stationDesign: 'paris' }, out);
  assert.ok(pre.geometry?.parisByNode && pre.geometry.parisByNode.size > 0, 'Paris geometry is memoized');
  assert.match(svg, /<circle[^>]*fill="#ffffff"/, 'white interchange or endpoint bubble');
  assert.match(svg, /<line[^>]*stroke="#cc0000"/, 'route-end tail');
  assert.ok(out.scene, 'draw produces Scene IR');
  const stopPrims = out.scene.prims.filter((prim) => prim.layer === 'stops');
  assert.ok(stopPrims.some((prim) => prim.kind === 'circle' && prim.fill === '#ffffff'), 'Scene IR white bubble');
  assert.ok(stopPrims.some((prim) => prim.kind === 'line' && prim.stroke === '#cc0000'), 'Scene IR route-end tail');
  assert.ok(stopPrims.some((prim) => prim.kind === 'text' && prim.text === '1'), 'Scene IR route-end badge');
});

test('Paris omits tails and route badges for simplified lines', () => {
  const pre = fresh();
  const redBadge = new RegExp(`<circle[^>]*r="${DC_BADGE_R.toFixed(1)}"[^>]*fill="#cc0000"`);
  const blueBadge = new RegExp(`<circle[^>]*r="${DC_BADGE_R.toFixed(1)}"[^>]*fill="#0000cc"`);
  const baselineSvg = drawSmoothed(pre, { ...opts, stationDesign: 'paris' });
  assert.match(baselineSvg, /<line[^>]*stroke="#cc0000"/, 'fixture gives the simplified route a Paris tail');
  assert.match(baselineSvg, redBadge, 'fixture gives the simplified route a Paris badge');

  const out: SceneOut = { scene: null };
  const svg = drawSmoothed(
    pre,
    { ...opts, stationDesign: 'paris', simplifiedRoutes: { r1: 'default' } },
    out,
  );

  assert.doesNotMatch(svg, /<line[^>]*stroke="#cc0000"/, 'simplified route has no SVG tail');
  assert.doesNotMatch(svg, redBadge, 'simplified route has no SVG badge');
  assert.doesNotMatch(svg, />1<\/text>/, 'simplified route has no SVG route glyph');
  assert.match(svg, /<circle[^>]*fill="#cc0000"/, 'simplified route keeps its Paris station fill');
  assert.match(svg, /<line[^>]*stroke="#0000cc"/, 'regular route keeps its SVG tail');
  assert.match(svg, blueBadge, 'regular route keeps its SVG badge');
  assert.match(svg, />2<\/text>/, 'regular route keeps its SVG route glyph');

  assert.ok(out.scene, 'draw produces Scene IR');
  const stopPrims = out.scene.prims.filter((prim) => prim.layer === 'stops');
  assert.equal(
    stopPrims.some((prim) => prim.kind === 'line' && prim.stroke === '#cc0000'),
    false,
    'simplified route has no Scene IR tail',
  );
  assert.equal(
    stopPrims.some((prim) => prim.kind === 'circle' && prim.r === +DC_BADGE_R.toFixed(1) && prim.fill === '#cc0000'),
    false,
    'simplified route has no Scene IR badge',
  );
  assert.equal(
    stopPrims.some((prim) => prim.kind === 'text' && prim.text === '1'),
    false,
    'simplified route has no Scene IR route glyph',
  );
  assert.ok(
    stopPrims.some((prim) => prim.kind === 'circle' && prim.fill === '#cc0000'),
    'simplified route keeps its Scene IR Paris station fill',
  );
  assert.ok(
    stopPrims.some((prim) => prim.kind === 'line' && prim.stroke === '#0000cc'),
    'regular route keeps its Scene IR tail',
  );
  assert.ok(
    stopPrims.some((prim) => prim.kind === 'circle' && prim.r === +DC_BADGE_R.toFixed(1) && prim.fill === '#0000cc'),
    'regular route keeps its Scene IR badge',
  );
  assert.ok(
    stopPrims.some((prim) => prim.kind === 'text' && prim.text === '2'),
    'regular route keeps its Scene IR route glyph',
  );
});

// The three rectangle-capsule geometry fields (seated capsules, rescued single
// positions, cropped lanes) were added to the serialized geometry in separate
// steps, so a pre serialized in between can carry the capsules WITHOUT the cropped
// lanes. Drawing the rectangle design from such a partial geometry must degrade the
// whole group together (plain fallback), not seat opaque boxes over uncropped lanes.
test('a geometry missing the cropped lanes degrades the whole rectangle group', () => {
  const pre = fresh();
  const rectOpts = { showLabels: true, showStations: true, stationDesign: 'tokyu' };

  // First draw memoizes the full geometry (all three rectangle fields present).
  const svgRect = drawSmoothed(pre, rectOpts);
  const g = pre.geometry!;
  assert.ok(g.rectByNode && g.rectByNode.size > 0, 'fixture must seat at least one rectangle capsule');
  assert.ok((g.croppedLaneByLine?.get('rectRows')?.size ?? 0) > 0, 'fixture must crop at least one lane');

  const rectMap = g.rectByNode;
  const stopMap = g.tokyuStopPos;
  const laneMap = g.croppedLaneByLine;

  // Full fallback: none of the three rectangle fields present, so the rectangle
  // design paints its plain capsules over uncropped lanes.
  g.rectByNode = undefined;
  g.tokyuStopPos = undefined;
  g.croppedLaneByLine = undefined;
  const svgFallback = drawSmoothed(pre, rectOpts);

  // The full rectangle draw really differs from the fallback, so the assertion
  // below is not vacuous.
  assert.notEqual(svgRect, svgFallback, 'rectangle geometry must change the drawn output');

  // Degraded cache: capsules and single positions present, cropped lanes absent.
  // Because the group degrades together, this must equal the full fallback,
  // never seat boxes over uncropped lanes.
  g.rectByNode = rectMap;
  g.tokyuStopPos = stopMap;
  g.croppedLaneByLine = undefined;
  const svgDegraded = drawSmoothed(pre, rectOpts);
  assert.equal(svgDegraded, svgFallback, 'a geometry missing the cropped lanes must fully fall back');

  g.croppedLaneByLine = laneMap; // restore the memoized geometry
});
