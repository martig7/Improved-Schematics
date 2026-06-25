import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDenseBoxes, buildBoxExpandWarp, buildSepBoxWarp } from './densityBoxWarp';
import { buildDensityWarp } from './densityWarp';
import type { Pixel } from './types';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

// numeric area magnification J = det(Jacobian) at p, via finite differences
function jacDet(W: (p: Pixel) => Pixel, p: Pixel, h = 0.5): number {
  const wx1 = W([p[0] + h, p[1]]);
  const wx0 = W([p[0] - h, p[1]]);
  const wy1 = W([p[0], p[1] + h]);
  const wy0 = W([p[0], p[1] - h]);
  const a = (wx1[0] - wx0[0]) / (2 * h);
  const b = (wy1[0] - wy0[0]) / (2 * h);
  const c = (wx1[1] - wx0[1]) / (2 * h);
  const d = (wy1[1] - wy0[1]) / (2 * h);
  return a * d - b * c;
}

function clusterAt(cx: number, cy: number, n = 120): Pixel[] {
  const pts: Pixel[] = [];
  for (let k = 0; k < n; k++) pts.push([cx + ((k % 6) - 3), cy + (((k / 6) | 0) % 6 - 3)]);
  return pts;
}

test('findDenseBoxes: a cluster yields a box covering it; empty → none', () => {
  assert.deepEqual(findDenseBoxes([], BOX, {}), []);
  const boxes = findDenseBoxes(clusterAt(70, 30), BOX, { bins: 32, frac: 0.4 });
  assert.ok(boxes.length >= 1, 'at least one dense box');
  // some box contains the cluster centre (70,30)
  const hit = boxes.some((b) => b.x0 <= 70 && 70 <= b.x1 && b.y0 <= 30 && 30 <= b.y1);
  assert.ok(hit, `a box covers the cluster, got ${JSON.stringify(boxes)}`);
});

test('findDenseBoxes: higher cutoff selects a smaller (or equal) dense area', () => {
  const s = clusterAt(50, 50, 200);
  const lo = findDenseBoxes(s, BOX, { bins: 48, frac: 0.2 });
  const hi = findDenseBoxes(s, BOX, { bins: 48, frac: 0.6 });
  const area = (bs: { x0: number; y0: number; x1: number; y1: number }[]) =>
    bs.reduce((a, b) => a + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  assert.ok(area(hi) <= area(lo) + 1e-6, `stricter cutoff ≤ area: ${area(hi)} vs ${area(lo)}`);
});

test('buildBoxExpandWarp: magnifies the core relative to its surround, with no localized thinning', () => {
  const W = buildBoxExpandWarp(clusterAt(50, 50, 160), BOX, { bins: 48, frac: 0.4, expand: 1.4, marginFrac: 1 });
  const jCore = jacDet(W, [50, 50]); // inside the dense box → magnified
  const jFar = jacDet(W, [96, 4]); // far corner → the uniform global shrink factor
  assert.ok(jCore > jFar * 1.05, `core magnified vs surround, core=${jCore.toFixed(3)} far=${jFar.toFixed(3)}`);
  // No LOCALIZED thinning: after normalization the ONLY compression anywhere is
  // the gentle uniform global rescale (jFar). Nothing is thinner than that — the
  // old taper's compression ring is gone, not replaced by a localized dip.
  for (let y = 2; y < 100; y += 4) for (let x = 2; x < 100; x += 4) {
    assert.ok(jacDet(W, [x, y]) > jFar - 0.03, `no point thinner than the global shrink at (${x},${y}), J=${jacDet(W, [x, y]).toFixed(3)} vs ${jFar.toFixed(3)}`);
  }
});

test('buildBoxExpandWarp: bounded — the warped canvas fits growthCap, no blowup', () => {
  const opts = { bins: 48, frac: 0.4, expand: 4, marginFrac: 3 } as const;
  const bbox = (W: (p: Pixel) => Pixel) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y <= 100; y += 2) for (let x = 0; x <= 100; x += 2) {
      const [wx, wy] = W([x, y]);
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    }
    return { w: maxX - minX, h: maxY - minY };
  };
  // growthCap 1 = canvas-preserving (like the separable warp): even at expand 4
  // the warped canvas does not exceed the 100×100 box.
  const b1 = bbox(buildBoxExpandWarp(clusterAt(50, 50, 300), BOX, { ...opts, growthCap: 1 }));
  assert.ok(b1.w <= 100.1 && b1.h <= 100.1, `growthCap 1 stays bounded, got ${b1.w.toFixed(1)}×${b1.h.toFixed(1)}`);
  // a larger growthCap deliberately allows the map to grow a little more
  const b2 = bbox(buildBoxExpandWarp(clusterAt(50, 50, 300), BOX, { ...opts, growthCap: 1.5 }));
  assert.ok(b2.w > b1.w + 1, `growthCap 1.5 grows more than 1.0, ${b2.w.toFixed(1)} vs ${b1.w.toFixed(1)}`);
});

test('buildBoxExpandWarp: deterministic; expand=1 or no samples → identity', () => {
  assert.deepEqual(buildBoxExpandWarp([], BOX, {})([3, 4]), [3, 4]);
  assert.deepEqual(buildBoxExpandWarp(clusterAt(50, 50), BOX, { expand: 1 })([3, 4]), [3, 4]);
  const a = buildBoxExpandWarp(clusterAt(40, 60, 120), BOX, { bins: 32, frac: 0.4, expand: 1.4 });
  const b = buildBoxExpandWarp(clusterAt(40, 60, 120), BOX, { bins: 32, frac: 0.4, expand: 1.4 });
  for (const p of [[10, 10], [40, 60], [90, 90]] as Pixel[]) assert.deepEqual(a(p), b(p));
});

test('buildSepBoxWarp: composes separable + box, fold-free, expands core more than separable alone', () => {
  const s = clusterAt(50, 50, 200);
  const sep = buildDensityWarp(s, BOX, { alpha: 0.8 });
  const both = buildSepBoxWarp(s, BOX, { alpha: 0.8 }, { bins: 48, frac: 0.4, expand: 3, marginFrac: 2 });
  for (let y = 2; y < 100; y += 5) for (let x = 2; x < 100; x += 5) {
    assert.ok(jacDet(both, [x, y]) > 0, `det>0 at (${x},${y})`);
  }
  // the box adds expansion on top of separable: J at the core is strictly larger
  const jSep = jacDet(sep, [50, 50]);
  const jBoth = jacDet(both, [50, 50]);
  assert.ok(jBoth > jSep, `combined expands core more than separable: ${jBoth.toFixed(2)} > ${jSep.toFixed(2)}`);
});

test('buildBoxExpandWarp: out.boxes are the dense boxes mapped into warp-OUTPUT space', () => {
  const s = clusterAt(50, 50, 200);
  const opts = { bins: 48, frac: 0.4, expand: 1.4, marginFrac: 1 };
  const inBoxes = findDenseBoxes(s, BOX, opts); // deterministic → same boxes the warp uses
  assert.ok(inBoxes.length >= 1, 'a dense box exists');
  const out: { boxes?: typeof inBoxes } = {};
  const W = buildBoxExpandWarp(s, BOX, opts, out);
  assert.ok(out.boxes && out.boxes.length === inBoxes.length, 'one out box per dense box');
  for (let i = 0; i < inBoxes.length; i++) {
    const a = W([inBoxes[i].x0, inBoxes[i].y0]); // top-left through the warp
    const c = W([inBoxes[i].x1, inBoxes[i].y1]); // bottom-right through the warp
    const ob = out.boxes![i];
    assert.ok(Math.abs(ob.x0 - a[0]) < 1e-9 && Math.abs(ob.y0 - a[1]) < 1e-9, 'top-left mapped through warp');
    assert.ok(Math.abs(ob.x1 - c[0]) < 1e-9 && Math.abs(ob.y1 - c[1]) < 1e-9, 'bottom-right mapped through warp');
    assert.ok(ob.x1 > ob.x0 && ob.y1 > ob.y0, 'stays axis-aligned + corner order preserved');
  }
});

test('out.boxes: empty with no cluster; populated (and ordered) for sep+box', () => {
  const none: { boxes?: { x0: number; y0: number; x1: number; y1: number }[] } = {};
  buildBoxExpandWarp([], BOX, {}, none);
  assert.deepEqual(none.boxes, [], 'no samples → no boxes');
  const sepOut: { boxes?: { x0: number; y0: number; x1: number; y1: number }[] } = {};
  buildSepBoxWarp(clusterAt(50, 50, 200), BOX, { alpha: 0.8 }, { bins: 48, frac: 0.4, expand: 3, marginFrac: 2 }, sepOut);
  assert.ok(sepOut.boxes && sepOut.boxes.length >= 1, 'sep+box surfaces the dense box');
  for (const b of sepOut.boxes!) assert.ok(b.x1 > b.x0 && b.y1 > b.y0, 'axis-aligned + ordered');
});
