import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDenseBoxes, buildBoxExpandWarp, buildSepBoxWarp, findContractionBoxes, mergeIntersectingBoxes, medianEdgeLenPx, buildDemandBoxWarp } from './densityBoxWarp';
import type { BoxGraph, DenseBox } from './densityBoxWarp';
import { buildDensityWarp } from './densityWarp';
import type { WarpFn } from './densityWarp';
import type { Pixel } from './types';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
// The demand-warp tests use coordinates up to 450 (pinnedGraph's sparse chain),
// which do not fit inside BOX (100×100). The warp box is arbitrary, so use a
// dedicated 600×600 canvas for those tests.
const DBOX = { minX: 0, minY: 0, maxX: 600, maxY: 600 };

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

test('findContractionBoxes: pinned sub-threshold cluster gets a box, spread nodes do not', () => {
  // 5 nodes 8px apart (JFK-shaped) + 3 well-spread nodes.
  const nodes: Pixel[] = [[50, 50], [58, 50], [66, 50], [58, 58], [50, 58], [200, 200], [400, 200], [400, 400]];
  const edges: [number, number][] = [[0, 1], [1, 2], [1, 3], [3, 4], [5, 6], [6, 7]];
  const boxes = findContractionBoxes({ nodes, edges }, 20);
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  // covers the cluster, padded by threshold/2 = 10px per side
  assert.ok(b.x0 <= 40 && b.x1 >= 76 && b.y0 <= 40 && b.y1 >= 68);
});

test('findContractionBoxes: no short edges → no boxes; isolated close nodes without an edge → no boxes', () => {
  const nodes: Pixel[] = [[0, 0], [100, 0], [5, 5]]; // node 2 is near node 0 but NOT connected
  const edges: [number, number][] = [[0, 1]];
  assert.deepEqual(findContractionBoxes({ nodes, edges }, 20), []);
});

test('findContractionBoxes: two separate clusters → two boxes', () => {
  const nodes: Pixel[] = [[10, 10], [15, 10], [300, 300], [305, 300]];
  const edges: [number, number][] = [[0, 1], [2, 3]];
  assert.equal(findContractionBoxes({ nodes, edges }, 20).length, 2);
});

test('mergeIntersectingBoxes: overlapping chain collapses to one bbox; disjoint boxes survive', () => {
  const merged = mergeIntersectingBoxes([
    { x0: 0, y0: 0, x1: 10, y1: 10 },
    { x0: 8, y0: 8, x1: 20, y1: 20 },   // overlaps #0
    { x0: 18, y0: 18, x1: 30, y1: 30 }, // overlaps #1 only AFTER #0+#1 merge
    { x0: 100, y0: 100, x1: 110, y1: 110 },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { x0: 0, y0: 0, x1: 30, y1: 30 });
  assert.deepEqual(merged[1], { x0: 100, y0: 100, x1: 110, y1: 110 });
});

test('mergeIntersectingBoxes: empty and singleton inputs pass through', () => {
  assert.deepEqual(mergeIntersectingBoxes([]), []);
  assert.deepEqual(mergeIntersectingBoxes([{ x0: 1, y0: 2, x1: 3, y1: 4 }]), [{ x0: 1, y0: 2, x1: 3, y1: 4 }]);
});

// Helper: a JFK-shaped pinned cluster (gaps ~8px) connected off to a sparse line.
function pinnedGraph(): BoxGraph {
  const nodes: Pixel[] = [
    [50, 50], [58, 50], [66, 50], [58, 58], [50, 58], // cluster
    [30, 30], [150, 150], [300, 300], [450, 450],     // sparse chain
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [1, 3], [3, 4], // cluster edges (~8px)
    [0, 5], [2, 6], [6, 7], [7, 8], // outbound + sparse (>100px)
  ];
  return { nodes, edges };
}
const DOPTS = {
  bins: 48, frac: 0.4, marginFrac: 1,
  cellFromMedLen: (m: number) => Math.max(12, m / 1.6),
  safety: 1.3, slack: 1.3, userMult: 1, expandMax: 10, maxGrowth: 8,
};

test('buildDemandBoxWarp: demanded expansion lifts a pinned cluster past the contraction need', () => {
  const g = pinnedGraph();
  const r = buildDemandBoxWarp([], g, DBOX, DOPTS); // no density samples: contraction oracle only
  const medLen = medianEdgeLenPx(g);
  const need = (DOPTS.cellFromMedLen(medLen) / 2) * DOPTS.slack;
  // every formerly-short cluster edge comes out >= need
  for (const [a, b] of [[0, 1], [1, 2], [1, 3], [3, 4]] as [number, number][]) {
    const pa = r.warp(g.nodes[a]);
    const pb = r.warp(g.nodes[b]);
    const d = Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2);
    assert.ok(d >= need, `edge ${a}-${b}: ${d.toFixed(1)} < need ${need.toFixed(1)}`);
  }
});

test('buildDemandBoxWarp: growth is real (canvas grows, no claw-back) and capped by maxGrowth', () => {
  const g = pinnedGraph();
  const free = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, maxGrowth: 8 });
  assert.ok(free.growthX >= 1 && free.growthY >= 1);
  // warped canvas corners span growth × canvas exactly
  const tl = free.warp([DBOX.minX, DBOX.minY]);
  const br = free.warp([DBOX.maxX, DBOX.maxY]);
  assert.ok(Math.abs((br[0] - tl[0]) - (DBOX.maxX - DBOX.minX) * free.growthX) < 1e-6);
  assert.ok(Math.abs((br[1] - tl[1]) - (DBOX.maxY - DBOX.minY) * free.growthY) < 1e-6);
  // capping: maxGrowth 1 → canvas-preserving, and the cap shrinks the result globally
  const capped = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, maxGrowth: 1 });
  assert.equal(capped.growthX, 1);
  assert.equal(capped.growthY, 1);
});

test('buildDemandBoxWarp: no short edges + no density boxes → identity, growth 1', () => {
  const g: BoxGraph = { nodes: [[10, 10], [500, 500]], edges: [[0, 1]] };
  const r = buildDemandBoxWarp([], g, DBOX, DOPTS);
  assert.deepEqual(r.warp([123, 456]), [123, 456]);
  assert.equal(r.growthX, 1);
  assert.equal(r.growthY, 1);
});

test('buildDemandBoxWarp: userMult magnifies an already-clear density box aesthetically', () => {
  // dense SAMPLES cluster whose EDGES already clear the threshold: survival demand ~1.
  const g: BoxGraph = { nodes: [[45, 45], [55, 55], [200, 200]], edges: [[0, 1], [1, 2]] };
  const samples = clusterAt(50, 50, 200);
  const base = buildDemandBoxWarp(samples, g, DBOX, { ...DOPTS, cellFromMedLen: () => 12, userMult: 1 });
  const boosted = buildDemandBoxWarp(samples, g, DBOX, { ...DOPTS, cellFromMedLen: () => 12, userMult: 2 });
  // userMult 2 grows the box's span more than userMult 1
  const span = (r: { warp: WarpFn }) => r.warp([60, 60])[0] - r.warp([40, 40])[0];
  assert.ok(span(boosted) > span(base));
});

test('buildDemandBoxWarp: deterministic; out reports boxes (output space) and per-box expands', () => {
  const g = pinnedGraph();
  const o1: { boxes?: DenseBox[]; expands?: number[] } = {};
  const o2: { boxes?: DenseBox[]; expands?: number[] } = {};
  const r1 = buildDemandBoxWarp([], g, DBOX, DOPTS, o1);
  const r2 = buildDemandBoxWarp([], g, DBOX, DOPTS, o2);
  assert.deepEqual(r1.warp([77, 88]), r2.warp([77, 88]));
  assert.deepEqual(o1.boxes, o2.boxes);
  assert.deepEqual(o1.expands, o2.expands);
  assert.equal(o1.boxes!.length, o1.expands!.length);
  assert.ok(o1.expands!.every((e) => e >= 1));
  // the cluster's box in OUTPUT space contains the warped cluster nodes
  const p = r1.warp([58, 54]);
  assert.ok(o1.boxes!.some((b) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1));
});

test('buildDemandBoxWarp: refinement — post-warp gaps in every box clear the RE-DERIVED need', () => {
  const g = pinnedGraph();
  // Lock BOTH slack regimes: 1.3 (the default headroom) and 1.0 (bare survival,
  // which exposes the moving target the refinement pass corrects).
  for (const slack of [1.3, 1.0]) {
    const opts = { ...DOPTS, maxGrowth: 8, slack };
    const o: { boxes?: DenseBox[]; expands?: number[] } = {};
    const r = buildDemandBoxWarp([], g, DBOX, opts, o);
    // Advect the graph through the FINAL warp and re-derive the threshold the way
    // the builder does; every box's median inside-gap must clear it.
    const warped: BoxGraph = { nodes: g.nodes.map((p) => r.warp([p[0], p[1]])), edges: g.edges };
    const needAfter = (opts.cellFromMedLen(medianEdgeLenPx(warped)) / 2) * opts.slack;
    for (const b of o.boxes!) {
      const gapsIn: number[] = [];
      for (const [a, c] of warped.edges) {
        const pa = warped.nodes[a], pc = warped.nodes[c];
        const inA = pa[0] >= b.x0 && pa[0] <= b.x1 && pa[1] >= b.y0 && pa[1] <= b.y1;
        const inC = pc[0] >= b.x0 && pc[0] <= b.x1 && pc[1] >= b.y0 && pc[1] <= b.y1;
        if (inA && inC) gapsIn.push(Math.sqrt((pa[0] - pc[0]) ** 2 + (pa[1] - pc[1]) ** 2));
      }
      if (!gapsIn.length) continue;
      gapsIn.sort((x, y) => x - y);
      assert.ok(gapsIn[gapsIn.length >> 1] >= needAfter, `slack ${slack}: box median gap ${gapsIn[gapsIn.length >> 1]} < ${needAfter}`);
    }
  }
});
