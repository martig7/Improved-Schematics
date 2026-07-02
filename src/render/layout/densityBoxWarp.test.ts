import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDenseBoxes, findContractionBoxes, mergeIntersectingBoxes, medianEdgeLenPx, buildDemandBoxWarp, buildSepDemandBoxWarp } from './densityBoxWarp';
import type { BoxGraph, DenseBox } from './densityBoxWarp';
import type { WarpFn } from './densityWarp';
import type { Pixel } from './types';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
// The demand-warp tests use coordinates up to 450 (pinnedGraph's sparse chain),
// which do not fit inside BOX (100×100). The warp box is arbitrary, so use a
// dedicated 600×600 canvas for those tests.
const DBOX = { minX: 0, minY: 0, maxX: 600, maxY: 600 };
const DOPTS = {
  bins: 48, frac: 0.4, marginFrac: 1,
  cellFromMedLen: (m: number) => Math.max(12, m / 1.6),
  safety: 1.3, slack: 1.3, userMult: 1, expandMax: 10, maxGrowth: 8,
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
// pure aesthetic magnification, same role `expand` played in the old builder).
const EMPTY_GRAPH: BoxGraph = { nodes: [], edges: [] };

test('buildDemandBoxWarp: magnifies the core relative to its surround, with no localized thinning', () => {
  const opts = { bins: 48, frac: 0.4, marginFrac: 1, cellFromMedLen: () => 12, userMult: 4 };
  const r = buildDemandBoxWarp(clusterAt(50, 50, 160), EMPTY_GRAPH, BOX, opts);
  const jCore = jacDet(r.warp, [50, 50]); // inside the dense box → magnified
  const jFar = jacDet(r.warp, [96, 4]); // far corner → the global scale (1 when growth fits)
  assert.ok(jCore > jFar * 1.05, `core magnified vs surround, core=${jCore.toFixed(3)} far=${jFar.toFixed(3)}`);
  // No LOCALIZED thinning: the only compression anywhere is the global scale
  // sx/sy (1 here — maxGrowth defaults to 2, well above what this demand needs).
  // Nothing is thinner than that — no compression ring, no localized dip.
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
  // (tuning-robust: joint saturation is the only way they may legally collide).
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
});
