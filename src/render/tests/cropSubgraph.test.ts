import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropSubgraph } from '../cropSubgraph';
import type { SchematicInput } from '../schematic';

// A crop box [0,0,10,10] with a line running east out of it, one stop each side.
const makeInput = (): SchematicInput => ({
  routes: [
    { id: 'R1', color: '#f00', stNodes: [{ id: 'n1' }, { id: 'n2' }], stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n2', path: [{ trackId: 't1', reversed: false }], distance: 1 }] },
    // A wholly-inside line (both stops in core) must survive untouched.
    { id: 'R2', color: '#00f', stNodes: [{ id: 'n1' }, { id: 'n3' }], stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n3', path: [{ trackId: 't2', reversed: false }], distance: 1 }] },
    // A wholly-outside line must be dropped.
    { id: 'R3', color: '#0f0', stNodes: [{ id: 'n4' }, { id: 'n5' }], stCombos: [{ startStNodeId: 'n4', endStNodeId: 'n5', path: [{ trackId: 't3', reversed: false }], distance: 1 }] },
  ],
  tracks: [
    { id: 't1', coords: [[5, 5], [20, 5]] },
    { id: 't2', coords: [[5, 5], [3, 3]] },
    { id: 't3', coords: [[20, 20], [30, 30]] },
  ],
  stations: [
    { id: 'S1', name: 'A', coords: [5, 5], stNodeIds: ['n1'], trackIds: ['t1', 't2'], buildType: 'constructed' },
    { id: 'S2', name: 'B', coords: [20, 5], stNodeIds: ['n2'], trackIds: ['t1'], buildType: 'constructed' },
    { id: 'S3', name: 'C', coords: [3, 3], stNodeIds: ['n3'], trackIds: ['t2'], buildType: 'constructed' },
    { id: 'S4', name: 'D', coords: [20, 20], stNodeIds: ['n4'], trackIds: ['t3'], buildType: 'constructed' },
    { id: 'S5', name: 'E', coords: [30, 30], stNodeIds: ['n5'], trackIds: ['t3'], buildType: 'constructed' },
  ],
  stationGroups: undefined,
  geography: undefined,
  options: { width: 2700, height: 2700 },
} as unknown as SchematicInput);

test('cropSubgraph: a line leaving the box terminates at a boundary node beyond the box, on its true course', () => {
  const out = cropSubgraph(makeInput(), new Set(['S1', 'S3']), [0, 0, 10, 10], 16 / 9);
  const stations = out.stations as unknown as { id: string; coords: [number, number] }[];
  const bnd = stations.find((s) => s.id.startsWith('bndst_'));
  assert.ok(bnd, 'a synthetic boundary station is created');
  // The east-running line exits the grown box (0.5 pad → right edge at x=15); the
  // node sits on its true (horizontal) course, east of and outside the crop box.
  assert.ok(bnd!.coords[0] > 10, `boundary node east of the box, got x=${bnd!.coords[0]}`);
  assert.ok(Math.abs(bnd!.coords[1] - 5) < 1e-6, 'stays on the line’s true (y=5) course');
  // The real outside stop is dropped; the wholly-outside line's stops too.
  assert.ok(!stations.some((s) => s.id === 'S2'), 'real next-stop dropped');
  assert.ok(!stations.some((s) => ['S4', 'S5'].includes(s.id)), 'wholly-outside stops dropped');
});

test('cropSubgraph: the exit node sits JUST past the crossed edge at the true crossing (not far out along it)', () => {
  // A line exiting north out of box [0,0,10,10]: crossing at (5,10). The terminus
  // must sit just past the north edge at that x (~10.3 with the 0.03 margin), NOT
  // extended far out — the old box+0.5 (=15) / extend-along-edge behavior was the
  // "line hugging the edge with weird geometry" bug.
  const input = {
    routes: [{ id: 'R', color: '#f00', stNodes: [{ id: 'n1' }, { id: 'n2' }], stCombos: [{ startStNodeId: 'n1', endStNodeId: 'n2', path: [{ trackId: 't1', reversed: false }], distance: 1 }] }],
    tracks: [{ id: 't1', coords: [[5, 5], [5, 20]] }],
    stations: [
      { id: 'S1', name: 'A', coords: [5, 5], stNodeIds: ['n1'], trackIds: ['t1'], buildType: 'constructed' },
      { id: 'S2', name: 'B', coords: [5, 20], stNodeIds: ['n2'], trackIds: ['t1'], buildType: 'constructed' },
    ],
    stationGroups: undefined, geography: undefined, options: { width: 2700, height: 2700 },
  } as unknown as SchematicInput;
  const out = cropSubgraph(input, new Set(['S1']), [0, 0, 10, 10], 1);
  const bnd = (out.stations as unknown as { id: string; coords: [number, number] }[]).find((s) => s.id.startsWith('bndst_'));
  assert.ok(bnd, 'boundary node created');
  assert.ok(Math.abs(bnd!.coords[0] - 5) < 1e-6, `stays at the crossing x=5, got ${bnd!.coords[0]}`);
  assert.ok(bnd!.coords[1] > 10 && bnd!.coords[1] < 11, `just past the north edge (~10.3), not far out; got ${bnd!.coords[1]}`);
});

test('cropSubgraph: the boundary combo is rewired to the exit node; inside lines survive; outside lines drop', () => {
  const out = cropSubgraph(makeInput(), new Set(['S1', 'S3']), [0, 0, 10, 10], 16 / 9);
  const routes = out.routes as unknown as { id: string; stCombos: { startStNodeId: string; endStNodeId: string }[] }[];
  const r1 = routes.find((r) => r.id === 'R1');
  assert.ok(r1, 'boundary route kept');
  assert.equal(r1!.stCombos.length, 1);
  assert.equal(r1!.stCombos[0].startStNodeId, 'n1', 'core end unchanged');
  assert.ok(r1!.stCombos[0].endStNodeId.startsWith('bnd_'), 'outside end rewired to the boundary node');
  const r2 = routes.find((r) => r.id === 'R2');
  assert.ok(r2 && r2.stCombos[0].endStNodeId === 'n3', 'wholly-inside line untouched');
  assert.ok(!routes.some((r) => r.id === 'R3'), 'wholly-outside line dropped');
});
