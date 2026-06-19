import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupportGraph, SupportEdge, SupportNode, Pixel } from './types';
import { splitHubs } from './splitHubs';
import { combineDeg2 } from './octi';

// Build a star hub: one centre node `hub` with `arms` spokes, each carrying a
// distinct line. The hub is a station group `G`.
function starHub(arms: number, linesPerArm = 2): SupportGraph {
  const nodes = new Map<string, SupportNode>();
  const edges = new Map<string, SupportEdge>();
  const adj = new Map<string, string[]>();
  const lineRefs = new Map<string, { id: string; label: string; color: string }>();
  const stopAt = new Set<string>();
  nodes.set('hub', { id: 'hub', pos: [0, 0] });
  adj.set('hub', []);
  let lineSeq = 0;
  for (let i = 0; i < arms; i++) {
    const ang = (i / arms) * Math.PI * 2;
    const tip: Pixel = [Math.cos(ang) * 200, Math.sin(ang) * 200];
    const tipId = 't' + i;
    nodes.set(tipId, { id: tipId, pos: tip });
    adj.set(tipId, []);
    const lineIds = new Set<string>();
    for (let k = 0; k < linesPerArm; k++) {
      const lid = 'L' + lineSeq++;
      lineIds.add(lid);
      lineRefs.set(lid, { id: lid, label: lid, color: '#000' });
    }
    const eid = 'e' + i;
    edges.set(eid, { id: eid, from: 'hub', to: tipId, points: [[0, 0], tip], lineIds });
    adj.get('hub')!.push(eid);
    adj.get(tipId)!.push(eid);
    for (const l of lineIds) stopAt.add(l + '|hub');
  }
  const stopNodes = new Map<string, string>();
  for (const l of lineRefs.keys()) stopNodes.set(l, 'hub');
  const stations = new Map();
  stations.set('G', { id: 'G', label: 'Hub', lngLat: [0, 0], nodeId: 'hub', members: 4, stopNodes });
  return { nodes, edges, adj, lineRefs, lineTraversals: new Map(), stations, stopAt };
}

test('splitHubs: no-op when flag is off (byte-identical)', () => {
  delete process.env.OCTI_SPLIT_HUBS;
  const h = starHub(6);
  const before = h.nodes.size;
  splitHubs(h);
  assert.equal(h.nodes.size, before, 'no new nodes when disabled');
  assert.ok(!h.nodes.get('hub')!.splitGroup, 'no splitGroup tag when disabled');
});

test('splitHubs: splits a high-degree hub into splitGroup leaves with a spine', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  const h = starHub(6); // deg 6 > cap 5
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  // a − leaf was created and tagged
  const minus = [...h.nodes.values()].find((n) => n.id.includes('_sp-'));
  assert.ok(minus, 'a minus leaf exists');
  assert.equal(minus!.splitGroup, 'G', 'leaf carries the station group as splitGroup');
  // the retained hub node is also a split leaf
  assert.equal(h.nodes.get('hub')!.splitGroup, 'G', 'retained node tagged splitGroup');

  // a splitInternal spine edge joins the leaves
  const spine = [...h.edges.values()].find((e) => e.splitInternal && e.id.includes('_spine'));
  assert.ok(spine, 'a splitInternal spine edge exists');

  // station records the leaves for the capsule reunite
  const st = h.stations.get('G')!;
  assert.ok(st.splitNodeIds && st.splitNodeIds.length >= 2, 'station records split leaves');
});

test('splitHubs guard: a split leaf + spine survive combineDeg2 (not collapsed)', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  const h = starHub(6);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  const splitNodesBefore = [...h.nodes.values()].filter((n) => n.splitGroup).map((n) => n.id);
  const spineId = [...h.edges.values()].find((e) => e.id.includes('_spine'))!.id;

  const { hC } = combineDeg2(h);

  // every splitGroup node must still exist after the deg-2 collapse
  for (const id of splitNodesBefore) {
    assert.ok(hC.nodes.has(id), `split node ${id} survived combineDeg2`);
  }
  // the spine edge must still exist (not contracted away)
  assert.ok(hC.edges.has(spineId), 'spine edge survived combineDeg2');
});

test('splitHubs: stop flags re-home to the leaf carrying the line', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  const h = starHub(6);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  // every line that stopped at the hub now stops at one of the split leaves
  const leafIds = new Set([...h.nodes.values()].filter((n) => n.splitGroup).map((n) => n.id));
  for (const key of h.stopAt) {
    const nid = key.slice(key.indexOf('|') + 1);
    assert.ok(leafIds.has(nid), `stop flag ${key} homed to a split leaf`);
  }
});
