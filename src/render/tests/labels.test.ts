import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap, boxGap, boxSegGap, bundleOrder, encroachment, estimateTextWidth, labelAnchor, overlapFraction, placeLabels, renderLabel, segmentIntersectsBox, wrapLabel, type Segment } from '../labels';
import { lineGraph } from '../layout/tests/_fixtures';
import type { Pixel, StopMark } from '../layout/types';
import type { Prim } from '../sceneIR';

test('renderLabel emits rotate() only when angle is nonzero', () => {
  const flat = renderLabel({ id: 'n', label: 'Foo' }, { x: 10, y: 20, anchor: 'start' }, [10, 20], true, false);
  assert.ok(!flat.includes('rotate('), 'flat label has no rotate, byte-identical to today');
  const rot = renderLabel({ id: 'n', label: 'Foo' }, { x: 10, y: 20, anchor: 'start', angle: -45 }, [10, 20], true, false);
  assert.ok(rot.includes('rotate(-45)'), 'rotated label carries the transform');
});

test('renderLabel pushes a text prim carrying the angle only when rotated', () => {
  const flat: Prim[] = [];
  renderLabel({ id: 'n', label: 'Foo' }, { x: 1, y: 2, anchor: 'start' }, [1, 2], true, false, flat);
  assert.equal((flat[0] as { angle?: number }).angle, undefined);
  const rot: Prim[] = [];
  renderLabel({ id: 'n', label: 'Foo' }, { x: 1, y: 2, anchor: 'start', angle: 90 }, [1, 2], true, false, rot);
  assert.equal((rot[0] as { angle?: number }).angle, 90);
});

test('renderLabel emits two tspans for a two-line placement, one <text> otherwise', () => {
  const two = renderLabel({ id: 'n', label: '34 St-Penn Station' }, { x: 5, y: 6, anchor: 'start', lines: ['34 St-Penn', 'Station'] }, [5, 6], true, false);
  assert.equal((two.match(/<tspan/g) ?? []).length, 2);
  assert.ok(two.includes('>34 St-Penn</tspan>') && two.includes('>Station</tspan>'));
  const one = renderLabel({ id: 'n', label: 'Foo' }, { x: 5, y: 6, anchor: 'start' }, [5, 6], true, false);
  assert.ok(!one.includes('<tspan'), 'single line unchanged, no tspans');
});

test('renderLabel prim carries lines only when multi-line', () => {
  const p: Prim[] = [];
  renderLabel({ id: 'n', label: 'X' }, { x: 1, y: 2, anchor: 'start', lines: ['A', 'B'] }, [1, 2], true, false, p);
  assert.deepEqual((p[0] as { lines?: string[] }).lines, ['A', 'B']);
});

test('estimateTextWidth scales with length', () => {
  assert.equal(estimateTextWidth('abcd'), 4 * 6);
});

test('labelAnchor: a single dot anchors to the dot, not the node centre', () => {
  assert.deepEqual(labelAnchor([0, 0], [{ lineId: 'L', color: '#000', pos: [7, 3] }]), [7, 3]);
});

test('labelAnchor: no marks falls back to the centre', () => {
  assert.deepEqual(labelAnchor([1, 2], []), [1, 2]);
  assert.deepEqual(labelAnchor([1, 2], undefined), [1, 2]);
});

test('labelAnchor: a tight multi-dot capsule keeps the centre', () => {
  const marks: StopMark[] = [
    { lineId: 'A', color: '#000', pos: [2, 0] },
    { lineId: 'B', color: '#000', pos: [-2, 0] },
  ];
  assert.deepEqual(labelAnchor([0, 0], marks), [0, 0]);
});

test('wrapLabel keeps short names on one line', () => {
  assert.deepEqual(wrapLabel('96 St', 84), ['96 St']);
});

test('wrapLabel splits a long name on a space, balancing the two lines', () => {
  // "34 St-Penn Station" (108px > 84): the min-max split is after "St-Penn".
  assert.deepEqual(wrapLabel('34 St-Penn Station', 84), ['34 St-Penn', 'Station']);
});

test('wrapLabel never breaks mid-word: a long single word stays one line', () => {
  assert.deepEqual(wrapLabel('Elephant&CastleStation', 84), ['Elephant&CastleStation']);
});

test('boxesOverlap detects overlap and separation', () => {
  assert.ok(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(!boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }));
});

test('overlapFraction: 0 disjoint, fraction of the smaller box when overlapping', () => {
  assert.equal(overlapFraction({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }), 0); // disjoint
  assert.equal(overlapFraction({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }), 0.5); // half
  assert.equal(overlapFraction({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1); // full
  // fraction is of the SMALLER box: a 4x4 fully inside a 10x10 -> 1
  assert.equal(overlapFraction({ x: 0, y: 0, w: 10, h: 10 }, { x: 3, y: 3, w: 4, h: 4 }), 1);
});

test('boxSegGap: 0 when the segment meets the box, else the Euclidean gap', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(boxSegGap(box, [-5, 5], [15, 5]), 0); // crosses
  assert.equal(boxSegGap(box, [0, 20], [10, 20]), 10); // 10px above
  assert.ok(Math.abs(boxSegGap(box, [20, 5], [20, 15]) - 10) < 1e-9); // 10px right
});

test('segmentIntersectsBox detects a crossing segment', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.ok(segmentIntersectsBox([-5, 5], [15, 5], box)); // passes through
  assert.ok(!segmentIntersectsBox([-5, -5], [-5, 15], box)); // entirely left
});

test('placeLabels assigns a placement per station and avoids label overlap', () => {
  const graph = lineGraph([
    [0, 0],
    [200, 0],
  ]);
  const nodePx = new Map<string, Pixel>([
    ['n0', [0, 0]],
    ['n1', [200, 0]],
  ]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L1', color: '#f00', pos: [0, 0] }]],
    ['n1', [{ lineId: 'L1', color: '#f00', pos: [200, 0] }]],
  ]);
  const placements = placeLabels(graph, nodePx, stops, []);
  assert.equal(placements.size, 2);
  assert.ok(placements.has('n0') && placements.has('n1'));
});

const ANGLES = new Set([0, 45, -45, -90]);

test('every placement uses only never-upside-down octilinear angles', () => {
  const graph = lineGraph([[0, 0], [200, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [200, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L1', color: '#f00', pos: [0, 0] }]],
    ['n1', [{ lineId: 'L1', color: '#f00', pos: [200, 0] }]],
  ]);
  for (const p of placeLabels(graph, nodePx, stops, []).values()) {
    assert.ok(ANGLES.has(p.angle ?? 0));
  }
});

test('a lone label with room stays flat (flat when it fits)', () => {
  const graph = lineGraph([[0, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n0', [{ lineId: 'L', color: '#000', pos: [0, 0] }]]]);
  assert.equal(placeLabels(graph, nodePx, stops, []).get('n0')!.angle ?? 0, 0);
});

test('the overlap rescue is a no-op when nothing overlaps (never perturbs a clean layout)', () => {
  // Well-spaced stops: no labels overlap, so the rescue must change nothing -- the
  // result is identical to running with the rescue disabled.
  const graph = lineGraph([[0, 0], [200, 0], [400, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [200, 0]], ['n2', [400, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['n1', [{ lineId: 'L', color: '#000', pos: [200, 0], seq: 1 }]],
    ['n2', [{ lineId: 'L', color: '#000', pos: [400, 0], seq: 2 }]],
  ]);
  const withRescue = [...placeLabels(graph, nodePx, stops, []).entries()];
  process.env.OCTI_LABEL_NO_RESCUE = '1';
  try {
    const without = [...placeLabels(graph, nodePx, stops, []).entries()];
    assert.deepEqual(withRescue, without);
  } finally {
    delete process.env.OCTI_LABEL_NO_RESCUE;
  }
});

test('placeLabels is deterministic (same input, same placements twice)', () => {
  const graph = lineGraph([[0, 0], [30, 0], [60, 0]]);
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]], ['n1', [30, 0]], ['n2', [60, 0]]]);
  const stops = new Map<string, StopMark[]>([
    ['n0', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['n1', [{ lineId: 'L', color: '#000', pos: [30, 0], seq: 1 }]],
    ['n2', [{ lineId: 'L', color: '#000', pos: [60, 0], seq: 2 }]],
  ]);
  const a = [...placeLabels(graph, nodePx, stops, []).entries()];
  const b = [...placeLabels(graph, nodePx, stops, []).entries()];
  assert.deepEqual(a, b);
});

// One node with a long label, walled in by a picket fence of vertical segments on
// both flanks. Every flat box (wide, horizontal) crosses pickets; only the narrow
// vertical channel just off the dot (where a -90 label sits) stays clear.
const walledIn = () => {
  const graph = { nodes: new Map([['n0', { id: 'n0', label: 'Very Long Station Name' }]]) };
  const nodePx = new Map<string, Pixel>([['n0', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n0', [{ lineId: 'L', color: '#000', pos: [0, 0] as Pixel }]]]);
  const segs: Segment[] = [];
  for (const x of [20, 28, 36, 44, 52, 60]) {
    segs.push({ p1: [x, -60], p2: [x, 60] }, { p1: [-x, -60], p2: [-x, 60] });
  }
  return { graph, nodePx, stops, segs };
};

test('a horizontally boxed-in label rotates off flat', () => {
  const { graph, nodePx, stops, segs } = walledIn();
  const angle = placeLabels(graph, nodePx, stops, segs).get('n0')!.angle ?? 0;
  assert.notEqual(angle, 0);
});

test('OCTI_LABEL_NO_ROTATE=1 keeps every label flat even when boxed in', () => {
  process.env.OCTI_LABEL_NO_ROTATE = '1';
  try {
    const { graph, nodePx, stops, segs } = walledIn();
    assert.equal(placeLabels(graph, nodePx, stops, segs).get('n0')!.angle ?? 0, 0);
  } finally {
    delete process.env.OCTI_LABEL_NO_ROTATE;
  }
});

// The label-adjacency term (and the clearance term) are built on encroachment:
// how far other boxes intrude within a margin. The term's real-world effect is
// validated by rendering (it roughly halves label pairs closer than 6px on the
// dense NYC/SEA/LON dumps); here we pin the pure computation it is built from.
test('encroachment sums how far boxes intrude within the margin, zero beyond it', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(encroachment(box, [{ x: 14, y: 0, w: 5, h: 10 }], 11), 11 - 4); // 4px gap
  assert.equal(encroachment(box, [{ x: 30, y: 0, w: 5, h: 10 }], 11), 0); // beyond the margin
  assert.equal(encroachment(box, [], 11), 0);
  // additive over multiple intruders (one 4px right, one 4px below)
  assert.equal(encroachment(box, [{ x: 14, y: 0, w: 5, h: 10 }, { x: 0, y: 14, w: 10, h: 5 }], 11), (11 - 4) + (11 - 4));
  // a bigger margin ⇒ a bigger penalty for the same gap
  assert.ok(encroachment(box, [{ x: 14, y: 0, w: 5, h: 10 }], 20) > encroachment(box, [{ x: 14, y: 0, w: 5, h: 10 }], 11));
});

test('a multi-dot capsule anchors its label to the outermost dot on the chosen side', () => {
  const graph = { nodes: new Map([['n', { id: 'n', label: 'AB' }]]) };
  const nodePx = new Map<string, Pixel>([['n', [0, 0]]]);
  const stops = new Map<string, StopMark[]>([['n', [
    { lineId: 'X', color: '#000', pos: [-5, 0] as Pixel },
    { lineId: 'Y', color: '#000', pos: [5, 0] as Pixel },
  ]]]);
  // block the left flank so the label lands on the right
  const segs: Segment[] = [{ p1: [-20, -50], p2: [-20, 50] }];
  const pl = placeLabels(graph, nodePx, stops, segs).get('n')!;
  // the right-side, start-anchored label hangs off the RIGHT dot (x=5) + LABEL_OFFSET(12)
  assert.equal(pl.anchor, 'start');
  assert.equal(pl.x, 17);
});

test('a run of stations on one line labels to a consistent side', () => {
  // A at the origin is walled in on its right, so it labels left (W). B one stop
  // down the line has both sides open; the neighbor bonus should pull it left too,
  // rather than taking the enumeration-default right side.
  const graph = { nodes: new Map([
    ['A', { id: 'A', label: 'Station A' }],
    ['B', { id: 'B', label: 'Station B' }],
  ]) };
  const nodePx = new Map<string, Pixel>([['A', [0, 0]], ['B', [0, 40]]]);
  const stops = new Map<string, StopMark[]>([
    ['A', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['B', [{ lineId: 'L', color: '#000', pos: [0, 40], seq: 1 }]],
  ]);
  const segs: Segment[] = []; // picket wall on A's right only (near y=0)
  for (const x of [20, 28, 36, 44]) segs.push({ p1: [x, -20], p2: [x, 20] });
  const pl = placeLabels(graph, nodePx, stops, segs);
  const sideOf = (id: string) => Math.sign(pl.get(id)!.x - nodePx.get(id)![0]);
  assert.equal(sideOf('A'), -1, 'A is forced to the left by the wall');
  assert.equal(sideOf('B'), sideOf('A'), 'B follows A to the same side');
});

test('bundleOrder walks each line in seq order and chains predecessors', () => {
  const nodes = [
    { id: 'a', label: 'AAelong' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'CC' },
  ];
  const stops = new Map<string, StopMark[]>([
    ['a', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 0 }]],
    ['b', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 1 }]],
    ['c', [{ lineId: 'L', color: '#000', pos: [0, 0], seq: 2 }]],
  ]);
  const { order, prevOnBundle } = bundleOrder(nodes, stops);
  assert.deepEqual(order.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(prevOnBundle.get('b'), 'a');
  assert.equal(prevOnBundle.get('c'), 'b');
  assert.equal(prevOnBundle.get('a'), undefined);
});

test('bundleOrder tails unsequenced nodes longest-label-first (today order)', () => {
  const nodes = [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'YYYY' },
  ];
  const stops = new Map<string, StopMark[]>(); // no seq/lineId anywhere
  const { order, prevOnBundle } = bundleOrder(nodes, stops);
  assert.deepEqual(order.map((n) => n.id), ['y', 'x']);
  assert.equal(prevOnBundle.size, 0);
});
