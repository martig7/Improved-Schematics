import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupportGraph, SupportEdge, SupportNode, Pixel } from './types';
import { splitHubs } from './splitHubs';
import { combineDeg2 } from './octi';

// Build a star hub: one centre node `hub` with `arms` spokes, each carrying a
// bundle of distinct lines. The hub is a station group `G`. linesPerArm defaults
// to 5 so the hub qualifies under the Phase-1 predicate (directionality >= 3 AND
// maxBundle >= 5): it is both a real fan-out and a big welded trunk.
function starHub(arms: number, linesPerArm = 5): SupportGraph {
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
  const h = starHub(6); // dir 3 >= DIRMIN, maxBundle 5 >= BUNDLEMIN
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

// ---- contiguity invariant -------------------------------------------------
// Per line, the edges that carry it (external arms + the splitInternal spines
// they cross) must form ONE connected component over their {from,to} node
// endpoints. A split that drops a through-line from a spine breaks the line into
// 2+ components — exactly the subway-line-contiguity bug. This is the regression
// the box-count tests never caught.
function brokenLines(h: SupportGraph): string[] {
  const broken: string[] = [];
  for (const lineId of h.lineRefs.keys()) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (a: string, b: string) => {
      parent.set(a, parent.get(a) ?? a);
      parent.set(b, parent.get(b) ?? b);
      parent.set(find(a), find(b));
    };
    let carries = false;
    for (const e of h.edges.values()) {
      if (!e.lineIds.has(lineId)) continue;
      carries = true;
      union(e.from, e.to);
    }
    if (!carries) continue;
    const roots = new Set<string>();
    for (const k of parent.keys()) roots.add(find(k));
    if (roots.size > 1) broken.push(lineId);
  }
  return broken;
}

test('splitHubs contiguity: through-lines stay connected across a RECURSIVE split', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  // 6 arms x 5 lines => ldeg 30 >> LDEG_RECURSE (6), so the hub recurses to a
  // multi-level leaf chain. The depth-1 spine is where the bug manifested.
  const h = starHub(6);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  // sanity: the split actually recursed (more than one spine level)
  const spines = [...h.edges.values()].filter((e) => e.splitInternal && e.id.includes('_spine'));
  assert.ok(spines.length >= 2, `expected a recursive (multi-spine) split, got ${spines.length}`);

  const broken = brokenLines(h);
  assert.deepEqual(broken, [], `no line may break across a split; broken: ${broken.join(',')}`);
});

test('splitHubs contiguity: a planted through-line survives a recursive cut', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  // Build a hub where one line LP threads straight through (two opposite arms),
  // so it must ride every spine it crosses. With dense bundles forcing recursion,
  // LP previously dropped off the depth-1 spine.
  const h = starHub(6, 6);
  // add a dedicated through-line LP on two opposite arms (e0 and e3 are antipodal)
  h.lineRefs.set('LP', { id: 'LP', label: 'LP', color: '#f00' });
  h.edges.get('e0')!.lineIds.add('LP');
  h.edges.get('e3')!.lineIds.add('LP');
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  const broken = brokenLines(h);
  assert.ok(!broken.includes('LP'), `through-line LP must stay contiguous; broken: ${broken.join(',')}`);
  assert.deepEqual(broken, [], `no line may break; broken: ${broken.join(',')}`);
});
