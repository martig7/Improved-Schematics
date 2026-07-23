import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDenseBoxes, findEmphasisBoxes, findContractionBoxes, mergeIntersectingBoxes, medianEdgeLenPx, buildDemandBoxWarp, buildSepDemandBoxWarp, findCapsuleBoxes, findCorridorBoxes, mergeDemandBoxes, boxCrowdAnisotropy, splitMixedBoxes } from '../densityBoxWarp';
import type { BoxGraph, DenseBox, DemandBox, PairTarget, BoxKind } from '../densityBoxWarp';
import { buildDensityWarp } from '../densityWarp';
import type { WarpFn } from '../densityWarp';
import type { Pixel } from '../types';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
// The demand-warp tests use coordinates up to 450 (pinnedGraph's sparse chain),
// which do not fit inside BOX (100×100). The warp box is arbitrary, so use a
// dedicated 600×600 canvas for those tests.
const DBOX = { minX: 0, minY: 0, maxX: 600, maxY: 600 };
const DOPTS = {
  bins: 48, frac: 0.4, marginFrac: 1,
  cellFromMedLen: (m: number) => Math.max(12, m / 1.6),
  safety: 1.3, slack: 1.3, userMult: 1, expandMax: 10, maxGrowth: 8,
  // The contraction (pinch-survival) oracle is default OFF in production (the
  // warp is aesthetic; pinches are the draw's job). These demand-pipeline
  // tests exercise it directly, so enable it explicitly.
  contraction: true,
  // Emphasis-watershed params suited to the SMALL synthetic fixtures (the
  // production defaults — sharp sigma 1.2, minCells 4 — are tuned for
  // full-map, line-weighted inputs and would drop these tiny clusters). A
  // coarse sigma keeps a two-direction fixture as one splittable box.
  emphasisSigma: 2.5,
  minCells: 1,
  floorFrac: 0.05,
};

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

// Empty graph → findContractionBoxes contributes nothing, so these tests
// exercise the density oracle + per-box demand in isolation (userMult acts as
// pure aesthetic magnification).
const EMPTY_GRAPH: BoxGraph = { nodes: [], edges: [] };

test('buildDemandBoxWarp: magnifies the core relative to its surround, with no localized thinning', () => {
  const opts = { bins: 48, frac: 0.4, marginFrac: 1, cellFromMedLen: () => 12, userMult: 4 };
  const r = buildDemandBoxWarp(clusterAt(50, 50, 160), EMPTY_GRAPH, BOX, opts);
  const jCore = jacDet(r.warp, [50, 50]); // inside the dense box → magnified
  const jFar = jacDet(r.warp, [96, 4]); // far corner → the global scale (1 when growth fits)
  assert.ok(jCore > jFar * 1.05, `core magnified vs surround, core=${jCore.toFixed(3)} far=${jFar.toFixed(3)}`);
  // No LOCALIZED thinning: the only compression anywhere is the global scale
  // sx/sy (1 here, since maxGrowth defaults to 2, well above what this demand needs).
  // Nothing is thinner than that: no compression ring, no localized dip.
  for (let y = 2; y < 100; y += 4) for (let x = 2; x < 100; x += 4) {
    assert.ok(jacDet(r.warp, [x, y]) > jFar - 0.03, `no point thinner than the global scale at (${x},${y}), J=${jacDet(r.warp, [x, y]).toFixed(3)} vs ${jFar.toFixed(3)}`);
  }
});

test('buildDemandBoxWarp: deterministic; empty samples+graph → identity; userMult=1 with clear gaps → identity', () => {
  assert.deepEqual(buildDemandBoxWarp([], EMPTY_GRAPH, BOX, DOPTS).warp([3, 4]), [3, 4]);
  // A graph whose edges already clear the contraction threshold and no density
  // samples: no demand (userMult 1) and no aesthetic boost → identity.
  const clearGraph: BoxGraph = { nodes: [[10, 10], [90, 90]], edges: [[0, 1]] };
  assert.deepEqual(buildDemandBoxWarp([], clearGraph, BOX, { ...DOPTS, userMult: 1 }).warp([3, 4]), [3, 4]);
  const a = buildDemandBoxWarp(clusterAt(40, 60, 120), EMPTY_GRAPH, BOX, { bins: 32, frac: 0.4, marginFrac: 1, cellFromMedLen: () => 12, userMult: 1.4 });
  const b = buildDemandBoxWarp(clusterAt(40, 60, 120), EMPTY_GRAPH, BOX, { bins: 32, frac: 0.4, marginFrac: 1, cellFromMedLen: () => 12, userMult: 1.4 });
  for (const p of [[10, 10], [40, 60], [90, 90]] as Pixel[]) assert.deepEqual(a.warp(p), b.warp(p));
});

test('buildDemandBoxWarp: out.boxes empty with no cluster and no contraction demand', () => {
  const none: { boxes?: DenseBox[] } = {};
  buildDemandBoxWarp([], EMPTY_GRAPH, BOX, DOPTS, none);
  assert.deepEqual(none.boxes, [], 'no samples, no graph demand → no boxes');
});

test('findContractionBoxes: pinned sub-threshold cluster gets a box, spread nodes do not', () => {
  // 5 nodes 8px apart (a tight pinned cluster) + 3 well-spread nodes.
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

// Helper: a tight pinned cluster (gaps ~8px) connected off to a sparse line.
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
  // out.boxes are EXACTLY the pre-warp boxes' corners mapped through the final
  // warp. No density samples here, so the pre-warp boxes are contraction-only.
  // Recompute them the same way the builder does (both paths are deterministic).
  const pre = mergeIntersectingBoxes(
    findContractionBoxes(g, (DOPTS.cellFromMedLen(medianEdgeLenPx(g)) / 2) * DOPTS.safety),
  );
  assert.equal(o1.boxes!.length, pre.length, 'one out box per pre-warp box');
  for (let i = 0; i < pre.length; i++) {
    const a = r1.warp([pre[i].x0, pre[i].y0]); // top-left through the warp
    const c = r1.warp([pre[i].x1, pre[i].y1]); // bottom-right through the warp
    const ob = o1.boxes![i];
    assert.ok(Math.abs(ob.x0 - a[0]) < 1e-9 && Math.abs(ob.y0 - a[1]) < 1e-9, `box ${i} top-left mapped through warp`);
    assert.ok(Math.abs(ob.x1 - c[0]) < 1e-9 && Math.abs(ob.y1 - c[1]) < 1e-9, `box ${i} bottom-right mapped through warp`);
    assert.ok(ob.x1 > ob.x0 && ob.y1 > ob.y0, 'stays axis-aligned + corner order preserved');
  }
});

test('buildDemandBoxWarp: two clusters with different demands get different expands, both clear need', () => {
  // cluster A: gaps ~8px (high demand); cluster B: gaps ~20px (lower demand);
  // sparse chain keeps the global median high so both are sub-threshold.
  // A and B are far apart inside DBOX so their boxes don't merge.
  const nodes: Pixel[] = [
    [60, 60], [68, 60], [60, 68], [68, 68],         // cluster A (8px)
    [450, 120], [470, 120], [450, 140], [470, 140], // cluster B (20px)
    [200, 180], [350, 250], [500, 350], [350, 450], [200, 500], [60, 400], // sparse chain
  ];
  const aEdges: [number, number][] = [[0, 1], [0, 2], [1, 3]];
  const bEdges: [number, number][] = [[4, 5], [4, 6], [5, 7]];
  const edges: [number, number][] = [
    ...aEdges, ...bEdges,
    [3, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [7, 10], // all >150px
  ];
  const g: BoxGraph = { nodes, edges };
  const medLen = medianEdgeLenPx(g);
  const need = (DOPTS.cellFromMedLen(medLen) / 2) * DOPTS.slack;
  assert.ok(need > 20, `both clusters sub-threshold (need ${need.toFixed(1)})`);
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  const r = buildDemandBoxWarp([], g, DBOX, DOPTS, o);
  // (a) exactly two boxes; A (tighter) demands at least as much as B, and the
  // demands stay DISTINCT unless both are clamped at the expandMax ceiling
  // (joint saturation is the only way they may legally collide).
  assert.equal(o.boxes!.length, 2);
  assert.equal(o.expands!.length, 2);
  const iA = o.boxes![0].x0 < o.boxes![1].x0 ? 0 : 1; // A's box is the left one
  const iB = 1 - iA;
  assert.ok(o.expands![iA] >= o.expands![iB], `A demands at least as much: ${o.expands![iA]} >= ${o.expands![iB]}`);
  const bothSaturated = o.expands![iA] === DOPTS.expandMax && o.expands![iB] === DOPTS.expandMax;
  assert.ok(bothSaturated || o.expands![iA] > o.expands![iB], `distinct demands (A ${o.expands![iA]}, B ${o.expands![iB]})`);
  // (b) every intra-cluster edge of BOTH clusters clears need after warping
  const warped = g.nodes.map((p) => r.warp([p[0], p[1]]));
  for (const [a, b] of [...aEdges, ...bEdges]) {
    const d = Math.sqrt((warped[a][0] - warped[b][0]) ** 2 + (warped[a][1] - warped[b][1]) ** 2);
    assert.ok(d >= need, `edge ${a}-${b}: ${d.toFixed(1)} < need ${need.toFixed(1)}`);
  }
  // (c) growth equals the warped corner-span ratio per axis
  const tl = r.warp([DBOX.minX, DBOX.minY]);
  const br = r.warp([DBOX.maxX, DBOX.maxY]);
  assert.ok(Math.abs((br[0] - tl[0]) - (DBOX.maxX - DBOX.minX) * r.growthX) < 1e-6);
  assert.ok(Math.abs((br[1] - tl[1]) - (DBOX.maxY - DBOX.minY) * r.growthY) < 1e-6);
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

test('buildSepDemandBoxWarp: composes separable + demand warp; growth passes through', () => {
  const g = pinnedGraph();
  const s = clusterAt(58, 54, 200);
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  const r = buildSepDemandBoxWarp(s, g, DBOX, { alpha: 0.8, minScale: 1 }, { ...DOPTS, maxGrowth: 8 }, o);
  assert.ok(r.growthX >= 1 && r.growthY >= 1);
  assert.ok(o.boxes!.length >= 1);
  // deterministic (and independent of whether `out` was passed)
  const r2 = buildSepDemandBoxWarp(s, g, DBOX, { alpha: 0.8, minScale: 1 }, { ...DOPTS, maxGrowth: 8 });
  assert.deepEqual(r.warp([61, 47]), r2.warp([61, 47]));
  // (a) the composition adds REAL effect beyond separable alone: the box layer
  // expands the pinned cluster's span strictly more than the separable warp
  // does by itself (same sepOpts, same samples).
  const sep = buildDensityWarp(s, DBOX, { alpha: 0.8, minScale: 1 });
  const span = (W: (p: Pixel) => Pixel) => {
    const a = W(g.nodes[0]); // [50,50], cluster corner
    const b = W(g.nodes[3]); // [58,58], opposite cluster corner
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  };
  assert.ok(span(r.warp) > span((p) => sep(p)), `composed expands cluster more than separable alone: ${span(r.warp).toFixed(2)} > ${span((p) => sep(p)).toFixed(2)}`);
  // (b) fold-free: the composed warp is monotone per axis (x' strictly increases
  // along +x at any fixed y, y' along +y at any fixed x). This is equivalent to
  // det>0 for this separable-per-axis family, and cheaper than a Jacobian scan.
  const N = 20;
  const step = (DBOX.maxX - DBOX.minX) / N;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i < N; i++) {
      const y = DBOX.minY + j * step;
      const x = DBOX.minX + i * step;
      const wx0 = r.warp([x, y])[0];
      const wx1 = r.warp([x + step, y])[0];
      assert.ok(wx1 > wx0, `x-monotone at (${x},${y}): ${wx1} > ${wx0}`);
      const x2 = DBOX.minX + j * step;
      const y2 = DBOX.minY + i * step;
      const wy0 = r.warp([x2, y2])[1];
      const wy1 = r.warp([x2, y2 + step])[1];
      assert.ok(wy1 > wy0, `y-monotone at (${x2},${y2}): ${wy1} > ${wy0}`);
    }
  }
});

test('findCapsuleBoxes: a close big-interchange pair gets a box with the pair target; spaced pairs do not', () => {
  // nodes 0,1: 7-line and 6-line interchanges 30px apart (capsules need far more);
  // node 2: 5-line interchange 400px away (clear); nodes 3,4: single-line (excluded).
  const g: BoxGraph = {
    nodes: [[100, 100], [130, 100], [500, 100], [110, 130], [90, 80]],
    edges: [[0, 1], [1, 2], [0, 3], [0, 4]],
  };
  const lineCounts = [7, 6, 5, 1, 1];
  const spacing = 5.5;
  const boxes = findCapsuleBoxes(g, lineCounts, { spacing, margin: 4, casing: 8 });
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  assert.equal(b.kind, 'capsule');
  assert.equal(b.pairs.length, 1);
  assert.deepEqual([b.pairs[0].a, b.pairs[0].b], [0, 1]);
  // required = needA + needB + casing = ((7-1)*5.5/2 + 4) + ((6-1)*5.5/2 + 4) + 8
  const needA = ((7 - 1) * spacing) / 2 + 4;
  const needB = ((6 - 1) * spacing) / 2 + 4;
  assert.ok(Math.abs(b.pairs[0].required - (needA + needB + 8)) < 1e-9);
  // box covers both nodes, padded
  assert.ok(b.x0 < 100 && b.x1 > 130 && b.y0 < 100 && b.y1 > 100);
});

test('findCapsuleBoxes: chains of close interchanges cluster into one box with all violating pairs', () => {
  // three 4-line stations in a 25px-spaced row: pairs (0,1),(1,2) violate; (0,2) may too.
  const g: BoxGraph = { nodes: [[100, 100], [125, 100], [150, 100]], edges: [[0, 1], [1, 2]] };
  const boxes = findCapsuleBoxes(g, [4, 4, 4], { spacing: 5.5, margin: 4, casing: 8 });
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].pairs.length >= 2);
  for (const t of boxes[0].pairs) assert.ok(t.required > 0 && t.a < t.b);
});

test('findCapsuleBoxes: proximity does not require a shared edge', () => {
  // two 5-line interchanges 20px apart with NO connecting edge still flag.
  const g: BoxGraph = { nodes: [[100, 100], [120, 100]], edges: [] };
  const boxes = findCapsuleBoxes(g, [5, 5], { spacing: 5.5, margin: 4, casing: 8 });
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].pairs.length, 1);
});

const TRUNK8 = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];

test('findCorridorBoxes: a corridor node inside a wide edge clearance flags a scaled pair', () => {
  // edge (0,1): 8-line trunk along y=0; node 2 sits 15px off its interior and
  // belongs to a separate 1-line corridor (2,3) that never touches the trunk.
  const g: BoxGraph = {
    nodes: [[0, 0], [200, 0], [100, 15], [300, 300]],
    edges: [[0, 1], [2, 3]],
  };
  const spacing = 5.5;
  const boxes = findCorridorBoxes(g, [TRUNK8, ['z']], { spacing, margin: spacing });
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  assert.equal(b.kind, 'corridor');
  assert.equal(b.pairs.length, 1);
  const t = b.pairs[0];
  // pair = (node 2, nearer endpoint of the trunk); at t=0.5 the far endpoint
  // is chosen, so accept either endpoint index.
  assert.ok(t.a === 2 || t.b === 2);
  const v = t.a === 2 ? t.b : t.a;
  assert.ok(v === 0 || v === 1);
  // required lifts the node pair by the same scale that lifts the 15px
  // perpendicular clearance to halfW(19.25) + nodeHalfW(0) + margin(5.5).
  const req = ((8 - 1) * spacing) / 2 + 0 + spacing;
  const duv = Math.sqrt(100 ** 2 + 15 ** 2);
  assert.ok(Math.abs(t.required - duv * (req / 15)) < 1e-9);
});

test('findCorridorBoxes: junction-adjacent nodes and endpoint-zone passes stay silent', () => {
  const g: BoxGraph = {
    nodes: [[0, 0], [200, 0], [10, 15], [190, 300], [10, 15]],
    edges: [[0, 1], [0, 2], [1, 3]],
  };
  // node 2 is graph-adjacent to endpoint 0 (a junction leg, not a squeeze);
  // node 4 duplicates its position but has no edges, yet sits at t=0.05
  // (endpoint zone). Neither flags.
  const boxes = findCorridorBoxes(g, [TRUNK8, ['z1'], ['z2']], { spacing: 5.5 });
  assert.equal(boxes.length, 0);
});

test('findCorridorBoxes: a same-service parallel and a sub-threshold pass stay silent', () => {
  const g: BoxGraph = {
    nodes: [[0, 0], [200, 0], [100, 15], [300, 300], [100, 6], [320, 300]],
    edges: [[0, 1], [2, 3], [4, 5]],
  };
  // node 2's corridor shares line t1 with the trunk (same service: merges or
  // interlines downstream); node 4 sits 6px off the trunk, under the 10px
  // weld/contraction threshold. Neither flags.
  const boxes = findCorridorBoxes(g, [TRUNK8, ['t1'], ['z']], { spacing: 5.5, minDist: 10 });
  assert.equal(boxes.length, 0);
});

test('findCorridorBoxes: single-line corridors everywhere produce no demand', () => {
  const g: BoxGraph = {
    nodes: [[0, 0], [200, 0], [100, 4]],
    edges: [[0, 1]],
  };
  const boxes = findCorridorBoxes(g, [['z']], { spacing: 5.5 });
  assert.equal(boxes.length, 0);
});

test('findCorridorBoxes: deterministic', () => {
  const g: BoxGraph = {
    nodes: [[0, 0], [200, 0], [100, 15], [100, 40], [300, 300]],
    edges: [[0, 1], [2, 4], [3, 4]],
  };
  const a = findCorridorBoxes(g, [TRUNK8, ['y1', 'y2', 'y3'], ['y1', 'y2', 'y3']], { spacing: 5.5 });
  const b = findCorridorBoxes(g, [TRUNK8, ['y1', 'y2', 'y3'], ['y1', 'y2', 'y3']], { spacing: 5.5 });
  assert.deepEqual(a, b);
  assert.ok(a.length >= 1);
});

test('findCapsuleBoxes: deterministic', () => {
  const g: BoxGraph = { nodes: [[100, 100], [130, 100], [110, 130]], edges: [[0, 1]] };
  const a = findCapsuleBoxes(g, [6, 6, 6], { spacing: 5.5 });
  const b = findCapsuleBoxes(g, [6, 6, 6], { spacing: 5.5 });
  assert.deepEqual(a, b);
});

const DB = (x0: number, y0: number, x1: number, y1: number, kind: BoxKind, pairs: PairTarget[] = []): DemandBox =>
  ({ x0, y0, x1, y1, kind, pairs });

const totalArea = (bs: { x0: number; y0: number; x1: number; y1: number }[]): number =>
  bs.reduce((a, b) => a + Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0), 0);
const disjointPairwise = (bs: DemandBox[]): boolean => {
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j];
      const aInB = a.x0 >= b.x0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.y0 >= b.y0 - 1e-6 && a.y1 <= b.y1 + 1e-6;
      const bInA = b.x0 >= a.x0 - 1e-6 && b.x1 <= a.x1 + 1e-6 && b.y0 >= a.y0 - 1e-6 && b.y1 <= a.y1 + 1e-6;
      if (a.kind !== b.kind && (aInB || bInA)) continue; // nests are sanctioned
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > 1e-6 && oy > 1e-6) return false;
    }
  return true;
};

test('mergeDemandBoxes: same-kind LIGHT overlap clips apart (no union growth)', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 10, 10, 'capsule', [{ a: 0, b: 1, required: 20 }]),
    DB(8, 8, 20, 20, 'capsule', [{ a: 2, b: 3, required: 30 }]),
  ]);
  assert.equal(m.length, 2, 'a 4% overlap is not the same region');
  assert.ok(disjointPairwise(m), 'clipped disjoint');
  assert.ok(totalArea(m) <= 100 + 144 + 1e-6, 'no area growth');
  assert.equal(m.reduce((n, b) => n + b.pairs.length, 0), 2, 'both pairs survive');
});

test('mergeDemandBoxes: same-kind HEAVY overlap (>= half the smaller box) unions; pairs concatenate', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 10, 10, 'capsule', [{ a: 0, b: 1, required: 20 }]),
    DB(2, 2, 20, 20, 'capsule', [{ a: 2, b: 3, required: 30 }]), // overlap 64 of 100
  ]);
  assert.equal(m.length, 1);
  assert.deepEqual({ x0: m[0].x0, y0: m[0].y0, x1: m[0].x1, y1: m[0].y1 }, { x0: 0, y0: 0, x1: 20, y1: 20 });
  assert.equal(m[0].pairs.length, 2);
});

test('mergeDemandBoxes: cross-kind CONTAINMENT nests — both boxes survive', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 100, 100, 'density'),
    DB(40, 40, 60, 60, 'capsule', [{ a: 0, b: 1, required: 25 }]),
  ]);
  assert.equal(m.length, 2);
});

test('mergeDemandBoxes: cross-kind PARTIAL overlap clips the lower rank; higher rank keeps its extent', () => {
  const m = mergeDemandBoxes([
    DB(0, 0, 50, 50, 'contraction'),
    DB(40, 40, 90, 90, 'capsule', [{ a: 0, b: 1, required: 25 }]),
  ]);
  assert.equal(m.length, 2, 'clip, not union');
  const caps = m.find((b) => b.kind === 'capsule')!;
  const cont = m.find((b) => b.kind === 'contraction')!;
  assert.deepEqual({ x0: caps.x0, y0: caps.y0, x1: caps.x1, y1: caps.y1 }, { x0: 40, y0: 40, x1: 90, y1: 90 }, 'winner untouched');
  assert.ok(disjointPairwise(m));
  // least-loss clip: losing a 10px strip on one axis, not both
  assert.ok(totalArea([cont]) >= 50 * 40 - 1e-6, `loser keeps its least-loss remainder (got ${totalArea([cont])})`);
  assert.equal(caps.pairs.length, 1);
});

test('mergeDemandBoxes: a chain of small overlapping boxes cannot union into a mega box', () => {
  // six contraction boxlets each straddling the next, plus one density box
  // overlapping the first: under bbox-union fixpoint these chained into one
  // giant box; clip-apart must keep every output within its input extent.
  const chain: DemandBox[] = [];
  for (let i = 0; i < 6; i++) chain.push(DB(10 + i * 8, 10, 22 + i * 8, 22, 'contraction'));
  chain.push(DB(0, 0, 30, 30, 'density'));
  const m = mergeDemandBoxes(chain);
  assert.ok(disjointPairwise(m), 'outputs disjoint (nests aside)');
  assert.ok(totalArea(m) <= totalArea(chain) + 1e-6, 'total area never grows');
  const maxW = Math.max(...m.map((b) => b.x1 - b.x0));
  const maxH = Math.max(...m.map((b) => b.y1 - b.y0));
  assert.ok(maxW <= 30 + 1e-6 && maxH <= 30 + 1e-6, `no output exceeds the largest input (${maxW}x${maxH})`);
});

test('mergeDemandBoxes: a clip that consumes a box drops it and migrates its pairs', () => {
  // the loser pokes out of the winner by a sub-1px fringe on its only free
  // side: every clip remainder is a sliver -> drop, pairs migrate
  const m = mergeDemandBoxes([
    DB(10, 19.8, 30, 20.5, 'contraction', [{ a: 4, b: 5, required: 9 }]),
    DB(0, 20, 40, 60, 'capsule', [{ a: 0, b: 1, required: 25 }]),
  ]);
  assert.equal(m.length, 1, 'sliver remainder dropped');
  assert.equal(m[0].kind, 'capsule');
  assert.equal(m[0].pairs.length, 2, 'orphaned pair migrated to the winner');
});

test('mergeDemandBoxes: disjoint boxes pass through; empty input passes through; input-order invariant', () => {
  assert.equal(mergeDemandBoxes([DB(0, 0, 10, 10, 'density'), DB(50, 50, 60, 60, 'contraction')]).length, 2);
  assert.deepEqual(mergeDemandBoxes([]), []);
  const boxes = [
    DB(0, 0, 50, 50, 'contraction'),
    DB(40, 40, 90, 90, 'capsule'),
    DB(45, 0, 70, 30, 'density'),
  ];
  const key = (b: DemandBox) => `${b.kind}:${b.x0.toFixed(3)},${b.y0.toFixed(3)},${b.x1.toFixed(3)},${b.y1.toFixed(3)}`;
  const a = mergeDemandBoxes(boxes).map(key).sort();
  const b = mergeDemandBoxes([boxes[2], boxes[0], boxes[1]]).map(key).sort();
  assert.deepEqual(a, b, 'result independent of input order');
});

test('buildDemandBoxWarp: capsule oracle lifts a close interchange pair to its required separation', () => {
  // two interchanges 30px apart needing ~48px, on an otherwise sparse graph
  const g: BoxGraph = {
    nodes: [[200, 200], [230, 200], [30, 30], [560, 560], [560, 30], [30, 560]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
  };
  const lineCounts = [7, 6, 1, 1, 1, 1];
  // Small fixed cell so the CONTRACTION oracle boxes nothing here (30px pair is
  // above its ~8px threshold). The capsule oracle is then the sole driver, so the
  // assertion actually exercises the capsule path (not the contraction path).
  const opts = { ...DOPTS, cellFromMedLen: () => 12, maxGrowth: 8, capsule: { spacing: 5.5, lineCounts, margin: 4, casing: 8 } };
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  const rr = buildDemandBoxWarp([], g, DBOX, opts, o);
  const required = ((7 - 1) * 5.5) / 2 + 4 + (((6 - 1) * 5.5) / 2 + 4) + 8;
  const pa = rr.warp(g.nodes[0]);
  const pb = rr.warp(g.nodes[1]);
  const d = Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2);
  assert.ok(d >= required, `pair separation ${d.toFixed(1)} < required ${required.toFixed(1)}`);
});

test('buildDemandBoxWarp: no capsule opts → behavior unchanged (existing demand path)', () => {
  const g = pinnedGraph();
  const withOpt = buildDemandBoxWarp([], g, DBOX, DOPTS);
  const noCaps = buildDemandBoxWarp([], g, DBOX, { ...DOPTS });
  assert.deepEqual(withOpt.warp([123, 234]), noCaps.warp([123, 234]));
});

test('buildDemandBoxWarp: capsule box nested in a density box compounds fold-free', () => {
  // dense sample cluster spanning ~(40..160)² CONTAINING an interchange pair
  const g: BoxGraph = {
    nodes: [[90, 100], [115, 100], [30, 30], [560, 560]],
    edges: [[0, 1], [0, 2], [1, 3]],
  };
  const samples = clusterAt(100, 100, 400);
  const opts = { ...DOPTS, cellFromMedLen: () => 12, maxGrowth: 8, capsule: { spacing: 5.5, lineCounts: [6, 6, 1, 1], margin: 4, casing: 8 } };
  const rr = buildDemandBoxWarp(samples, g, DBOX, opts);
  // fold-free: strict per-axis monotonicity, step 15 so the grid samples THROUGH
  // the capsule push zone (pair at x 90..115), not just the wider density box
  for (let y = 0; y <= 600; y += 15) {
    let px = -Infinity;
    for (let x = 0; x <= 600; x += 15) {
      const q = rr.warp([x, y])[0];
      assert.ok(q > px, `x-monotonicity broke at ${x},${y}`);
      px = q;
    }
  }
  for (let x = 0; x <= 600; x += 15) {
    let py = -Infinity;
    for (let y = 0; y <= 600; y += 15) {
      const q = rr.warp([x, y])[1];
      assert.ok(q > py, `y-monotonicity broke at ${x},${y}`);
      py = q;
    }
  }
});

// direction-aware expansion (crowd anisotropy)

// Parallel vertical "avenue" lines: inter-line spacing 8px in x, station
// spacing 25px in y. Nearest neighbours lie ACROSS the lines (8 < 25), so the
// crowding is horizontal and the box should stretch in x.
function verticalLinesGraph(transpose = false): { g: BoxGraph; samples: Pixel[] } {
  const nodes: Pixel[] = [];
  const edges: [number, number][] = [];
  const LINES = 5, STOPS = 12;
  for (let l = 0; l < LINES; l++)
    for (let s = 0; s < STOPS; s++) {
      const i = nodes.length;
      const x = 280 + l * 8, y = 150 + s * 25;
      nodes.push(transpose ? [y, x] : [x, y]);
      if (s > 0) edges.push([i - 1, i]);
    }
  return { g: { nodes, edges }, samples: nodes.map((n) => [n[0], n[1]] as Pixel) };
}

test('boxCrowdAnisotropy: vertical lines → x-crowded, transpose → y-crowded, sparse → neutral', () => {
  const all = { x0: 0, y0: 0, x1: 600, y1: 600 };
  const v = boxCrowdAnisotropy(all, verticalLinesGraph().g);
  const h = boxCrowdAnisotropy(all, verticalLinesGraph(true).g);
  assert.ok(v > 0.75, `vertical lines read x-crowded, r=${v.toFixed(3)}`);
  assert.ok(h < 0.25, `horizontal lines read y-crowded, r=${h.toFixed(3)}`);
  // fewer than 2 inside nodes → no direction signal → neutral
  assert.equal(boxCrowdAnisotropy(all, { nodes: [[300, 300]], edges: [] }), 0.5);
  assert.equal(boxCrowdAnisotropy({ x0: 0, y0: 0, x1: 10, y1: 10 }, verticalLinesGraph().g), 0.5);
});

test('buildDemandBoxWarp: a vertically-lined box stretches horizontally, dramatically more than vertically', () => {
  const { g, samples } = verticalLinesGraph();
  const opts = { ...DOPTS, cellFromMedLen: () => 12, userMult: 3, maxGrowth: 8 };
  const o: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] } = {};
  const r = buildDemandBoxWarp(samples, g, DBOX, opts, o);
  assert.ok(o.boxes!.length >= 1);
  assert.ok(o.aniso!.length === o.boxes!.length);
  // realized stretch on the node field: across the lines vs along a line
  // (boxes are tightened to their nodes, so box-vs-density-box growth would
  // measure the smear, not the push)
  const w = (i: number) => r.warp([g.nodes[i][0], g.nodes[i][1]]);
  const acrossX = Math.abs(w(48)[0] - w(0)[0]) / 32; // line 0 stop 0 → line 4 stop 0
  const alongY = Math.abs(w(2)[1] - w(0)[1]) / 50; // line 0, stop 0 → stop 2
  assert.ok(acrossX > alongY * 1.5, `across-lines x-stretch dominates: x=${acrossX.toFixed(2)} y=${alongY.toFixed(2)}`);
  assert.ok(alongY >= 1 - 1e-9, `along-line never shrinks locally, y=${alongY.toFixed(2)}`);
});

test('buildDemandBoxWarp: aniso 0 → isotropic strengths (all reported r = 0.5)', () => {
  const { g, samples } = verticalLinesGraph();
  const opts = { ...DOPTS, cellFromMedLen: () => 12, userMult: 3, maxGrowth: 8, aniso: 0 };
  const o: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] } = {};
  buildDemandBoxWarp(samples, g, DBOX, opts, o);
  assert.ok((o.aniso?.length ?? 0) >= 1, 'at least one box reported');
  for (const r of o.aniso!) assert.ok(Math.abs(r - 0.5) < 1e-9, `aniso 0 → isotropic split r=${r}`);
});

test('buildDemandBoxWarp: pinned pair expands along its displacement axis and still clears need', () => {
  // Horizontal 8px pair + a 60px chain: median edge 60 → need ≈ 24, well
  // within the pair's reachable expansion (the chain must not be so long that
  // need outruns expandMax, a regime that can't clear regardless of direction).
  const g: BoxGraph = {
    nodes: [[100, 100], [108, 100], [100, 160], [100, 220], [160, 220]],
    edges: [[0, 1], [0, 2], [2, 3], [3, 4]],
  };
  const r = buildDemandBoxWarp([], g, DBOX, DOPTS);
  const need = (DOPTS.cellFromMedLen(medianEdgeLenPx(g)) / 2) * DOPTS.slack;
  const pa = r.warp(g.nodes[0]);
  const pb = r.warp(g.nodes[1]);
  const dx = Math.abs(pa[0] - pb[0]);
  const dy = Math.abs(pa[1] - pb[1]);
  assert.ok(Math.sqrt(dx * dx + dy * dy) >= need, `pair clears need ${need.toFixed(1)}`);
  // the separation came from the x axis (the pair is horizontal)
  assert.ok(dx >= need * 0.95, `separation is along x: dx=${dx.toFixed(1)}`);
});

test('buildDemandBoxWarp: anisotropy is deterministic and reported via out.aniso in [0.1, 0.9]', () => {
  const { g, samples } = verticalLinesGraph();
  const opts = { ...DOPTS, cellFromMedLen: () => 12, userMult: 3, maxGrowth: 8 };
  const o1: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] } = {};
  const o2: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] } = {};
  const r1 = buildDemandBoxWarp(samples, g, DBOX, opts, o1);
  const r2 = buildDemandBoxWarp(samples, g, DBOX, opts, o2);
  assert.deepEqual(r1.warp([301, 234]), r2.warp([301, 234]));
  assert.deepEqual(o1.aniso, o2.aniso);
  assert.ok(o1.aniso!.every((a) => a >= 0.1 && a <= 0.9));
});

// direction-coherent box splitting

// A direction-MIXED region: vertical trunks on the west, horizontal trunks on
// the east, inside one covering box. No single r serves both.
function mixedRegion(): { g: BoxGraph; parent: DemandBox } {
  const nodes: Pixel[] = [];
  const edges: [number, number][] = [];
  for (let l = 0; l < 5; l++)
    for (let s = 0; s < 12; s++) {
      const i = nodes.length;
      nodes.push([120 + l * 8, 120 + s * 25]); // west: vertical lines, 8px apart in x
      if (s > 0) edges.push([i - 1, i]);
    }
  for (let l = 0; l < 5; l++)
    for (let s = 0; s < 12; s++) {
      const i = nodes.length;
      nodes.push([260 + s * 25, 200 + l * 8]); // east: horizontal lines, 8px apart in y
      if (s > 0) edges.push([i - 1, i]);
    }
  const parent: DemandBox = { x0: 100, y0: 100, x1: 580, y1: 460, kind: 'density', pairs: [] };
  return { g: { nodes, edges }, parent };
}

test('splitMixedBoxes: a direction-mixed box splits into direction-coherent halves; a coherent box stays whole', () => {
  const { g, parent } = mixedRegion();
  assert.ok(Math.abs(boxCrowdAnisotropy(parent, g) - 0.5) < 0.15, 'parent reads near-neutral (mixed)');
  const split = splitMixedBoxes([parent], g, 5);
  assert.ok(split.length >= 2, `mixed box splits, got ${split.length}`);
  const rs = split.map((b) => boxCrowdAnisotropy(b, g));
  assert.ok(rs.some((r) => r > 0.7), `some half reads x-crowded: [${rs.map((r) => r.toFixed(2))}]`);
  assert.ok(rs.some((r) => r < 0.3), `some half reads y-crowded: [${rs.map((r) => r.toFixed(2))}]`);
  // sub-boxes stay inside the parent and keep its kind
  for (const b of split) {
    assert.ok(b.x0 >= parent.x0 - 1e-9 && b.x1 <= parent.x1 + 1e-9 && b.y0 >= parent.y0 - 1e-9 && b.y1 <= parent.y1 + 1e-9);
    assert.equal(b.kind, 'density');
  }
  // a coherent (all-vertical) box does not split
  const coherent = verticalLinesGraph();
  const whole: DemandBox = { x0: 260, y0: 130, x1: 340, y1: 450, kind: 'density', pairs: [] };
  assert.equal(splitMixedBoxes([whole], coherent.g, 5).length, 1);
});

test('splitMixedBoxes: pairs survive splitting — every pair lands in a half holding one of its endpoints', () => {
  const { g, parent } = mixedRegion();
  // a capsule pair bridging the two regions, so a cut between them puts it in BOTH halves
  const pairs: PairTarget[] = [{ a: 11, b: 60, required: 40 }];
  const split = splitMixedBoxes([{ ...parent, pairs }], g, 5);
  const holders = split.filter((b) => b.pairs.some((t) => t.a === 11 && t.b === 60));
  assert.ok(holders.length >= 1, 'pair preserved somewhere');
  for (const owner of holders) {
    const holdsEndpoint = [g.nodes[11], g.nodes[60]].some(
      (n) => n[0] >= owner.x0 && n[0] <= owner.x1 && n[1] >= owner.y0 && n[1] <= owner.y1,
    );
    assert.ok(holdsEndpoint, 'each holding box contains at least one endpoint');
  }
  // deterministic
  assert.deepEqual(splitMixedBoxes([{ ...parent, pairs }], g, 5), split);
});

test('buildDemandBoxWarp: mixed region — west stretches horizontally, east vertically (per-region direction)', () => {
  const { g } = mixedRegion();
  const samples = g.nodes.map((n) => [n[0], n[1]] as Pixel);
  const opts = { ...DOPTS, cellFromMedLen: () => 12, userMult: 3, maxGrowth: 8 };
  const o: { boxes?: DenseBox[]; expands?: number[]; aniso?: number[] } = {};
  const r = buildDemandBoxWarp(samples, g, DBOX, opts, o);
  // measure realized stretch on each region's node field
  const span = (lo: number, hi: number, axis: 0 | 1) => {
    const w = [g.nodes[lo], g.nodes[hi]].map((p) => r.warp([p[0], p[1]]));
    return Math.abs(w[1][axis] - w[0][axis]);
  };
  // west trunks: nodes 0 and 48 are the extreme lines' first stops (x 120 vs 152).
  // Along-line measures stay OUTSIDE the other region's push band (separable
  // pushes act on whole rows/columns, so measuring through the east box's
  // y-band would pick up ITS stretch, not the west box's).
  const westX = span(0, 48, 0) / 32; // per-px stretch across the lines
  const westY = span(0, 2, 1) / 50; // along a line, above the east y-band
  const eastY = span(60, 108, 1) / 32; // across the horizontal lines (y 200 vs 232)
  const eastX = span(60, 62, 0) / 50; // along a line, east of the west x-band
  assert.ok(westX > westY * 2, `west spreads across its lines: x=${westX.toFixed(2)} y=${westY.toFixed(2)}`);
  assert.ok(eastY > eastX * 2, `east spreads across its lines: y=${eastY.toFixed(2)} x=${eastX.toFixed(2)}`);
});

// hierarchical density decomposition (big boxes with no direction cut)

// Two dense, internally-isotropic cores separated by an empty 120px channel,
// all inside one covering box. Both cores read r≈0.5 (grids), so NO straight
// quantile cut clears the direction-gain bar. Only the density valley between
// them can split the box.
function twoCoreRegion(): { g: BoxGraph; parent: DemandBox } {
  const nodes: Pixel[] = [];
  const edges: [number, number][] = [];
  const core = (ox: number, oy: number) => {
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const i = nodes.length;
        nodes.push([ox + c * 14, oy + r * 14]);
        if (c > 0) edges.push([i - 1, i]);
        if (r > 0) edges.push([i - 8, i]);
      }
  };
  core(100, 200); // west core: x 100..198
  core(420, 240); // east core: x 420..518
  const parent: DemandBox = { x0: 80, y0: 180, x1: 540, y1: 380, kind: 'density', pairs: [] };
  return { g: { nodes, edges }, parent };
}

test('splitMixedBoxes: a big no-direction-cut box decomposes at density valleys into per-core boxes', () => {
  const { g, parent } = twoCoreRegion();
  const split = splitMixedBoxes([parent], g, 5);
  assert.ok(split.length >= 2, `decomposes, got ${split.length}`);
  // each core is covered by some box, and no box spans the channel (x 200..420)
  const covers = (x: number, y: number) => split.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  assert.ok(covers(150, 250), 'west core covered');
  assert.ok(covers(470, 290), 'east core covered');
  for (const b of split) assert.ok(!(b.x0 < 220 && b.x1 > 400), `no box spans the empty channel: ${JSON.stringify(b)}`);
  // deterministic
  assert.deepEqual(splitMixedBoxes([parent], g, 5), split);
});

test('splitMixedBoxes: decomposition keeps pairs — an orphan channel pair pulls its nearest child over it', () => {
  const { g, parent } = twoCoreRegion();
  const n = g.nodes.length;
  const gg: BoxGraph = { nodes: [...g.nodes, [300, 290], [310, 290]], edges: g.edges };
  const pairs: PairTarget[] = [{ a: n, b: n + 1, required: 40 }];
  const split = splitMixedBoxes([{ ...parent, pairs }], gg, 5);
  const holders = split.filter((b) => b.pairs.length > 0);
  assert.ok(holders.length >= 1, 'orphan pair still owned by some box');
  for (const h of holders)
    for (const t of h.pairs)
      for (const i of [t.a, t.b]) {
        const p = gg.nodes[i];
        assert.ok(p[0] >= h.x0 && p[0] <= h.x1 && p[1] >= h.y0 && p[1] <= h.y1, 'holder covers both pair endpoints');
      }
});

test('splitMixedBoxes: small boxes never density-decompose (below the size gate)', () => {
  // one 8x8 isotropic core (64 nodes < gate) in a roomy box: stays whole
  const nodes: Pixel[] = [];
  const edges: [number, number][] = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const i = nodes.length;
      nodes.push([100 + c * 14, 200 + r * 14]);
      if (c > 0) edges.push([i - 1, i]);
      if (r > 0) edges.push([i - 8, i]);
    }
  const parent: DemandBox = { x0: 80, y0: 180, x1: 400, y1: 400, kind: 'density', pairs: [] };
  assert.equal(splitMixedBoxes([parent], { nodes, edges }, 5).length, 1);
});

// growth = space proportional to warp (throttle, never squeeze)

test('buildDemandBoxWarp: the growth cap THROTTLES the warp — far field keeps unit scale, never squeezed', () => {
  const g = pinnedGraph();
  // force a big aesthetic demand against a tight cap
  const opts = { ...DOPTS, userMult: 6, maxGrowth: 1.3 };
  const r = buildDemandBoxWarp([], g, DBOX, opts);
  assert.ok(r.growthX <= 1.3 + 1e-9 && r.growthY <= 1.3 + 1e-9, 'cap respected');
  // far field (away from the cluster) is a rigid translation: unit jacobian,
  // not a global shrink, so the sparse outskirts keep true scale
  const J = jacDet(r.warp, [520, 520]);
  assert.ok(Math.abs(J - 1) < 0.02, `far-field J=1, got ${J.toFixed(3)}`);
  // and the canvas is exactly what the (throttled) warp produced
  const tl = r.warp([DBOX.minX, DBOX.minY]);
  const br = r.warp([DBOX.maxX, DBOX.maxY]);
  assert.ok(Math.abs((br[0] - tl[0]) - (DBOX.maxX - DBOX.minX) * r.growthX) < 1e-6);
  assert.ok(Math.abs((br[1] - tl[1]) - (DBOX.maxY - DBOX.minY) * r.growthY) < 1e-6);
});

test('buildDemandBoxWarp: under the cap, growth equals the raw warp growth (space ∝ warp)', () => {
  const g = pinnedGraph();
  const loose = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, maxGrowth: 8 });
  const looser = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, maxGrowth: 20 });
  // cap slack in both → identical growth (raw), identical warp
  assert.ok(Math.abs(loose.growthX - looser.growthX) < 1e-9);
  assert.ok(Math.abs(loose.growthY - looser.growthY) < 1e-9);
  assert.deepEqual(loose.warp([123, 456]), looser.warp([123, 456]));
  // far field at unit scale here too
  assert.ok(Math.abs(jacDet(loose.warp, [520, 520]) - 1) < 0.02);
});

test('buildDemandBoxWarp: per-warp caps throttle each warp INDEPENDENTLY (total growth = sum)', () => {
  // A contraction cluster (short cluster edges) and a capsule pair (a close,
  // heavy interchange), in disjoint regions so they stay separate single-kind
  // boxes. Both ride the Declutter dial, but each has its OWN growth cap; capping
  // one to identity must leave the other's growth untouched, and the full-map
  // growth must equal the sum of the two capped contributions.
  const g: BoxGraph = {
    nodes: [
      [50, 50], [55, 50], [60, 50], [55, 55], [50, 55], // 0-4 contraction cluster (~5px edges)
      [400, 300], [430, 300],                           // 5,6 capsule pair (30px, needs ~46)
      [30, 30], [560, 560], [560, 30], [30, 560],       // 7-10 sparse frame anchors
    ],
    edges: [[0, 1], [1, 2], [1, 3], [3, 4], [5, 6], [0, 7], [2, 8], [6, 9], [5, 10]],
  };
  const lineCounts = [1, 1, 1, 1, 1, 7, 6, 1, 1, 1, 1];
  const opts = {
    ...DOPTS, cellFromMedLen: () => 12, declutterPct: 1,
    capsule: { spacing: 5.5, lineCounts, margin: 4, casing: 8 }, contraction: true,
  };
  const growXof = (): number => buildDemandBoxWarp([], g, DBOX, opts).growthX;
  const env = (process as { env: Record<string, string | undefined> }).env;
  const restore = { c: env.OCTI_CONTRACTION_MAX, k: env.OCTI_CAPSULE_MAX };
  try {
    // active warp uncapped (10) in every measurement, so nothing throttles the
    // warp under test; only the zeroed warp's contribution vanishes.
    env.OCTI_CONTRACTION_MAX = '10'; env.OCTI_CAPSULE_MAX = '10';
    const gAll = growXof() - 1;
    env.OCTI_CAPSULE_MAX = '1'; // capsule -> identity
    const gConOnly = growXof() - 1;
    env.OCTI_CAPSULE_MAX = '10'; env.OCTI_CONTRACTION_MAX = '1'; // contraction -> identity
    const gCapOnly = growXof() - 1;
    assert.ok(gConOnly > 1e-6, `contraction alone grows X (${gConOnly})`);
    assert.ok(gCapOnly > 1e-6, `capsule alone grows X (${gCapOnly})`);
    assert.ok(Math.abs(gAll - (gConOnly + gCapOnly)) < 1e-6,
      `total ${gAll} = contraction ${gConOnly} + capsule ${gCapOnly}`);
  } finally {
    if (restore.c === undefined) delete env.OCTI_CONTRACTION_MAX; else env.OCTI_CONTRACTION_MAX = restore.c;
    if (restore.k === undefined) delete env.OCTI_CAPSULE_MAX; else env.OCTI_CAPSULE_MAX = restore.k;
  }
});

test('buildDemandBoxWarp: refinement never teleports a box to the ceiling', () => {
  // a pinned pair (gap 6 << need 7.8) inside a sparse frame: the secant may
  // stall (need moves with the median), but each stall step is bounded 1.5x,
  // so 4 passes from the first-pass demand can reach at most first*1.5^4 —
  // far below a straight expandMax jump for a mild deficit.
  const g: BoxGraph = {
    nodes: [[300, 300], [306, 300], [30, 30], [570, 570], [570, 30], [30, 570]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
  };
  const o: { boxes?: DenseBox[]; expands?: number[] } = {};
  buildDemandBoxWarp([], g, DBOX, { ...DOPTS, cellFromMedLen: () => 12 }, o);
  // first-pass demand for the pinned box is ~need/gap ≈ 1.3*1.3*12/2/6 ≈ 1.7;
  // the bound admits at most ~1.7*1.5^4 ≈ 8.6, but a genuine converge lands
  // far lower. The regression asserts the ceiling itself is never hit.
  for (const e of o.expands ?? []) {
    assert.ok(e < 10 - 1e-9, `no expand pinned at expandMax (got ${e})`);
  }
});

test('buildDemandBoxWarp: a graph whose gaps clear the need yields identity growth at userMult 1', () => {
  const g: BoxGraph = {
    nodes: [[100, 100], [200, 100], [300, 100], [400, 100]],
    edges: [[0, 1], [1, 2], [2, 3]],
  };
  const r = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, cellFromMedLen: () => 12 });
  assert.equal(r.growthX, 1);
  assert.equal(r.growthY, 1);
});

test('findDenseBoxes: components carry a normalized density d, linear cutoff->peak', () => {
  // one strong cluster + one weaker cluster: the strong core's d must exceed
  // the weak one's, both within [0,1]
  const samples = [...clusterAt(25, 25, 240), ...clusterAt(75, 75, 90)];
  const boxes = findDenseBoxes(samples, BOX, { bins: 32, frac: 0.2 });
  const at = (x: number, y: number) => boxes.find((b) => b.x0 <= x && x <= b.x1 && b.y0 <= y && y <= b.y1);
  const strong = at(25, 25);
  const weak = at(75, 75);
  assert.ok(strong && weak, 'both clusters boxed');
  assert.ok(strong!.d >= 0 && strong!.d <= 1 && weak!.d >= 0 && weak!.d <= 1, 'd in [0,1]');
  assert.ok(strong!.d > weak!.d, `denser core has higher d (${strong!.d.toFixed(2)} vs ${weak!.d.toFixed(2)})`);
});

test('demand pricing: survival ignores userMult; aesthetics scale linearly with d', () => {
  // pinned pair (gap 6 << need ~10.1): survival demand identical across sliders
  const g: BoxGraph = {
    nodes: [[300, 300], [306, 300], [30, 30], [570, 570], [570, 30], [30, 570]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
  };
  const grow = (userMult: number): number => {
    const r = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, userMult, cellFromMedLen: () => 12 });
    return r.growthX * r.growthY;
  };
  const lo = grow(0.25);
  const mid = grow(1);
  const hi = grow(4);
  assert.ok(Math.abs(lo - mid) < 1e-9, `survival identical at 0.25 and 1 (${lo} vs ${mid})`);
  assert.ok(Math.abs(hi - mid) < 1e-9, `no density samples -> no aesthetic term even at 4 (${hi} vs ${mid})`);
  // aesthetics: a dense cluster with cleared survival grows only when the
  // slider goes right, proportionally to its d
  const s = clusterAt(50, 50, 200);
  const aLo = buildDemandBoxWarp(s, EMPTY_GRAPH, BOX, { bins: 32, frac: 0.4, marginFrac: 1, cellFromMedLen: () => 12, userMult: 1 });
  const aHi = buildDemandBoxWarp(s, EMPTY_GRAPH, BOX, { bins: 32, frac: 0.4, marginFrac: 1, cellFromMedLen: () => 12, userMult: 4 });
  assert.equal(aLo.growthX, 1, 'userMult 1 -> no aesthetic demand');
  assert.ok(aHi.growthX > 1, 'userMult 4 magnifies the dense core');
});

test('buildDemandBoxWarp: percentage mode grows by t x the max-saturation growth', () => {
  const g: BoxGraph = {
    nodes: [[300, 300], [306, 300], [30, 30], [570, 570], [570, 30], [30, 570]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
  };
  const at = (growthPct: number) =>
    buildDemandBoxWarp([], g, DBOX, { ...DOPTS, cellFromMedLen: () => 12, growthPct });
  const t0 = at(0);
  assert.deepEqual(t0.warp([123, 456]), [123, 456], 't=0 is the identity');
  assert.equal(t0.growthX, 1);
  const t1 = at(1);
  const full = buildDemandBoxWarp([], g, DBOX, { ...DOPTS, cellFromMedLen: () => 12, maxGrowth: Infinity });
  assert.ok(Math.abs(t1.growthX - full.growthX) < 1e-9, 't=1 equals the max saturation');
  const t5 = at(0.5);
  assert.ok(Math.abs(t5.growthX - Math.max(1, 0.5 * t1.growthX)) < 1e-9,
    `growth(0.5) = half the saturation growth: ${t5.growthX} vs ${t1.growthX}`);
  assert.ok(Math.abs(t5.growthY - Math.max(1, 0.5 * t1.growthY)) < 1e-9);
  // below 1/saturation the target cap falls under 1 and the warp is identity
  const tTiny = at(1 / (t1.growthX * 2));
  assert.equal(tTiny.growthX, 1);
});

test('C2 push: far-field gain is exactly m/2 — growth gain preserved', () => {
  // The saturated push (u>=1) must translate a far point by exactly h+m/2 on
  // each axis, identical to the old quadratic segment, so the growth/throttle
  // and percentage-slider calibration are unchanged by the C2 profile.
  const m = 120;
  const pushGain = (u: number) => m * u * (1 + u * u * u * (-2.5 + u * (3 - u)));
  assert.ok(Math.abs(pushGain(1) - m / 2) < 1e-9, `gain at u=1 = ${pushGain(1)} vs m/2 ${m / 2}`);
  assert.ok(Math.abs(pushGain(0)) < 1e-12, 'gain at u=0 is 0');
  const mid = m * (0.5 - 2.5 / 16 + 3 / 32 - 1 / 64);
  assert.ok(Math.abs(pushGain(0.5) - mid) < 1e-9, 'midpoint gain matches closed form');
});

test('C2 push: second derivative continuous across both margin ends (no kink)', () => {
  // Reproduce push(a) for a single axis, h=40, m=120, and finite-difference the
  // curvature across a=h and a=h+m. The old linear ramp jumped by ~s/m here.
  const h = 40, m = 120;
  const push = (a: number): number => {
    if (a <= h) return a;
    if (a <= h + m) { const u = (a - h) / m; return h + m * u * (1 + u * u * u * (-2.5 + u * (3 - u))); }
    return h + m / 2;
  };
  const d2 = (a: number, e = 0.25): number => (push(a + e) - 2 * push(a) + push(a - e)) / (e * e);
  // curvature just inside/outside each transition must nearly match (continuous)
  for (const edge of [h, h + m]) {
    const lo = d2(edge - 1.5);
    const hi = d2(edge + 1.5);
    assert.ok(Math.abs(lo - hi) < 0.02, `curvature continuous at a=${edge}: ${lo} vs ${hi}`);
  }
  // and the flat regions have ~zero curvature
  assert.ok(Math.abs(d2(h - 5)) < 1e-6 && Math.abs(d2(h + m + 5)) < 1e-6, 'flat regions curvature 0');
});

test('findEmphasisBoxes: two peaks with a saddle → two disjoint basins, neither contains the other peak', () => {
  // Two dense clusters separated by a gap. The watershed must partition at the
  // ridge — neither basin box may contain the other cluster's centre (the
  // saddle-leak that rebuilds the map box, review item 1).
  const s = [...clusterAt(30, 50, 200), ...clusterAt(75, 50, 160)];
  const boxes = findEmphasisBoxes(s, BOX, { bins: 48, frac: 0.4, emphasisK: 6 });
  assert.ok(boxes.length >= 2, `two basins, got ${boxes.length}`);
  const contains = (b: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number) =>
    x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const a = boxes.find((b) => contains(b, 30, 50))!;
  const c = boxes.find((b) => contains(b, 75, 50))!;
  assert.ok(a && c && a !== c, 'the two peaks land in different basins');
  assert.ok(!contains(a, 75, 50), 'basin A does not swallow peak B');
  assert.ok(!contains(c, 30, 50), 'basin C does not swallow peak A');
});

test('findEmphasisBoxes: top-K caps the region count; determinism', () => {
  const s = [...clusterAt(20, 20, 120), ...clusterAt(80, 20, 120), ...clusterAt(50, 80, 120)];
  const k2 = findEmphasisBoxes(s, BOX, { bins: 48, frac: 0.4, emphasisK: 2 });
  const k9 = findEmphasisBoxes(s, BOX, { bins: 48, frac: 0.4, emphasisK: 9 });
  assert.ok(k2.length <= 2, `K=2 caps count, got ${k2.length}`);
  assert.ok(k9.length >= k2.length, 'higher K keeps at least as many');
  const again = findEmphasisBoxes(s, BOX, { bins: 48, frac: 0.4, emphasisK: 9 });
  assert.deepEqual(k9, again, 'deterministic');
  for (const b of k9) assert.ok(b.d >= 0 && b.d <= 1, `d in [0,1]: ${b.d}`);
});

test('margin cap: large box band <= cap; small box proportional; still fold-safe', () => {
  // A big density cluster (wide box) with the margin capped: the transition
  // band must be <= cap, not marginFrac*halfExtent. Fold-safe: no point has
  // negative local scale (jacDet > 0) everywhere.
  const s = clusterAt(50, 50, 220);
  const capped = buildDemandBoxWarp(s, EMPTY_GRAPH, BOX, { bins: 48, frac: 0.4, marginFrac: 3, cellFromMedLen: () => 12, userMult: 4, emphasisSigma: 2.5, minCells: 1, floorFrac: 0.05, marginCap: 24, curvBound: Infinity });
  const uncapped = buildDemandBoxWarp(s, EMPTY_GRAPH, BOX, { bins: 48, frac: 0.4, marginFrac: 3, cellFromMedLen: () => 12, userMult: 4, emphasisSigma: 2.5, minCells: 1, floorFrac: 0.05 });
  // the capped warp returns to ~unit scale closer to the box than the uncapped
  // one: sample the local scale a fixed distance outside the core.
  const sampleScale = (W: WarpFn, x: number): number => (W([x + 0.5, 50])[0] - W([x - 0.5, 50])[0]);
  // far outside both boxes: both ~unit
  assert.ok(Math.abs(sampleScale(capped.warp, 98) - 1) < 0.05, 'capped: faithful far out');
  // at ~35px right of center: capped should be back near unit (band<=24),
  // uncapped still stretched (band ~3*half)
  const cappedMid = sampleScale(capped.warp, 85);
  const uncappedMid = sampleScale(uncapped.warp, 85);
  assert.ok(cappedMid <= uncappedMid + 1e-6, `capped contains distortion sooner: ${cappedMid.toFixed(3)} <= ${uncappedMid.toFixed(3)}`);
  // fold-safe everywhere
  for (let y = 4; y < 100; y += 8) for (let x = 4; x < 100; x += 8) {
    assert.ok(jacDet(capped.warp, [x, y]) > 0, `fold-safe at (${x},${y})`);
  }
});
