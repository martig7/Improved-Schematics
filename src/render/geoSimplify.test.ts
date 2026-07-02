import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringArea, simplifyVW, snapOcti, filletPathD, stylizeRingsPathD, unionRings, type Pt } from './geoSimplify';

const EXT = { w: 400, h: 400 };
/** Parse every coordinate pair out of a path d-string. */
const pathPts = (d: string): Pt[] =>
  [...d.matchAll(/[-\d.]+ [-\d.]+/g)].map((m) => m[0].split(' ').map(Number) as Pt);
const bboxOf = (pts: Pt[]): [number, number, number, number] => [
  Math.min(...pts.map((p) => p[0])),
  Math.min(...pts.map((p) => p[1])),
  Math.max(...pts.map((p) => p[0])),
  Math.max(...pts.map((p) => p[1])),
];

const SQUARE: Pt[] = [[0, 0], [100, 0], [100, 100], [0, 100]];

test('ringArea: 100x100 square has |area| 10000', () => {
  assert.equal(Math.abs(ringArea(SQUARE)), 10000);
});

test('simplifyVW: drops a tiny wiggle, keeps the silhouette', () => {
  // square with a 2px-deep notch on the top edge (effective area ~ few px²)
  const ring: Pt[] = [[0, 0], [48, 0], [50, 2], [52, 0], [100, 0], [100, 100], [0, 100]];
  const out = simplifyVW(ring, 100); // threshold 10px-scale wiggles
  assert.equal(out.length, 4, `expected the square back, got ${JSON.stringify(out)}`);
  assert.deepEqual(out, [[0, 0], [100, 0], [100, 100], [0, 100]]);
});

test('simplifyVW: keeps everything when threshold is 0', () => {
  const ring: Pt[] = [[0, 0], [48, 0], [50, 2], [52, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(simplifyVW(ring, 0).length, ring.length);
});

test('simplifyVW: never goes below minVerts', () => {
  const out = simplifyVW(SQUARE, 1e9, 4);
  assert.equal(out.length, 4);
});

test('snapOcti: an already-octilinear ring stays put (closure preserved)', () => {
  const out = snapOcti(SQUARE);
  assert.equal(out.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(out[i][0] - SQUARE[i][0]) < 1e-6 && Math.abs(out[i][1] - SQUARE[i][1]) < 1e-6);
  }
});

test('snapOcti: near-axis edges snap to the axis and the ring closes', () => {
  // slightly sheared square: edges within ~6° of the axes
  const ring: Pt[] = [[0, 0], [100, 10], [90, 110], [-10, 100]];
  const out = snapOcti(ring);
  assert.ok(out.length >= 3);
  // every edge direction is a 45° multiple within the closure-shear tolerance
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const m = ((ang % 45) + 45) % 45;
    const off = Math.min(m, 45 - m);
    assert.ok(off < 8, `edge ${i} is ${off.toFixed(1)}° off the octilinear grid`);
  }
});

test('filletPathD: r=0 emits the plain closed polygon', () => {
  const d = filletPathD(SQUARE, 0);
  assert.match(d, /^M0 0 L100 0 L100 100 L0 100 Z $/);
});

test('filletPathD: rounds every corner with a Q through the corner point', () => {
  const d = filletPathD(SQUARE, 10);
  const qs = d.match(/Q/g) ?? [];
  assert.equal(qs.length, 4);
  assert.match(d, /Q100 0 /); // the corner itself is the control point
  assert.match(d, /L90 0 Q100 0 100 10/); // entry 10px before, exit 10px after
  assert.match(d, /Z $/);
});

test('filletPathD: radius clamps to half the shortest adjacent segment', () => {
  const thin: Pt[] = [[0, 0], [10, 0], [10, 100], [0, 100]]; // 10px top/bottom edges
  const d = filletPathD(thin, 40);
  assert.match(d, /L5 0 Q10 0 10 5/); // clamped to 5 (= 10/2), not 40
});

test('unionRings: two overlapping squares trace as ONE blob', () => {
  const a: Pt[] = [[20, 20], [120, 20], [120, 120], [20, 120]];
  const b: Pt[] = [[100, 20], [200, 20], [200, 120], [100, 120]];
  const out = unionRings([a, b], EXT, 4);
  assert.equal(out.length, 1, `expected one unified ring, got ${out.length}`);
  const [x0, y0, x1, y1] = bboxOf(out[0]);
  assert.ok(Math.abs(x0 - 20) <= 8 && Math.abs(y0 - 20) <= 8 && Math.abs(x1 - 200) <= 8 && Math.abs(y1 - 120) <= 8,
    `unified bbox off: ${[x0, y0, x1, y1]}`);
});

test('unionRings: a hole survives with opposite winding', () => {
  const outer: Pt[] = [[20, 20], [220, 20], [220, 220], [20, 220]];
  const hole: Pt[] = [[80, 80], [80, 160], [160, 160], [160, 80]]; // reversed winding
  const out = unionRings([outer, hole], EXT, 4);
  assert.equal(out.length, 2, `expected outer + hole, got ${out.length}`);
  const areas = out.map((r) => ringArea(r)).sort((x, y) => Math.abs(y) - Math.abs(x));
  assert.ok(areas[0] * areas[1] < 0, `outer and hole must wind oppositely: ${areas}`);
});

test('stylizeRingsPathD: culls rings below minAreaPx2, keeps big ones', () => {
  const pond: Pt[] = [[300, 300], [330, 300], [330, 330], [300, 330]]; // 900 px²
  const big: Pt[] = [[20, 20], [220, 20], [220, 220], [20, 220]];
  const d = stylizeRingsPathD([pond, big], { simplifyPx: 4, roundPx: 0, minAreaPx2: 5000 }, EXT);
  const pts = pathPts(d);
  assert.ok(pts.length >= 4, 'big ring survives');
  const [x0, y0, x1, y1] = bboxOf(pts);
  assert.ok(x1 <= 260 && y1 <= 260 && x0 >= 0 && y0 >= 0, `pond should be culled; got bbox ${[x0, y0, x1, y1]}`);
});

test('stylizeRingsPathD: empty when everything is culled', () => {
  assert.equal(stylizeRingsPathD([SQUARE], { simplifyPx: 0, roundPx: 0, minAreaPx2: 1e9 }, EXT), '');
});

test('simplifyVW: weighted vertices resist removal', () => {
  // same 2px notch as the unweighted test — protect its apex 16x and it survives
  const ring: Pt[] = [[0, 0], [48, 0], [50, 2], [52, 0], [100, 0], [100, 100], [0, 100]];
  const unprotected = simplifyVW(ring, 100);
  assert.equal(unprotected.length, 4);
  const protectedOut = simplifyVW(ring, 100, 4, (p) => (p[0] >= 48 && p[0] <= 52 ? 100 : 1));
  assert.ok(protectedOut.some((p) => p[0] === 50 && p[1] === 2), 'protected notch apex must survive');
});

test('stylizeRingsPathD: importance rescues a small ring from the cull', () => {
  const pond: Pt[] = [[100, 100], [180, 100], [180, 180], [100, 180]]; // 6400 px²
  const style = { simplifyPx: 4, roundPx: 0, minAreaPx2: 20000 };
  assert.equal(stylizeRingsPathD([pond], style, EXT), '', 'unprotected pond dies');
  const rescued = stylizeRingsPathD([pond], { ...style, importance: () => 1 }, EXT);
  assert.ok(rescued.length > 0, 'fully-important pond survives (6400·16 >= 20000)');
});

test('stylizeRingsPathD: deterministic (same input, same output)', () => {
  const rings: Pt[][] = [SQUARE, [[200, 200], [340, 205], [335, 350], [198, 344]]];
  const s = { simplifyPx: 12, roundPx: 20, minAreaPx2: 400, octi: true };
  assert.equal(stylizeRingsPathD(rings, s, EXT), stylizeRingsPathD(rings, s, EXT));
});
