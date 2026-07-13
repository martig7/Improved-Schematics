import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLaneCrops, type LaneCropTarget } from '../renderOctilinear';

type P = [number, number];

// Minimal edge set: one edge 'e' from node 'A' to node 'B'. A lane polyline runs
// from A toward B in segPath under key 'e|L1'. The crop function orients it
// node-end-first at the target's flagNode.
const edges = [{ id: 'e', from: 'A', to: 'B' }];
const joinCurves: never[] = [];
const FILLET = 50;

// Extract the first M coordinate (the node-end point) from a 'd' string.
const firstM = (d: string): P => {
  const m = d.match(/M([\-\d.]+),([\-\d.]+)/);
  assert.ok(m, 'expected an M command in ' + d);
  return [parseFloat(m![1]), parseFloat(m![2])];
};

test('crops a lane that overshoots through the box back to the box wall', () => {
  // Lane from A at [-30,0] running to B at [30,0]; box centered [0,0] side 20.
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [30, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', shape: { kind: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }, shared: false },
  ];
  const out = computeLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // node end now sits on the near (left) box wall x=-10.
  assert.deepEqual(firstM(d), [-10, 0]);
  // real segPath is NOT mutated
  assert.deepEqual(segPath.get('e|L1'), [[-30, 0], [30, 0]]);
});

test('a lane stopping short of its terminus box is extended straight to the wall', () => {
  // Node end at A=[-30,0] with the lane running to [-40,0]. The end direction
  // (poly[1] -> poly[0]) points at the box, the gap (20px) is within the
  // extension cap, so a wall point is prepended at x=-10.
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [-40, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', shape: { kind: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }, shared: false },
  ];
  const out = computeLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  assert.deepEqual(firstM(d), [-10, 0]);
});

test('a lane far beyond the extension cap is left unchanged', () => {
  // The gap (170px) exceeds the cap (min(4*20, 48) = 48), so nothing is drawn.
  const segPath = new Map<string, P[]>([['e|L1', [[-180, 0], [-200, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', shape: { kind: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }, shared: false },
  ];
  const out = computeLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  assert.deepEqual(firstM(d), [-180, 0]);
});

test('an interior lane end (continued by the next lane) is never cropped', () => {
  // Two edges of one line meeting at node B ([0,0], inside the box): the shared
  // endpoint is not a free end, so neither lane is cut and the through line
  // passes under the capsule intact.
  const twoEdges = [
    { id: 'e1', from: 'A', to: 'B' },
    { id: 'e2', from: 'B', to: 'C' },
  ];
  const segPath = new Map<string, P[]>([
    ['e1|L1', [[-30, 0], [0, 0]]],
    ['e2|L1', [[0, 0], [30, 0]]],
  ]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'B', shape: { kind: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }, shared: false },
  ];
  const out = computeLaneCrops(targets, segPath, twoEdges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // Both lanes untouched: the d still starts at the original far end.
  assert.deepEqual(firstM(d), [-30, 0]);
  assert.ok(d.includes('30.0,0.0'), 'second lane intact');
});

test('shared-anchor target is skipped (lane left uncropped)', () => {
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [30, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', shape: { kind: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }, shared: true },
  ];
  const out = computeLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // untouched: node end stays at the original [-30,0].
  assert.deepEqual(firstM(d), [-30, 0]);
});

test('a through line is cropped at each incident node end independently', () => {
  // One edge, two boxes: one at each node end. Cropping at A cuts the left end to
  // its box, cropping at B cuts the right end to its box.
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [30, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', shape: { kind: 'rect', x0: -30, y0: -5, x1: -20, y1: 5 }, shared: false },
    { lineId: 'L1', flagNode: 'B', shape: { kind: 'rect', x0: 20, y0: -5, x1: 30, y1: 5 }, shared: false },
  ];
  const out = computeLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // Left end cut to box A's right wall x=-20; right end cut to box B's left wall
  // x=20. The 'd' runs from the A end.
  assert.deepEqual(firstM(d), [-20, 0]);
  assert.ok(d.includes('20.0,0.0'));
  assert.deepEqual(segPath.get('e|L1'), [[-30, 0], [30, 0]]); // input intact
});

test('determinism: identical targets yield identical output', () => {
  const segPath = () => new Map<string, P[]>([['e|L1', [[-30, 0], [30, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', shape: { kind: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }, shared: false },
  ];
  const a = computeLaneCrops(targets, segPath(), edges, joinCurves, FILLET);
  const b = computeLaneCrops(targets, segPath(), edges, joinCurves, FILLET);
  assert.deepEqual([...a], [...b]);
});
