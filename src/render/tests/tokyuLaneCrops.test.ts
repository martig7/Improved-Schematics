import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTokyuLaneCrops, type LaneCropTarget } from '../renderOctilinear';

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
    { lineId: 'L1', flagNode: 'A', boxCenter: [0, 0], boxSide: 20, shared: false },
  ];
  const out = computeTokyuLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // node end now sits on the near (left) box wall x=-10.
  assert.deepEqual(firstM(d), [-10, 0]);
  // real segPath is NOT mutated
  assert.deepEqual(segPath.get('e|L1'), [[-30, 0], [30, 0]]);
});

test('extends a short lane out to the box wall', () => {
  // Node end at A=[-30,0] running outward to [-40,0], short of the box at [0,0].
  // flagNode A -> poly is already node-end-first, so the emitted 'd' begins at the
  // extended node end. The ray from [-30,0] toward the box (+x) hits x=-10.
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [-40, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', boxCenter: [0, 0], boxSide: 20, shared: false },
  ];
  const out = computeTokyuLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // extended node end reaches the near wall x=-10.
  assert.deepEqual(firstM(d), [-10, 0]);
});

test('shared-anchor target is skipped (lane left uncropped)', () => {
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [30, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', boxCenter: [0, 0], boxSide: 20, shared: true },
  ];
  const out = computeTokyuLaneCrops(targets, segPath, edges, joinCurves, FILLET);
  const d = out.get('L1')!.join(' ');
  // untouched: node end stays at the original [-30,0].
  assert.deepEqual(firstM(d), [-30, 0]);
});

test('a through line is cropped at each incident node end independently', () => {
  // One edge, two boxes: one at each node end. Cropping at A cuts the left end to
  // its box, cropping at B cuts the right end to its box.
  const segPath = new Map<string, P[]>([['e|L1', [[-30, 0], [30, 0]]]]);
  const targets: LaneCropTarget[] = [
    { lineId: 'L1', flagNode: 'A', boxCenter: [-25, 0], boxSide: 10, shared: false },
    { lineId: 'L1', flagNode: 'B', boxCenter: [25, 0], boxSide: 10, shared: false },
  ];
  const out = computeTokyuLaneCrops(targets, segPath, edges, joinCurves, FILLET);
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
    { lineId: 'L1', flagNode: 'A', boxCenter: [0, 0], boxSide: 20, shared: false },
  ];
  const a = computeTokyuLaneCrops(targets, segPath(), edges, joinCurves, FILLET);
  const b = computeTokyuLaneCrops(targets, segPath(), edges, joinCurves, FILLET);
  assert.deepEqual([...a], [...b]);
});
