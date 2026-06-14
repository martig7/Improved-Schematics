import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringArea, decomposeWaterBodies, keepLargestWaterBodies } from './bodies';
import type { WaterCollection, WaterFeature } from '../render/types';
import type { Coordinate } from '../types/core';

// --- helpers -----------------------------------------------------------------

/** Build a CLOSED axis-aligned rectangle ring (first === last), CCW winding. */
function rect(x0: number, y0: number, x1: number, y1: number): Coordinate[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

/** Same rectangle wound CW (reversed) — for orientation-independence checks. */
function rectCW(x0: number, y0: number, x1: number, y1: number): Coordinate[] {
  return rect(x0, y0, x1, y1).slice().reverse();
}

/** Wrap a list of rings into a single Polygon WaterFeature (even-odd shape). */
function feature(...rings: Coordinate[][]): WaterFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: rings },
  };
}

/** Wrap features into a WaterCollection. */
function collection(...features: WaterFeature[]): WaterCollection {
  return { type: 'FeatureCollection', features };
}

const EPS = 1e-9;

// --- 1. ringArea -------------------------------------------------------------

test('ringArea: unit square = 1', () => {
  assert.ok(Math.abs(ringArea(rect(0, 0, 1, 1)) - 1) < EPS);
});

test('ringArea: 2x3 rectangle = 6', () => {
  assert.ok(Math.abs(ringArea(rect(0, 0, 2, 3)) - 6) < EPS);
});

test('ringArea: orientation-independent (CW vs CCW same magnitude)', () => {
  const ccw = ringArea(rect(0, 0, 2, 3));
  const cw = ringArea(rectCW(0, 0, 2, 3));
  assert.ok(Math.abs(ccw - cw) < EPS);
  assert.ok(Math.abs(cw - 6) < EPS);
});

// --- 2. two disjoint squares -------------------------------------------------

test('decomposeWaterBodies: two disjoint squares -> 2 bodies, correct areas, no holes', () => {
  const a = rect(0, 0, 1, 1); // area 1
  const b = rect(10, 10, 13, 13); // area 9
  const bodies = decomposeWaterBodies(collection(feature(a), feature(b)));
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.equal(body.holes.length, 0);
  const areas = bodies.map((x) => x.area).sort((p, q) => p - q);
  assert.ok(Math.abs(areas[0] - 1) < EPS);
  assert.ok(Math.abs(areas[1] - 9) < EPS);
});

// --- 3. big square with a hole (depth 1) -------------------------------------

test('decomposeWaterBodies: big square with a smaller square hole -> 1 body, 1 hole', () => {
  const outer = rect(0, 0, 10, 10); // area 100
  const hole = rect(3, 3, 6, 6); // area 9, fully inside
  const bodies = decomposeWaterBodies(collection(feature(outer, hole)));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].holes.length, 1);
  assert.ok(Math.abs(bodies[0].area - 100) < EPS);
  assert.ok(Math.abs(ringArea(bodies[0].holes[0]) - 9) < EPS);
});

// --- 4. lake on island (depth 0 / 1 / 2) -------------------------------------

test('decomposeWaterBodies: lake-on-island -> 2 bodies (ocean w/ 1 hole, inner lake w/ 0 holes)', () => {
  const ocean = rect(0, 0, 100, 100); // depth 0, water body, area 10000
  const island = rect(20, 20, 80, 80); // depth 1, land hole of the ocean
  const lake = rect(40, 40, 60, 60); // depth 2, water body inside the island, area 400
  // Single even-odd feature carrying all three nested rings.
  const bodies = decomposeWaterBodies(collection(feature(ocean, island, lake)));
  assert.equal(bodies.length, 2);

  bodies.sort((a, b) => b.area - a.area);
  const [oceanBody, lakeBody] = bodies;

  // Ocean: largest, holds the island as its single hole.
  assert.ok(Math.abs(oceanBody.area - 10000) < EPS);
  assert.equal(oceanBody.holes.length, 1);
  assert.ok(Math.abs(ringArea(oceanBody.holes[0]) - 3600) < EPS); // island 60x60

  // Inner lake: its own body, no holes.
  assert.ok(Math.abs(lakeBody.area - 400) < EPS);
  assert.equal(lakeBody.holes.length, 0);
});

// --- 5. equivalence invariant: single even-odd feature vs multi-feature -------

test('decomposeWaterBodies: one feature [outer,hole] == two features [outer]+[hole]', () => {
  const outer = rect(0, 0, 10, 10);
  const hole = rect(3, 3, 6, 6);

  const single = decomposeWaterBodies(collection(feature(outer, hole)));
  const multi = decomposeWaterBodies(collection(feature(outer), feature(hole)));

  assert.equal(single.length, multi.length);
  assert.equal(single.length, 1);

  const s = single[0];
  const m = multi[0];
  assert.ok(Math.abs(s.area - m.area) < EPS);
  assert.equal(s.holes.length, m.holes.length);
  assert.equal(s.holes.length, 1);
  assert.ok(Math.abs(ringArea(s.holes[0]) - ringArea(m.holes[0])) < EPS);
});

// --- 6. keepLargestWaterBodies: minFracOfLargest -----------------------------

// Three disjoint squares with areas 100, 5, 0.5.
function threeBodyCollection(): WaterCollection {
  const big = rect(0, 0, 10, 10); // area 100
  // 5 = sqrt(5) side; use a rectangle 1 x 5 -> area 5
  const mid = rect(20, 0, 21, 5); // area 5
  // 0.5 = 1 x 0.5 rectangle
  const small = rect(30, 0, 1 + 30, 0.5); // area 0.5
  return collection(feature(big), feature(mid), feature(small));
}

test('keepLargestWaterBodies: minFracOfLargest 0.01 keeps 100 and 5, drops 0.5', () => {
  const w = threeBodyCollection();
  const out = keepLargestWaterBodies(w, { minFracOfLargest: 0.01 });
  const areas = decomposeWaterBodies(out)
    .map((b) => b.area)
    .sort((a, b) => b - a);
  assert.equal(areas.length, 2);
  assert.ok(Math.abs(areas[0] - 100) < EPS);
  assert.ok(Math.abs(areas[1] - 5) < EPS);
});

test('keepLargestWaterBodies: minFracOfLargest 0.1 keeps only 100', () => {
  const w = threeBodyCollection();
  const out = keepLargestWaterBodies(w, { minFracOfLargest: 0.1 });
  const areas = decomposeWaterBodies(out).map((b) => b.area);
  assert.equal(areas.length, 1);
  assert.ok(Math.abs(areas[0] - 100) < EPS);
});

// --- 7. keepLargestWaterBodies: maxBodies ------------------------------------

test('keepLargestWaterBodies: maxBodies 1 keeps only the largest', () => {
  const w = threeBodyCollection();
  const out = keepLargestWaterBodies(w, { maxBodies: 1 });
  const bodies = decomposeWaterBodies(out);
  assert.equal(bodies.length, 1);
  assert.ok(Math.abs(bodies[0].area - 100) < EPS);
});

test('keepLargestWaterBodies: maxBodies 2 keeps the two largest', () => {
  const w = threeBodyCollection();
  const out = keepLargestWaterBodies(w, { maxBodies: 2 });
  const areas = decomposeWaterBodies(out)
    .map((b) => b.area)
    .sort((a, b) => b - a);
  assert.equal(areas.length, 2);
  assert.ok(Math.abs(areas[0] - 100) < EPS);
  assert.ok(Math.abs(areas[1] - 5) < EPS);
});

// --- 8. empty collection -----------------------------------------------------

test('empty collection: decompose -> [] and keepLargest -> empty collection', () => {
  const empty = collection();
  assert.deepEqual(decomposeWaterBodies(empty), []);

  // With an active spec there are no bodies; the function returns the input,
  // which is itself an empty collection (features.length 0).
  const out = keepLargestWaterBodies(empty, { maxBodies: 1 });
  assert.equal(out.type, 'FeatureCollection');
  assert.equal(out.features.length, 0);
});

// --- 9. empty spec returns input unchanged -----------------------------------

test('keepLargestWaterBodies: empty spec ({}) returns the input unchanged', () => {
  const w = threeBodyCollection();
  const out = keepLargestWaterBodies(w, {});
  assert.equal(out, w); // identity: same object reference
  assert.equal(out.features.length, 3);
});

// --- 10. idempotence ---------------------------------------------------------

test('keepLargestWaterBodies: applying twice == applying once', () => {
  const w = threeBodyCollection();
  const spec = { minFracOfLargest: 0.01 };
  const once = keepLargestWaterBodies(w, spec);
  const twice = keepLargestWaterBodies(once, spec);

  const a1 = decomposeWaterBodies(once)
    .map((b) => b.area)
    .sort((a, b) => a - b);
  const a2 = decomposeWaterBodies(twice)
    .map((b) => b.area)
    .sort((a, b) => a - b);
  assert.equal(a1.length, a2.length);
  for (let i = 0; i < a1.length; i++) assert.ok(Math.abs(a1[i] - a2[i]) < EPS);
});

// --- 10b. on-boundary hole vertex (pinch point) stays a hole -----------------

test('decomposeWaterBodies: a hole touching the outer boundary at a vertex is still a hole', () => {
  // Land hole whose FIRST vertex [40,100] sits exactly on the ocean's top edge
  // (a marching-squares pinch corner). A single-vertex ray-cast is unstable on
  // that edge; the majority-of-samples vote must still classify it as a hole,
  // not as its own water body (which the keep threshold could then drop,
  // leaking the hole so land fills as water).
  const ocean = rect(0, 0, 100, 100); // area 10000
  const hole: Coordinate[] = [
    [40, 100], // on the ocean's top edge
    [20, 80],
    [60, 80],
    [40, 100],
  ];
  const bodies = decomposeWaterBodies(collection(feature(ocean, hole)));
  assert.equal(bodies.length, 1); // NOT 2 — the touching triangle is a hole
  assert.equal(bodies[0].holes.length, 1);

  // And it survives the keep filter attached to its parent (no land-as-water).
  const out = keepLargestWaterBodies(collection(feature(ocean, hole)), {
    minFracOfLargest: 0.01,
  });
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0].geometry.coordinates.length, 2); // [outer, hole]
});

// --- 11. kept bodies retain their holes --------------------------------------

test('keepLargestWaterBodies: kept big-with-hole body still has its hole', () => {
  const outer = rect(0, 0, 100, 100); // area 10000
  const hole = rect(30, 30, 60, 60); // land hole, area 900
  const big = feature(outer, hole);
  const tiny = feature(rect(200, 200, 201, 201)); // area 1, droppable

  const w = collection(big, tiny);
  const out = keepLargestWaterBodies(w, { minFracOfLargest: 0.5 });

  // Only the big body survives.
  assert.equal(out.features.length, 1);
  const coords = out.features[0].geometry.coordinates;
  assert.equal(coords.length, 2); // [outer, hole]
  assert.ok(Math.abs(ringArea(coords[0]) - 10000) < EPS); // outer footprint
  assert.ok(Math.abs(ringArea(coords[1]) - 900) < EPS); // hole preserved

  // And decomposition agrees: one body, one hole.
  const bodies = decomposeWaterBodies(out);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].holes.length, 1);
});
