import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeMap, deserializeMap, type MapBundle } from '../persist';

// A saved map FILE must mirror everything the localStorage cache holds, so a load can
// reseed the cache and behave exactly like a cache hit. These assert the new fields
// (fp, subs, modeSettings) and the debug `inputDump` round-trip through serialize/
// deserialize. `pre` is exercised in its string form (the smoothed draw never needs the
// object on restore); the heavy object path is covered by mapCache's pre tests.

const baseBundle = (): MapBundle => ({
  version: 1,
  city: 'nyc',
  settings: { mode: 'smoothed', showStations: true },
  selections: [{ id: 'sel-0', box: { x0: 1, y0: 2, x1: 3, y1: 4 }, color: '#22d3ee', name: 'A' }],
  modeSettings: { smoothed: { showLabels: true }, geographic: { showLabels: false } },
  fp: 'v3:abc123',
  subs: {
    '1,2,3,4': { pre: '{"pre":"<svg/>","unproj":null}', selFrame: { x: 0, y: 0, w: 10, h: 10 } },
  },
  pre: '<svg>main</svg>',
  inputDump: { at: '2026-06-24', areas: [{ id: 'sel-0', input: { routes: [] } }] },
});

test('persist: serializeMap → deserializeMap round-trips the cache-mirror fields', () => {
  const out = deserializeMap(serializeMap(baseBundle()));
  assert.equal(out.version, 1);
  assert.equal(out.city, 'nyc');
  assert.equal(out.fp, 'v3:abc123');
  assert.deepEqual(out.subs, baseBundle().subs);
  assert.deepEqual(out.modeSettings, baseBundle().modeSettings);
  assert.deepEqual(out.selections, baseBundle().selections);
  assert.equal(out.pre, '<svg>main</svg>');
});

test('persist: the debug inputDump survives the round-trip (it is ignored on load, not dropped)', () => {
  const out = deserializeMap(serializeMap(baseBundle()));
  assert.deepEqual(out.inputDump, baseBundle().inputDump);
});

test('persist: a legacy bundle without the new fields still loads', () => {
  const legacy = JSON.stringify({ version: 1, city: 'chi', settings: {}, pre: '<svg/>' });
  const out = deserializeMap(legacy);
  assert.equal(out.city, 'chi');
  assert.equal(out.fp, undefined);
  assert.equal(out.subs, undefined);
});

test('persist: deserializeMap rejects a non-map file', () => {
  assert.throws(() => deserializeMap('{"hello":"world"}'));
  assert.throws(() => deserializeMap('not json'));
});

test('persist: a restored pre carries a project() that inverts its unproject', () => {
  // A synthetic separable projection: lng [10,20] -> x [0,W] (increasing),
  // lat [40,50] -> y [H,0] (decreasing; north at the top), matching the real
  // warped projection's monotonicity so the sampled tables reconstruct exactly.
  const W = 1000, H = 800;
  const unproject = ([x, y]: [number, number]): [number, number] => [10 + (x / W) * 10, 50 - (y / H) * 10];
  const bundle = { ...baseBundle(), pre: { width: W, height: H, unproject } as never };
  const out = deserializeMap(serializeMap(bundle));
  const pre = out.pre as unknown as { project: (c: [number, number]) => [number, number]; unproject: (p: [number, number]) => [number, number] };
  assert.equal(typeof pre.project, 'function');
  // Forward matches the true projection (linear map → exact table interpolation).
  const p = pre.project([15, 45]);
  assert.ok(Math.abs(p[0] - 500) < 1e-6 && Math.abs(p[1] - 400) < 1e-6, `project([15,45]) ≈ [500,400], got ${p}`);
  // Round-trips both ways.
  for (const c of [[12, 42], [15, 45], [18, 48]] as [number, number][]) {
    const back = pre.unproject(pre.project(c));
    assert.ok(Math.abs(back[0] - c[0]) < 1e-6 && Math.abs(back[1] - c[1]) < 1e-6, `round-trip ${c} → ${back}`);
  }
});
